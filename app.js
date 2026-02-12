// ============================================================
// NEWMARK MERRILL | EXPANSION ATLAS v7.1
// Institutional Edition
// ============================================================

// ============================================================
// MAP SETUP
// ============================================================
const map = L.map('map').setView([40.0, -87.0], 6);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: 'abcd', maxZoom: 18
}).addTo(map);

let allMarkers = [];
let heatLayer = null;
let showHeatmap = false;
let currentTab = 'demographic';
let demoData = [];
let twinData = null;
let zoneData = [];
let zoneNameMap = {};
let selectedProperty = 'composite';
let currentSliderMin = 0;

// Track current filtered data for export
let currentFilteredData = [];

// ============================================================
// DATA CLEANING — Fix Census Sentinel Values
// ============================================================
function cleanRecord(d) {
    // Census uses -666666666 as sentinel for missing data
    for (const key of Object.keys(d)) {
        if (d[key] === -666666666 || d[key] === -666666666.0) {
            d[key] = null;
        }
    }
    return d;
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
const TWIN_COLORS = {
    'Hispanic Value': '#DC2626',
    'Urban Core': '#387874',
    'Suburban Power': '#059669',
    'Urban Redevelopment': '#8C6F37'
};
const ALL_STATES = ['IL', 'IN', 'WI', 'MI', 'OH', 'TX'];

function getDemoColor(s) { return s >= 75 ? '#059669' : s >= 60 ? '#D97706' : '#9CA3AF'; }
function getDemoRadius(s) { return s >= 75 ? 11 : s >= 60 ? 9 : 7; }
function getScoreClass(s) { return s >= 75 ? 'score-prime' : s >= 60 ? 'score-strong' : 'score-emerging'; }
function fmtVal(v) { return v != null ? '$' + v.toLocaleString() : '—'; }
function fmtDensity(v) { return v != null && v > 0 ? Math.round(v).toLocaleString() : '—'; }
function fmtPct(v) { return v != null ? Math.round(v) + '%' : '—'; }
function fmtIncome(v) { return v != null ? '$' + (v / 1000).toFixed(0) + 'K' : '—'; }

// Build display name from tract data
function displayName(m) {
    const tract = m.tract_id || m.name?.split(';')[0]?.trim() || '';
    const county = m.county || '';
    // Shorten "Census Tract" to just number
    const short = tract.replace('Census Tract ', '').replace('Tract ', '');
    return { tract: short, county: county, full: `Tract ${short}, ${county}` };
}

// ============================================================
// HEATMAP
// ============================================================
function toggleHeatmap() {
    showHeatmap = !showHeatmap;
    const btn = document.getElementById('heatmap-toggle');
    if (btn) btn.classList.toggle('active', showHeatmap);
    updateHeatLayer();
}

function updateHeatLayer() {
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
    if (!showHeatmap || typeof L.heatLayer === 'undefined') return;
    const points = allMarkers.map(m => {
        const ll = m.getLatLng();
        return [ll.lat, ll.lng, 0.8];
    });
    if (points.length > 0) {
        heatLayer = L.heatLayer(points, {
            radius: 25, blur: 15, maxZoom: 10,
            gradient: { 0.2: '#9CA3AF', 0.5: '#D97706', 0.8: '#059669' }
        }).addTo(map);
    }
}

// ============================================================
// COSINE SIMILARITY ENGINE — 21-Dimension
// ============================================================
const SIM_FEATURES = [
    'pct_hispanic', 'pct_black', 'pct_asian',
    'blue_collar_pct', 'pct_renter', 'pct_singles',
    'med_hh_income', 'med_home_value',
    'pct_vacancy', 'pct_families_with_kids', 'pct_stable',
    'pct_commute_car', 'pct_hs_only', 'pct_bachelors', 'pct_unemployed',
    'pop_density', 'avg_hh_size', 'pct_snap', 'pct_poverty',
    'daytime_ratio', 'traffic_intensity'
];

let featureNorms = {};

function computeFeatureNorms(allTracts) {
    SIM_FEATURES.forEach(f => {
        const vals = allTracts.map(d => d[f]).filter(v => v != null && !isNaN(v) && isFinite(v));
        if (vals.length === 0) { featureNorms[f] = { mean: 0, std: 1 }; return; }
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const std = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) || 1;
        featureNorms[f] = { mean, std };
    });
}

function normalizeVector(tract) {
    return SIM_FEATURES.map(f => {
        let v = tract[f];
        if ((v == null || isNaN(v)) && f === 'pop_density') v = tract['avg_pop_density'];
        if (v == null || isNaN(v) || !isFinite(v)) return 0;
        const n = featureNorms[f];
        return (v - n.mean) / n.std;
    });
}

function cosineSimilarity(vecA, vecB) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        magA += vecA[i] ** 2;
        magB += vecB[i] ** 2;
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    if (magA === 0 || magB === 0) return 0;
    return dot / (magA * magB);
}

// ============================================================
// BENCHMARK PROFILES + Z-SCORE
// ============================================================
const ZSCORE_FEATURES = [
    { key: 'pct_hispanic', label: 'Hispanic', pct: true },
    { key: 'med_hh_income', label: 'Income', pct: false },
    { key: 'blue_collar_pct', label: 'Blue Col', pct: true },
    { key: 'pct_renter', label: 'Renter', pct: true },
    { key: 'pop_density', label: 'Density', pct: false },
    { key: 'avg_hh_size', label: 'HH Size', pct: false },
    { key: 'pct_snap', label: 'SNAP', pct: true },
    { key: 'pct_families_with_kids', label: 'Families', pct: true },
];

let benchmarkProfiles = {};
let benchmarkVectors = {};

function computeBenchmarkProfiles(twins, benchmarks) {
    benchmarks.forEach(b => {
        const profile = {};
        SIM_FEATURES.forEach(f => {
            if (b[f] != null) {
                profile[f] = b[f];
            } else {
                const matched = twins.filter(t => t.matched_property === b.name);
                const vals = matched.map(t => t[f]).filter(v => v != null && !isNaN(v));
                profile[f] = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : 0;
            }
        });
        benchmarkProfiles[b.name] = profile;
    });
}

function computeBenchmarkVectors() {
    Object.keys(benchmarkProfiles).forEach(name => {
        benchmarkVectors[name] = normalizeVector(benchmarkProfiles[name]);
    });
}

function reindexDemoData(propertyName) {
    if (propertyName === 'composite' || !benchmarkVectors[propertyName]) return demoData;
    const benchVec = benchmarkVectors[propertyName];
    return demoData.map(d => {
        const tractVec = normalizeVector(d);
        const sim = cosineSimilarity(tractVec, benchVec);
        const score = Math.round(Math.max(0, Math.min(100, sim * 100)) * 10) / 10;
        return { ...d, _indexed_score: score };
    }).sort((a, b) => b._indexed_score - a._indexed_score);
}

function reindexZoneData(propertyName) {
    if (propertyName === 'composite' || !benchmarkVectors[propertyName]) return zoneData;
    const benchVec = benchmarkVectors[propertyName];
    return zoneData.map(z => {
        const zoneVec = normalizeVector(z);
        const sim = cosineSimilarity(zoneVec, benchVec);
        const score = Math.round(Math.max(0, Math.min(100, sim * 100)) * 10) / 10;
        return { ...z, _indexed_score: score };
    }).sort((a, b) => b._indexed_score - a._indexed_score);
}

function getDisplayScore(item) {
    if (selectedProperty !== 'composite' && item._indexed_score != null) return item._indexed_score;
    return item.match_score || item.avg_score || item.twin_score || 0;
}

function computeZScores(tract, benchmarkName) {
    const profile = benchmarkProfiles[benchmarkName];
    if (!profile) return [];
    return ZSCORE_FEATURES.map(f => {
        const tractVal = tract[f.key] || 0;
        const benchVal = profile[f.key] || 0;
        const norm = featureNorms[f.key];
        const std = norm ? norm.std : 1;
        const zScore = (tractVal - benchVal) / std;
        return { label: f.label, zScore: Math.round(zScore * 100) / 100, key: f.key };
    });
}

function buildZScoreHTML(tract, benchmarkName) {
    if (!benchmarkName || benchmarkName === 'composite') return '';
    const scores = computeZScores(tract, benchmarkName);
    if (scores.length === 0) return '';
    const benchShort = benchmarkName.split('(')[0].trim();
    let html = `<div class="zscore-section"><div class="zscore-title">Z-Score vs ${benchShort}</div>`;
    scores.forEach(s => {
        const clampedZ = Math.max(-3, Math.min(3, s.zScore));
        const widthPct = Math.abs(clampedZ) / 3 * 50;
        const barClass = clampedZ >= 0 ? 'positive' : 'negative';
        const valColor = Math.abs(s.zScore) < 0.5 ? 'var(--nmc-teal)' : Math.abs(s.zScore) < 1.5 ? 'var(--nmc-amber)' : 'var(--nmc-red)';
        html += `<div class="zscore-row">
            <span class="zscore-label">${s.label}</span>
            <div class="zscore-bar-wrap"><div class="zscore-bar-center"></div><div class="zscore-bar ${barClass}" style="width:${widthPct}%"></div></div>
            <span class="zscore-val" style="color:${valColor}">${s.zScore > 0 ? '+' : ''}${s.zScore.toFixed(1)}</span>
        </div>`;
    });
    html += '</div>';
    return html;
}

// ============================================================
// METRICS HELPERS
// ============================================================
function buildMetricsHTML(m) {
    let rows = '';
    rows += `<div class="metric-cell"><div class="metric-val">${fmtPct(m.pct_hispanic)}</div><div class="metric-key">Hispanic</div></div>`;
    rows += `<div class="metric-cell"><div class="metric-val">${fmtIncome(m.med_hh_income)}</div><div class="metric-key">Income</div></div>`;
    rows += `<div class="metric-cell"><div class="metric-val">${fmtDensity(m.pop_density)}</div><div class="metric-key">Pop/Mi²</div></div>`;
    rows += `<div class="metric-cell"><div class="metric-val">${fmtPct(m.pct_renter)}</div><div class="metric-key">Renter</div></div>`;
    rows += `<div class="metric-cell"><div class="metric-val">${fmtPct(m.pct_snap)}</div><div class="metric-key">SNAP</div></div>`;
    rows += `<div class="metric-cell"><div class="metric-val">${m.avg_hh_size != null ? (typeof m.avg_hh_size === 'number' ? m.avg_hh_size.toFixed(1) : m.avg_hh_size) : '—'}</div><div class="metric-key">HH Size</div></div>`;
    rows += `<div class="metric-cell"><div class="metric-val">${fmtPct(m.blue_collar_pct)}</div><div class="metric-key">Blue Col</div></div>`;
    rows += `<div class="metric-cell"><div class="metric-val">${fmtPct(m.pct_commute_car)}</div><div class="metric-key">Drive</div></div>`;
    return rows;
}

function buildPopupGrid(m) {
    let g = '';
    g += `<div class="popup-stat"><div class="popup-stat-val">${fmtPct(m.pct_hispanic)}</div><div class="popup-stat-key">Hispanic</div></div>`;
    g += `<div class="popup-stat"><div class="popup-stat-val">${m.med_hh_income ? '$' + m.med_hh_income.toLocaleString() : '—'}</div><div class="popup-stat-key">Med Income</div></div>`;
    g += `<div class="popup-stat"><div class="popup-stat-val">${fmtDensity(m.pop_density)}</div><div class="popup-stat-key">Pop/Mi²</div></div>`;
    g += `<div class="popup-stat"><div class="popup-stat-val">${fmtPct(m.pct_renter)}</div><div class="popup-stat-key">Renter</div></div>`;
    g += `<div class="popup-stat"><div class="popup-stat-val">${fmtPct(m.pct_snap)}</div><div class="popup-stat-key">SNAP</div></div>`;
    g += `<div class="popup-stat"><div class="popup-stat-val">${m.avg_hh_size != null ? (typeof m.avg_hh_size === 'number' ? m.avg_hh_size.toFixed(1) : m.avg_hh_size) : '—'}</div><div class="popup-stat-key">HH Size</div></div>`;
    return g;
}

function buildSliderHTML(data, scoreKey) {
    const scores = data.map(d => getDisplayScore(d)).filter(s => s > 0);
    const min = scores.length ? Math.floor(Math.min(...scores)) : 0;
    const max = scores.length ? Math.ceil(Math.max(...scores)) : 100;
    const sliderVal = currentSliderMin || min;
    return `<div class="slider-wrap">
        <span class="slider-label">Min Score</span>
        <input type="range" id="score-slider" min="${min}" max="${max}" value="${sliderVal}" step="1">
        <span class="slider-value" id="slider-val">${sliderVal}</span>
        <span class="slider-count" id="slider-count">${scores.filter(s => s >= sliderVal).length} shown</span>
    </div>`;
}

// Zone context tag (only show if zone_name exists and differs from county)
function buildZoneTag(m) {
    const zn = m.zone_name || zoneNameMap[m.cluster_id] || '';
    if (!zn) return '';
    return `<div style="padding:2px 0;font-size:10px;color:var(--nmc-secondary)">📍 ${zn}</div>`;
}

// ============================================================
// DEMOGRAPHIC TAB
// ============================================================
function getIndexedDemoData() {
    return reindexDemoData(selectedProperty);
}

function renderDemoFilters() {
    const f = document.getElementById('filters');
    const indexed = getIndexedDemoData();
    const states = [...new Set(indexed.map(d => d.state))].sort();
    let html = `<button class="filter-btn active" data-filter="all">All (${indexed.length})</button>`;
    states.forEach(s => {
        const c = indexed.filter(d => d.state === s).length;
        html += `<button class="filter-btn" data-filter="${s}">${s} (${c})</button>`;
    });
    html += buildSliderHTML(indexed, 'match_score');
    f.innerHTML = html;

    f.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
        f.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyDemoFilters();
    }));

    const slider = document.getElementById('score-slider');
    if (slider) slider.addEventListener('input', () => {
        document.getElementById('slider-val').textContent = slider.value;
        currentSliderMin = parseInt(slider.value);
        applyDemoFilters();
    });
}

function applyDemoFilters() {
    const activeBtn = document.querySelector('#filters .filter-btn.active');
    const fl = activeBtn ? activeBtn.dataset.filter : 'all';
    let d = getIndexedDemoData();
    if (fl !== 'all') d = d.filter(x => x.state === fl);
    d = d.filter(x => getDisplayScore(x) >= currentSliderMin);
    const countEl = document.getElementById('slider-count');
    if (countEl) countEl.textContent = d.length + ' shown';
    currentFilteredData = d;
    renderDemoMarkets(d);
}

function renderDemoMarkets(data) {
    const list = document.getElementById('market-list'); list.innerHTML = '';
    allMarkers.forEach(m => map.removeLayer(m)); allMarkers = [];

    const isIndexed = selectedProperty !== 'composite';

    document.getElementById('total-count').textContent = data.length;
    document.getElementById('prime-count').textContent = data.filter(d => getDisplayScore(d) >= 75).length;
    document.getElementById('avg-score').textContent = data.length ? Math.round(data.reduce((a, d) => a + getDisplayScore(d), 0) / data.length) : '—';
    document.getElementById('states-count').textContent = [...new Set(data.map(d => d.state))].length;
    document.querySelector('#stats-bar .stat-cell:nth-child(1) .stat-label').textContent = 'Tracts';
    document.querySelector('#stats-bar .stat-cell:nth-child(2) .stat-label').textContent = 'Prime';

    data.forEach(m => {
        const score = getDisplayScore(m);
        const color = getDemoColor(score);
        const dn = displayName(m);
        const circle = L.circleMarker([m.lat, m.lng], {
            radius: getDemoRadius(score), color: 'white',
            weight: 2, fillColor: color, fillOpacity: 0.85
        }).addTo(map);

        const zscore = buildZScoreHTML(m, selectedProperty);
        circle.bindPopup(`<div class="popup-head"><span class="popup-head-name">${dn.full}, ${m.state}</span><span class="popup-head-score">${score.toFixed ? score.toFixed(1) : score}</span></div><div class="popup-body"><div class="popup-grid">${buildPopupGrid(m)}</div>${zscore}${m.summary ? `<div class="popup-summary">${m.summary}</div>` : ''}${m.anchors ? `<div class="popup-anchors">Anchors: ${m.anchors}</div>` : ''}</div>`, { maxWidth: 300, closeButton: true });
        allMarkers.push(circle);

        const tierText = score >= 75 ? 'PRIME TARGET' : score >= 60 ? 'STRONG' : 'EMERGING';
        const tc = score >= 75 ? 'prime' : score >= 60 ? 'strong' : 'emerging';
        const card = document.createElement('div'); card.className = 'market-card';
        card.innerHTML = `
            <span class="tier-label tier-${tc}">${tierText}</span>
            <div class="card-top">
                <div>
                    <div class="card-name">${dn.full}</div>
                    <div class="card-location">${m.state} · Pop ${m.population ? m.population.toLocaleString() : '—'}</div>
                </div>
                <span class="score-badge ${getScoreClass(score)}">${score.toFixed ? score.toFixed(1) : score}</span>
            </div>
            <div class="card-metrics">${buildMetricsHTML(m)}</div>
            ${buildZoneTag(m)}
            <div class="card-summary">${m.summary || ''}</div>
            ${m.anchors ? `<div class="card-anchors">🏪 ${m.anchors}</div>` : ''}`;

        card.addEventListener('click', () => {
            document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            map.flyTo([m.lat, m.lng], 12, { duration: 0.8 });
            circle.openPopup();
        });
        circle.on('click', () => {
            document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        list.appendChild(card);
    });
    if (data.length > 0) map.fitBounds(L.latLngBounds(data.map(d => [d.lat, d.lng])).pad(0.15));
    updateHeatLayer();
}

function renderDemoLegend() {
    document.getElementById('map-legend').innerHTML = `
        <div class="legend-title">Match Score</div>
        <div class="legend-item"><div class="legend-dot" style="background:#059669"></div> Prime (75+)</div>
        <div class="legend-item"><div class="legend-dot" style="background:#D97706"></div> Strong (60–75)</div>
        <div class="legend-item"><div class="legend-dot" style="background:#9CA3AF"></div> Emerging (&lt;60)</div>`;
}

function renderDemoComparison() {
    if (selectedProperty !== 'composite' && benchmarkProfiles[selectedProperty]) {
        const bp = benchmarkProfiles[selectedProperty];
        document.getElementById('comparison-panel').innerHTML = `
            <div class="ca-title">Benchmark: ${selectedProperty.split('(')[0].trim()}</div>
            <div class="ca-row"><span>Hispanic</span><span>${fmtPct(bp.pct_hispanic)}</span></div>
            <div class="ca-row"><span>Income</span><span>${fmtIncome(bp.med_hh_income)}</span></div>
            <div class="ca-row"><span>Pop Density</span><span>${fmtDensity(bp.pop_density)}</span></div>
            <div class="ca-row"><span>Renter</span><span>${fmtPct(bp.pct_renter)}</span></div>
            <div class="ca-row"><span>Blue Collar</span><span>${fmtPct(bp.blue_collar_pct)}</span></div>`;
    } else {
        document.getElementById('comparison-panel').innerHTML = `
            <div class="ca-title">CA Portfolio Benchmark</div>
            <div class="ca-row"><span>Avg Hispanic</span><span>45–60%</span></div>
            <div class="ca-row"><span>Med HH Income</span><span>$55–75K</span></div>
            <div class="ca-row"><span>Blue Collar</span><span>12–18%</span></div>
            <div class="ca-row"><span>Renter %</span><span>55–70%</span></div>
            <div class="ca-row"><span>Home Value</span><span>$165–425K</span></div>`;
    }
}

// ============================================================
// PROPERTY TWINS TAB
// ============================================================
function renderTwinFilters(data) {
    const f = document.getElementById('filters');
    const types = [...new Set(data.twins.map(t => t.property_type))];
    let html = `<button class="filter-btn active" data-filter="all">All</button>`;
    types.forEach(t => html += `<button class="filter-btn" data-filter="type:${t}">${t}</button>`);
    const twinStates = [...new Set(data.twins.map(t => t.state))].sort();
    twinStates.forEach(s => html += `<button class="filter-btn" data-filter="state:${s}">${s}</button>`);
    html += buildSliderHTML(data.twins, 'twin_score');
    f.innerHTML = html;

    f.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
        f.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyTwinFilters(data);
    }));

    const slider = document.getElementById('score-slider');
    if (slider) slider.addEventListener('input', () => {
        document.getElementById('slider-val').textContent = slider.value;
        currentSliderMin = parseInt(slider.value);
        applyTwinFilters(data);
    });
}

function applyTwinFilters(data) {
    const activeBtn = document.querySelector('#filters .filter-btn.active');
    const fl = activeBtn ? activeBtn.dataset.filter : 'all';
    let d = data.twins;
    if (fl !== 'all') {
        if (fl.startsWith('type:')) d = d.filter(t => t.property_type === fl.slice(5));
        else if (fl.startsWith('state:')) d = d.filter(t => t.state === fl.slice(6));
    }
    if (selectedProperty !== 'composite') {
        d = d.filter(t => t.matched_property === selectedProperty);
    }
    d = d.filter(t => getDisplayScore(t) >= currentSliderMin);
    const countEl = document.getElementById('slider-count');
    if (countEl) countEl.textContent = d.length + ' shown';
    currentFilteredData = d;
    renderTwinMarkets(d, data.benchmarks);
}

function renderTwinMarkets(twins, benchmarks) {
    const list = document.getElementById('market-list'); list.innerHTML = '';
    allMarkers.forEach(m => map.removeLayer(m)); allMarkers = [];

    document.getElementById('total-count').textContent = twins.length;
    document.getElementById('prime-count').textContent = [...new Set(twins.map(t => t.matched_property))].length;
    document.getElementById('avg-score').textContent = twins.length ? Math.round(twins.reduce((a, d) => a + getDisplayScore(d), 0) / twins.length) : '—';
    document.getElementById('states-count').textContent = [...new Set(twins.map(d => d.state))].length;
    document.querySelector('#stats-bar .stat-cell:nth-child(1) .stat-label').textContent = 'Tracts';
    document.querySelector('#stats-bar .stat-cell:nth-child(2) .stat-label').textContent = 'Properties';

    twins.forEach(t => {
        const twinScore = getDisplayScore(t);
        const color = TWIN_COLORS[t.property_type] || '#9CA3AF';
        const dn = displayName(t);
        const circle = L.circleMarker([t.lat, t.lng], {
            radius: getDemoRadius(twinScore), color: 'white',
            weight: 2, fillColor: color, fillOpacity: 0.85
        }).addTo(map);

        const zscore = buildZScoreHTML(t, t.matched_property);
        circle.bindPopup(`<div class="popup-head" style="background:${color}"><span class="popup-head-name">${dn.full}, ${t.state}</span><span class="popup-head-score">${twinScore}%</span></div><div class="popup-body"><div class="popup-match-label" style="border-left:3px solid ${color}">Twin of: <strong>${t.matched_property}</strong></div><div class="popup-grid">${buildPopupGrid(t)}</div>${zscore}</div>`, { maxWidth: 300, closeButton: true });
        allMarkers.push(circle);

        let top3HTML = '';
        if (t.twin_matches && t.twin_matches.length > 1) {
            const others = t.twin_matches.slice(1, 3).map(m => `${m.property.split('(')[0].trim()} ${m.score}%`).join(' · ');
            top3HTML = `<div style="padding:2px 0;font-size:9px;color:var(--nmc-secondary)">Also: ${others}</div>`;
        }

        const card = document.createElement('div'); card.className = 'market-card';
        card.innerHTML = `
            <div class="twin-match-badge" style="background:${color}10;color:${color}">
                <div class="twin-dot" style="background:${color}"></div>
                ${t.matched_property} · ${t.property_type}
            </div>
            <div class="card-top">
                <div>
                    <div class="card-name">${dn.full}</div>
                    <div class="card-location">${t.state} · Pop ${t.population ? t.population.toLocaleString() : '—'}</div>
                </div>
                <span class="score-badge ${getScoreClass(twinScore)}">${twinScore}%</span>
            </div>
            <div class="card-metrics">${buildMetricsHTML(t)}</div>
            ${top3HTML}`;

        card.addEventListener('click', () => {
            document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            map.flyTo([t.lat, t.lng], 12, { duration: 0.8 });
            circle.openPopup();
        });
        circle.on('click', () => {
            document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        list.appendChild(card);
    });
    if (twins.length > 0) map.fitBounds(L.latLngBounds(twins.map(d => [d.lat, d.lng])).pad(0.15));
    updateHeatLayer();
}

function renderTwinLegend() {
    document.getElementById('map-legend').innerHTML = `<div class="legend-title">Property Type</div>${Object.entries(TWIN_COLORS).map(([k, v]) => `<div class="legend-item"><div class="legend-dot" style="background:${v}"></div>${k}</div>`).join('')}`;
}

function renderTwinComparison(benchmarks) {
    if (!benchmarks || !benchmarks.length) { document.getElementById('comparison-panel').innerHTML = ''; return; }
    if (selectedProperty !== 'composite' && benchmarkProfiles[selectedProperty]) {
        const bp = benchmarkProfiles[selectedProperty];
        document.getElementById('comparison-panel').innerHTML = `
            <div class="ca-title">${selectedProperty.split('(')[0].trim()}</div>
            <div class="ca-row"><span>Hispanic</span><span>${fmtPct(bp.pct_hispanic)}</span></div>
            <div class="ca-row"><span>Income</span><span>${fmtIncome(bp.med_hh_income)}</span></div>
            <div class="ca-row"><span>Pop Density</span><span>${fmtDensity(bp.pop_density)}</span></div>
            <div class="ca-row"><span>Algorithm</span><span>Cosine Sim</span></div>`;
    } else {
        const hv = benchmarks.filter(b => b.type === 'Hispanic Value');
        const avgH = hv.length ? Math.round(hv.reduce((a, b) => a + b.pct_hispanic, 0) / hv.length) : 0;
        const avgI = hv.length ? Math.round(hv.reduce((a, b) => a + b.med_hh_income, 0) / hv.length / 1000) : 0;
        document.getElementById('comparison-panel').innerHTML = `
            <div class="ca-title">NMM Portfolio DNA</div>
            <div class="ca-row"><span>Benchmarks</span><span>${benchmarks.length}</span></div>
            <div class="ca-row"><span>Hispanic Value Avg</span><span>${avgH}%</span></div>
            <div class="ca-row"><span>Avg Income (HV)</span><span>$${avgI}K</span></div>
            <div class="ca-row"><span>Features</span><span>21-dim</span></div>
            <div class="ca-row"><span>Algorithm</span><span>Cosine Sim</span></div>`;
    }
}

// ============================================================
// HOT ZONES TAB
// ============================================================
const ZONE_COLORS = { 'MEGA ZONE': '#DC2626', 'LARGE ZONE': '#C2410C', 'MEDIUM ZONE': '#059669', 'MICRO ZONE': '#387874', 'SOLO ZONE': '#9CA3AF' };
const ZONE_CSS = { 'MEGA ZONE': 'zone-mega', 'LARGE ZONE': 'zone-large', 'MEDIUM ZONE': 'zone-medium', 'MICRO ZONE': 'zone-micro', 'SOLO ZONE': 'zone-solo' };

let zoneThreshHigh = 50, zoneThreshMid = 40;
let zonePageSize = 25;
let zoneCurrentPage = 0;
let filteredZoneData = [];

function computeZoneThresholds(data) {
    const scores = data.map(d => getDisplayScore(d)).sort((a, b) => a - b);
    if (scores.length < 3) { zoneThreshHigh = 50; zoneThreshMid = 35; return; }
    zoneThreshHigh = scores[Math.floor(scores.length * 0.67)];
    zoneThreshMid = scores[Math.floor(scores.length * 0.33)];
}
function getZoneColor(s) { return s >= zoneThreshHigh ? '#059669' : s >= zoneThreshMid ? '#D97706' : '#9CA3AF'; }
function getZoneRadius(score) { return Math.max(6, Math.min(16, Math.round(6 + (score / 100) * 10))); }

function getIndexedZoneData() { return reindexZoneData(selectedProperty); }

function buildZoneMetrics(z) {
    let r = '';
    r += `<div class="metric-cell"><div class="metric-val">${fmtPct(z.pct_hispanic)}</div><div class="metric-key">Hispanic</div></div>`;
    r += `<div class="metric-cell"><div class="metric-val">${fmtIncome(z.med_hh_income)}</div><div class="metric-key">Income</div></div>`;
    r += `<div class="metric-cell"><div class="metric-val">${fmtDensity(z.avg_pop_density || z.pop_density)}</div><div class="metric-key">Pop/Mi²</div></div>`;
    r += `<div class="metric-cell"><div class="metric-val">${fmtPct(z.pct_renter)}</div><div class="metric-key">Renter</div></div>`;
    r += `<div class="metric-cell"><div class="metric-val">${fmtPct(z.pct_snap)}</div><div class="metric-key">SNAP</div></div>`;
    r += `<div class="metric-cell"><div class="metric-val">${z.avg_hh_size != null ? (typeof z.avg_hh_size === 'number' ? z.avg_hh_size.toFixed(1) : z.avg_hh_size) : '—'}</div><div class="metric-key">HH Size</div></div>`;
    r += `<div class="metric-cell"><div class="metric-val">${fmtPct(z.blue_collar_pct)}</div><div class="metric-key">Blue Col</div></div>`;
    r += `<div class="metric-cell"><div class="metric-val">${fmtPct(z.pct_commute_car)}</div><div class="metric-key">Drive</div></div>`;
    return r;
}

function renderZoneFilters() {
    const f = document.getElementById('filters');
    const indexed = getIndexedZoneData();
    const states = [...new Set(indexed.map(z => z.state))].sort();
    let html = `<button class="filter-btn active" data-filter="all">All (${indexed.length})</button>`;
    states.forEach(s => { const c = indexed.filter(z => z.state === s).length; html += `<button class="filter-btn" data-filter="state:${s}">${s} (${c})</button>`; });
    html += `<div style="margin-top:6px;width:100%"><input type="text" id="zone-search" placeholder="Search zones by name…" style="width:100%;padding:7px 10px;border:1px solid var(--nmc-border);border-radius:5px;font-size:12px;font-family:'DM Sans',sans-serif"></div>`;
    html += buildSliderHTML(indexed, 'avg_score');
    f.innerHTML = html;

    f.querySelectorAll('.filter-btn').forEach(btn => btn.addEventListener('click', () => {
        f.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        applyZoneFilters();
    }));
    const searchEl = document.getElementById('zone-search');
    if (searchEl) searchEl.addEventListener('input', () => applyZoneFilters());
    const slider = document.getElementById('score-slider');
    if (slider) slider.addEventListener('input', () => {
        document.getElementById('slider-val').textContent = slider.value;
        currentSliderMin = parseInt(slider.value);
        applyZoneFilters();
    });
}

function applyZoneFilters() {
    const activeFilter = document.querySelector('#filters .filter-btn.active');
    const searchInput = document.getElementById('zone-search');
    const fl = activeFilter ? activeFilter.dataset.filter : 'all';
    const searchTerm = searchInput ? searchInput.value.toLowerCase().trim() : '';
    let d = getIndexedZoneData();
    if (fl !== 'all') {
        if (fl.startsWith('state:')) d = d.filter(z => z.state === fl.slice(6));
        else d = d.filter(z => z.size_class === fl);
    }
    if (searchTerm) d = d.filter(z => z.zone_name.toLowerCase().includes(searchTerm) || (z.tracts && z.tracts.some(t => t.toLowerCase().includes(searchTerm))));
    d = d.filter(z => getDisplayScore(z) >= currentSliderMin);
    const countEl = document.getElementById('slider-count');
    if (countEl) countEl.textContent = d.length + ' shown';
    zoneCurrentPage = 0;
    filteredZoneData = d;
    currentFilteredData = d;
    renderZoneMarkets(d);
}

function renderZoneMarkets(data) {
    const list = document.getElementById('market-list'); list.innerHTML = '';
    allMarkers.forEach(m => map.removeLayer(m)); allMarkers = [];

    document.getElementById('total-count').textContent = data.length;
    document.getElementById('prime-count').textContent = data.reduce((a, z) => a + z.tract_count, 0);
    document.getElementById('avg-score').textContent = data.length ? Math.round(data.reduce((a, z) => a + getDisplayScore(z), 0) / data.length) : '—';
    document.getElementById('states-count').textContent = [...new Set(data.map(z => z.state))].length;
    document.querySelector('#stats-bar .stat-cell:nth-child(1) .stat-label').textContent = 'Zones';
    document.querySelector('#stats-bar .stat-cell:nth-child(2) .stat-label').textContent = 'Tracts';

    computeZoneThresholds(data);
    renderZoneLegend();

    data.forEach(z => {
        const score = getDisplayScore(z);
        const color = getZoneColor(score);
        const radius = getZoneRadius(score);
        const circle = L.circleMarker([z.lat, z.lng], {
            radius, color: 'white', weight: 2, fillColor: color, fillOpacity: 0.85
        }).addTo(map);

        const zscore = buildZScoreHTML(z, selectedProperty);
        circle.bindPopup(`<div class="popup-head" style="background:${color}"><span class="popup-head-name">${z.zone_name}</span><span class="popup-head-score">${score}</span></div><div class="popup-body"><div class="popup-match-label"><strong>${z.tract_count} tracts</strong> · ${z.total_pop.toLocaleString()} pop · ${z.size_class}</div><div class="popup-grid"><div class="popup-stat"><div class="popup-stat-val">${fmtPct(z.pct_hispanic)}</div><div class="popup-stat-key">Hispanic</div></div><div class="popup-stat"><div class="popup-stat-val">${z.med_hh_income ? '$' + z.med_hh_income.toLocaleString() : '—'}</div><div class="popup-stat-key">Income</div></div><div class="popup-stat"><div class="popup-stat-val">${fmtDensity(z.avg_pop_density || z.pop_density)}</div><div class="popup-stat-key">Pop/Mi²</div></div><div class="popup-stat"><div class="popup-stat-val">${fmtPct(z.pct_renter)}</div><div class="popup-stat-key">Renter</div></div></div>${zscore}${z.summary ? `<div class="popup-summary">${z.summary}</div>` : ''}${z.anchors ? `<div class="popup-anchors">Anchors: ${z.anchors}</div>` : ''}</div>`, { maxWidth: 300, closeButton: true });
        allMarkers.push(circle);
    });

    // Paginated cards
    const start = zoneCurrentPage * zonePageSize;
    const pageData = data.slice(start, start + zonePageSize);

    pageData.forEach((z, idx) => {
        const score = getDisplayScore(z);
        const card = document.createElement('div'); card.className = 'market-card';
        const szCss = ZONE_CSS[z.size_class] || 'zone-solo';
        const tractPills = z.tracts ? z.tracts.slice(0, 5).map(t => `<span class="zone-tract-pill">${t}</span>`).join('') + (z.tracts.length > 5 ? `<span class="zone-tract-pill" style="opacity:0.5">+${z.tracts.length - 5}</span>` : '') : '';

        card.innerHTML = `
            <span class="zone-size-badge ${szCss}">${z.size_class}</span>
            <div class="card-top">
                <div>
                    <div class="card-name">${z.zone_name} <small style="color:var(--nmc-secondary);font-weight:400">#${start + idx + 1}</small></div>
                    <div class="card-location"><span class="zone-pop-label">${z.total_pop.toLocaleString()} pop</span> · ${z.tract_count} tract${z.tract_count > 1 ? 's' : ''} · ${z.state}</div>
                </div>
                <span class="score-badge ${score >= zoneThreshHigh ? 'score-prime' : score >= zoneThreshMid ? 'score-strong' : 'score-emerging'}">${score}</span>
            </div>
            <div class="card-metrics">${buildZoneMetrics(z)}</div>
            <div class="card-summary">${z.summary || ''}</div>
            <div class="zone-tracts">${tractPills}</div>
            ${z.anchors ? `<div class="card-anchors">🏪 ${z.anchors}</div>` : ''}`;

        const markerIdx = start + idx;
        card.addEventListener('click', () => {
            document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            map.flyTo([z.lat, z.lng], 12, { duration: 0.8 });
            if (allMarkers[markerIdx]) allMarkers[markerIdx].openPopup();
        });
        list.appendChild(card);
    });

    // Pagination
    const totalPages = Math.ceil(data.length / zonePageSize);
    if (totalPages > 1) {
        const pageNav = document.createElement('div');
        pageNav.style.cssText = 'display:flex;gap:8px;justify-content:center;align-items:center;padding:14px;';
        if (zoneCurrentPage > 0) {
            const prev = document.createElement('button'); prev.className = 'filter-btn'; prev.textContent = '← Prev';
            prev.addEventListener('click', () => { zoneCurrentPage--; renderZoneMarkets(data); });
            pageNav.appendChild(prev);
        }
        const info = document.createElement('span');
        info.style.cssText = 'font-size:12px;color:var(--nmc-secondary)';
        info.textContent = `${zoneCurrentPage + 1} / ${totalPages} (${data.length} zones)`;
        pageNav.appendChild(info);
        if (zoneCurrentPage < totalPages - 1) {
            const next = document.createElement('button'); next.className = 'filter-btn'; next.textContent = 'Next →';
            next.addEventListener('click', () => { zoneCurrentPage++; renderZoneMarkets(data); });
            pageNav.appendChild(next);
        }
        list.appendChild(pageNav);
    }

    if (data.length > 0) map.fitBounds(L.latLngBounds(data.map(z => [z.lat, z.lng])).pad(0.2));
    updateHeatLayer();
}

function renderZoneLegend() {
    const h = Math.round(zoneThreshHigh * 10) / 10;
    const m = Math.round(zoneThreshMid * 10) / 10;
    document.getElementById('map-legend').innerHTML = `
        <div class="legend-title">Zone Score</div>
        <div class="legend-item"><div class="legend-dot" style="background:#059669"></div> Prime (${h}+)</div>
        <div class="legend-item"><div class="legend-dot" style="background:#D97706"></div> Strong (${m}–${h})</div>
        <div class="legend-item"><div class="legend-dot" style="background:#9CA3AF"></div> Emerging (&lt;${m})</div>`;
}

function renderZoneComparison() {
    if (selectedProperty !== 'composite' && benchmarkProfiles[selectedProperty]) {
        const bp = benchmarkProfiles[selectedProperty];
        document.getElementById('comparison-panel').innerHTML = `
            <div class="ca-title">Indexed to: ${selectedProperty.split('(')[0].trim()}</div>
            <div class="ca-row"><span>Hispanic</span><span>${fmtPct(bp.pct_hispanic)}</span></div>
            <div class="ca-row"><span>Income</span><span>${fmtIncome(bp.med_hh_income)}</span></div>
            <div class="ca-row"><span>Density</span><span>${fmtDensity(bp.pop_density)}</span></div>
            <div class="ca-row"><span>Algorithm</span><span>DBSCAN</span></div>`;
    } else {
        const totalPop = zoneData.reduce((a, z) => a + z.total_pop, 0);
        const totalTracts = zoneData.reduce((a, z) => a + z.tract_count, 0);
        const clusters = zoneData.filter(z => z.tract_count > 1).length;
        document.getElementById('comparison-panel').innerHTML = `
            <div class="ca-title">DBSCAN Cluster Survey</div>
            <div class="ca-row"><span>Clusters</span><span>${clusters}</span></div>
            <div class="ca-row"><span>Solo Zones</span><span>${zoneData.filter(z => z.tract_count === 1).length}</span></div>
            <div class="ca-row"><span>Total Pop</span><span>${totalPop.toLocaleString()}</span></div>
            <div class="ca-row"><span>Total Tracts</span><span>${totalTracts}</span></div>`;
    }
}

// ============================================================
// TAB SWITCHING
// ============================================================
function switchTab(tab) {
    currentTab = tab;
    currentSliderMin = 0;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const ds = document.getElementById('data-source-label');
    document.querySelector('#stats-bar .stat-cell:nth-child(1) .stat-label').textContent = 'Targets';
    document.querySelector('#stats-bar .stat-cell:nth-child(2) .stat-label').textContent = 'Prime';

    document.getElementById('property-selector-wrap').style.display = 'block';
    const selectorLabel = document.querySelector('#property-selector-wrap label');
    const compositeOpt = document.querySelector('#property-selector option[value="composite"]');

    if (tab === 'twins') {
        selectorLabel.textContent = 'Filter by Property';
        compositeOpt.textContent = 'All Properties (Show All Twins)';
    } else if (tab === 'hotzones') {
        selectorLabel.textContent = 'Index Zones to Property';
        compositeOpt.textContent = 'All Properties (Composite Index)';
    } else {
        selectorLabel.textContent = 'Index Tracts to Property';
        compositeOpt.textContent = 'All Properties (Composite Index)';
    }

    if (tab === 'demographic') {
        ds.innerHTML = '<strong>Data:</strong> ACS 5-Year (2023) · 31 Variables · <strong>Coverage:</strong> IL, IN, WI, MI, OH, DFW-TX';
        renderDemoFilters(); renderDemoLegend(); renderDemoComparison(); applyDemoFilters();
    } else if (tab === 'twins') {
        ds.innerHTML = '<strong>Data:</strong> ACS 5-Year (2023) · <strong>Method:</strong> 21-Dim Cosine Similarity vs 9 NMM Benchmarks';
        if (twinData && twinData.twins.length > 0) {
            renderTwinFilters(twinData); renderTwinLegend(); renderTwinComparison(twinData.benchmarks);
            applyTwinFilters(twinData);
        } else {
            document.getElementById('filters').innerHTML = '';
            document.getElementById('market-list').innerHTML = '<div class="empty-state"><h3>Property Twin Analysis</h3><p>Run the Python script to generate data:<br><code>python fetch_expansion_targets.py</code></p></div>';
            document.getElementById('map-legend').innerHTML = '';
            document.getElementById('comparison-panel').innerHTML = '';
            allMarkers.forEach(m => map.removeLayer(m)); allMarkers = [];
            ['total-count', 'prime-count', 'avg-score', 'states-count'].forEach(id => document.getElementById(id).textContent = '—');
        }
    } else if (tab === 'hotzones') {
        ds.innerHTML = '<strong>Data:</strong> DBSCAN (eps=0.05 ~3.5mi) · <strong>Method:</strong> Density-Based Spatial Clustering';
        if (zoneData.length > 0) {
            renderZoneFilters(); renderZoneLegend(); renderZoneComparison(); applyZoneFilters();
        } else {
            document.getElementById('filters').innerHTML = '';
            document.getElementById('market-list').innerHTML = '<div class="empty-state"><h3>Hot Zone Analysis</h3><p>Run the Python script to generate clusters:<br><code>python fetch_expansion_targets.py</code></p></div>';
            document.getElementById('map-legend').innerHTML = '';
            document.getElementById('comparison-panel').innerHTML = '';
            allMarkers.forEach(m => map.removeLayer(m)); allMarkers = [];
            ['total-count', 'prime-count', 'avg-score', 'states-count'].forEach(id => document.getElementById(id).textContent = '—');
        }
    }
}

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

document.getElementById('property-selector').addEventListener('change', (e) => {
    selectedProperty = e.target.value;
    switchTab(currentTab);
});

// ============================================================
// CSV EXPORT
// ============================================================
function exportCSV() {
    if (!currentFilteredData || currentFilteredData.length === 0) {
        alert('No data to export. Apply filters first.');
        return;
    }

    const columns = [
        'name', 'county', 'state', 'lat', 'lng',
        'pct_hispanic', 'med_hh_income', 'blue_collar_pct', 'pct_renter',
        'pop_density', 'avg_hh_size', 'pct_snap', 'pct_poverty',
        'pct_commute_car', 'pct_families_with_kids', 'population',
        'summary', 'anchors'
    ];

    // Add tab-specific columns
    if (currentTab === 'demographic') {
        columns.splice(5, 0, 'match_score');
    } else if (currentTab === 'twins') {
        columns.splice(5, 0, 'twin_score', 'matched_property', 'property_type');
    } else if (currentTab === 'hotzones') {
        columns.splice(0, columns.length, 'zone_name', 'state', 'lat', 'lng',
            'avg_score', 'tract_count', 'total_pop', 'size_class',
            'pct_hispanic', 'med_hh_income', 'blue_collar_pct', 'pct_renter',
            'avg_pop_density', 'avg_hh_size', 'pct_snap',
            'summary', 'anchors');
    }

    const header = columns.join(',');
    const rows = currentFilteredData.map(d => {
        return columns.map(c => {
            let v = d[c];
            if (v == null) return '';
            if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
            return v;
        }).join(',');
    });

    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nmc_atlas_${currentTab}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================================
// METHODOLOGY PANEL
// ============================================================
function toggleMethodology() {
    const overlay = document.getElementById('methodology-overlay');
    overlay.classList.toggle('open');
}

document.getElementById('btn-methodology').addEventListener('click', toggleMethodology);
document.getElementById('methodology-backdrop').addEventListener('click', toggleMethodology);
document.getElementById('meth-close').addEventListener('click', toggleMethodology);
document.getElementById('btn-export').addEventListener('click', exportCSV);

// ============================================================
// DATA LOADING
// ============================================================
async function loadDemoData() {
    try {
        const r = await fetch('expansion_targets.json');
        if (r.ok) {
            const d = await r.json();
            if (d.length > 0) {
                console.log(`Loaded ${d.length} demographic targets`);
                return d.map(cleanRecord);
            }
        }
    } catch (e) { console.warn('Failed to load expansion_targets.json:', e); }
    return [];
}

async function loadTwinData() {
    try {
        const r = await fetch('property_twins.json');
        if (r.ok) {
            const d = await r.json();
            if (d.twins && d.twins.length > 0) {
                console.log(`Loaded ${d.twins.length} property twins`);
                d.twins = d.twins.map(cleanRecord);
                d.benchmarks = (d.benchmarks || []).map(cleanRecord);
                return d;
            }
        }
    } catch (e) { console.warn('Failed to load property_twins.json:', e); }
    return { benchmarks: [], twins: [] };
}

async function loadZoneData() {
    try {
        const r = await fetch('hot_zones.json');
        if (r.ok) {
            const d = await r.json();
            if (d.length > 0) {
                console.log(`Loaded ${d.length} hot zones`);
                return d.map(cleanRecord);
            }
        }
    } catch (e) { console.warn('Failed to load hot_zones.json:', e); }
    return [];
}

// ============================================================
// METHODOLOGY CONTENT (verified against fetch_expansion_targets.py)
// ============================================================
function buildMethodologyHTML() {
    return `
        <h3>How We Obtained This Data</h3>
        <p>All data in the Expansion Atlas is programmatically fetched from official U.S. government sources using a Python pipeline (<code>fetch_expansion_targets.py</code>). No data is manually entered or estimated. The pipeline:</p>
        <ol>
            <li><strong>Census ACS API</strong> — Queries the <strong>U.S. Census Bureau American Community Survey (ACS) 5-Year Estimates</strong> (2023 vintage) via the official Census API using the <code>census</code> Python library. Every tract-level variable is pulled directly from the API for all target geographies.</li>
            <li><strong>Census Gazetteer File</strong> — Downloads the <strong>2023 Gazetteer tract file</strong> from <code>census.gov</code> (a ~3MB zip) to obtain tract-level land area (in square miles) and internal-point coordinates (latitude/longitude). This replaces per-tract geocoding API calls. The file is cached locally after first download.</li>
            <li><strong>Census Geocoder</strong> — For the 9 NMM benchmark properties, the pipeline reverse-geocodes each property's lat/lng to its Census tract FIPS code using the Census Bureau's <code>geocoding.geo.census.gov</code> API, then fetches that tract's ACS data.</li>
            <li><strong>FCC Area API</strong> — Hot Zone cluster centroids are reverse-geocoded using the FCC's <code>geo.fcc.gov/api/census/area</code> endpoint to obtain human-readable county/city/place names. No rate limits apply.</li>
            <li><strong>Growth Trajectory</strong> — The pipeline fetches ACS data for <em>both</em> the 2023 and 2018 vintages, then calculates per-tract deltas across 8 growth metrics (Hispanic %, pop density, renter %, SNAP %, HH size, income, families with kids, stability). Deltas are normalized via percentile ranking and weighted into a composite 0–100 growth score.</li>
        </ol>

        <h3>Geographic Coverage</h3>
        <p>The pipeline queries all tracts in <strong>5 full states</strong> (Illinois, Indiana, Wisconsin, Michigan, Ohio) plus <strong>4 DFW-area Texas counties</strong> (Dallas FIPS 113, Tarrant 439, Collin 085, Denton 121). DFW counties are specifically filtered to avoid pulling rural Texas tracts.</p>

        <h3>Census Variables (31 Fields)</h3>
        <p>Each tract pulls exactly these ACS variables, organized by category:</p>
        <table class="meth-table">
            <tr><th>Category</th><th>Variables</th></tr>
            <tr><td>Population</td><td><code>B01003_001E</code> total pop, <code>B01002_001E</code> median age</td></tr>
            <tr><td>Ethnicity</td><td><code>B03003_003E</code> Hispanic, <code>B02001_003E</code> Black, <code>B02001_005E</code> Asian</td></tr>
            <tr><td>Income</td><td><code>B19013_001E</code> median HH income, <code>B25077_001E</code> median home value</td></tr>
            <tr><td>Blue-Collar</td><td><code>C24010_030E</code>/<code>034E</code> male + <code>C24010_066E</code>/<code>070E</code> female natural resources, maintenance, production &amp; transport occupations</td></tr>
            <tr><td>Employment</td><td><code>B23025_004E</code> employed, <code>B23025_005E</code> unemployed (for unemployment rate)</td></tr>
            <tr><td>Housing Tenure</td><td><code>B25003_003E</code>/<code>001E</code> renter-occupied/total occupied, <code>B25002_003E</code>/<code>001E</code> vacant/total housing</td></tr>
            <tr><td>Multi-Unit Housing</td><td><code>B25024_006E</code> 5–9 units, <code>007E</code> 10–19, <code>008E</code> 20–49, <code>009E</code> 50+ unit buildings</td></tr>
            <tr><td>Household</td><td><code>B11016_001E</code>/<code>B11001_001E</code> total HH (household size), <code>B11001_007E</code> non-family (singles), <code>B11005_001E</code> HH w/ children</td></tr>
            <tr><td>Age</td><td><code>B01001_020E</code>/<code>044E</code> male/female 65-66 (senior proxy)</td></tr>
            <tr><td>Commute</td><td><code>B08301_002E</code> car, <code>010E</code> transit, <code>001E</code> total commuters, <code>021E</code> work from home</td></tr>
            <tr><td>Travel Time</td><td><code>B08303_002E</code> &lt;5 min, <code>003E</code> 5–9 min (short commute / traffic proxy)</td></tr>
            <tr><td>Education</td><td><code>B15003_017E</code> HS diploma only, <code>022E</code> bachelor's, <code>001E</code> education universe (25+)</td></tr>
            <tr><td>Mobility</td><td><code>B07003_004E</code> same house 1yr ago, <code>001E</code> mobility universe</td></tr>
            <tr><td>Assistance</td><td><code>B22010_002E</code> SNAP/food stamps, <code>B17001_002E</code> below poverty, <code>001E</code> poverty universe</td></tr>
        </table>

        <h3>Quality Filters — Tract Entry Thresholds</h3>
        <p>Before scoring, the pipeline applies these filters to build the analysis universe. Tracts must pass <strong>all</strong> of the following:</p>
        <table class="meth-table">
            <tr><th>Parameter</th><th>Threshold</th><th>Rationale</th></tr>
            <tr><td>Total Population</td><td>&ge; 1,500</td><td>Ensures statistical significance and sufficient consumer base</td></tr>
            <tr><td>Hispanic %</td><td>&ge; 15%</td><td>Minimum alignment with NMM's core tenant mix</td></tr>
            <tr><td>Median HH Income</td><td>$35,000 – $120,000</td><td>Excludes extreme poverty and ultra-affluent areas</td></tr>
            <tr><td>Vacancy Rate</td><td>&lt; 20%</td><td>Avoids declining or unstable housing markets</td></tr>
            <tr><td>Unemployment Rate</td><td>&lt; 15%</td><td>Avoids economically distressed areas with low spending power</td></tr>
        </table>
        <p>Additionally, all tracts with population &le; 1,000 or missing income data are excluded in a pre-filter step before any scoring occurs.</p>

        <h3>Demographic Scoring Model (0–100 Composite)</h3>
        <p>Each tract is scored using 13 weighted sub-scores that sum to 100 points. Each sub-score is individually normalized (0–1 scale, capped at the 95th percentile to limit outlier distortion), then multiplied by its weight. Weights are calibrated to reflect the demographic DNA of NMM's highest-performing California portfolio properties:</p>
        <table class="meth-table">
            <tr><th>Factor</th><th>Weight</th><th>Normalization</th><th>Rationale</th></tr>
            <tr><td>Pop Density</td><td>18</td><td>÷ 95th percentile, capped 0–1</td><td>Volume business model — drives foot traffic</td></tr>
            <tr><td>Hispanic %</td><td>15</td><td>Raw %, clipped 0–1</td><td>Core tenant demand signal (El Super, Cardenas)</td></tr>
            <tr><td>Income Proximity</td><td>12</td><td>1 – |income − $65K| / $65K</td><td>$65K target — penalizes deviation in either direction</td></tr>
            <tr><td>HH Size</td><td>10</td><td>÷ 95th percentile, capped 0–1</td><td>Larger HH = higher per-trip spend on essentials</td></tr>
            <tr><td>Renter %</td><td>8</td><td>Raw %, clipped 0–1</td><td>Renter HH shop nearby, predictable patterns</td></tr>
            <tr><td>Blue Collar %</td><td>8</td><td>÷ 95th percentile, capped 0–1</td><td>Essential workforce, necessity-retail aligned</td></tr>
            <tr><td>SNAP Receipt</td><td>8</td><td>÷ 95th percentile, capped 0–1</td><td>Direct demand signal for discount grocery</td></tr>
            <tr><td>Housing Density</td><td>5</td><td>÷ 95th percentile, capped 0–1</td><td>Multi-unit = walk-in trade area density</td></tr>
            <tr><td>Families w/ Kids</td><td>5</td><td>Clipped 0–0.5, then ×2</td><td>Grocery volume driver</td></tr>
            <tr><td>Daytime Pop Ratio</td><td>4</td><td>(ratio − 0.5) / 0.5, capped 0–1</td><td>Worker inflow = midday shopping boost</td></tr>
            <tr><td>Traffic Intensity</td><td>3</td><td>÷ 95th percentile, capped 0–1</td><td>Drive-by visibility for strip center formats</td></tr>
            <tr><td>Residential Stability</td><td>2</td><td>Raw %, clipped 0–1</td><td>Stable neighborhoods = recurring foot traffic</td></tr>
            <tr><td>Car Commute %</td><td>2</td><td>Raw %, clipped 0–1</td><td>PM commute visibility</td></tr>
        </table>

        <h3>Growth Trajectory (2018 → 2023 Delta Analysis)</h3>
        <p>The pipeline fetches ACS data for <em>both</em> the 2023 and 2018 vintages, matched by FIPS code. For each of 8 growth metrics, it computes the raw delta (2023 value − 2018 value), then normalizes each delta to a 0–1 scale using percentile-based ranking (5th–95th range). Sub-scores are weighted and combined into a 0–100 composite growth score:</p>
        <table class="meth-table">
            <tr><th>Growth Metric</th><th>Weight</th><th>Favorable Direction</th></tr>
            <tr><td>Hispanic %</td><td>20</td><td>↑ Growing</td></tr>
            <tr><td>Pop Density</td><td>20</td><td>↑ Growing</td></tr>
            <tr><td>Renter %</td><td>15</td><td>↑ Growing</td></tr>
            <tr><td>SNAP %</td><td>10</td><td>↑ Growing</td></tr>
            <tr><td>HH Size</td><td>10</td><td>↑ Growing</td></tr>
            <tr><td>Median Income</td><td>10</td><td>↑ Growing</td></tr>
            <tr><td>Families w/ Kids</td><td>10</td><td>↑ Growing</td></tr>
            <tr><td>Stability</td><td>5</td><td>↑ Growing</td></tr>
        </table>

        <h3>Property Twin Analysis (21-Dimension Cosine Similarity)</h3>
        <p>The "Property Twins" tab compares every qualifying tract against 9 NMM benchmark properties using <strong>cosine similarity</strong> across exactly these 21 features:</p>
        <table class="meth-table">
            <tr><th>#</th><th>Feature</th><th>#</th><th>Feature</th></tr>
            <tr><td>1</td><td>Hispanic %</td><td>12</td><td>Commute by Car %</td></tr>
            <tr><td>2</td><td>Black %</td><td>13</td><td>HS Diploma Only %</td></tr>
            <tr><td>3</td><td>Asian %</td><td>14</td><td>Bachelor's Degree %</td></tr>
            <tr><td>4</td><td>Blue-Collar Density</td><td>15</td><td>Unemployment %</td></tr>
            <tr><td>5</td><td>Housing Density</td><td>16</td><td>Pop Density (per sq mi)</td></tr>
            <tr><td>6</td><td>Singles %</td><td>17</td><td>Avg HH Size</td></tr>
            <tr><td>7</td><td>Income (log-transformed)</td><td>18</td><td>SNAP %</td></tr>
            <tr><td>8</td><td>Renter %</td><td>19</td><td>Poverty %</td></tr>
            <tr><td>9</td><td>Vacancy %</td><td>20</td><td>Daytime Pop Ratio</td></tr>
            <tr><td>10</td><td>Families w/ Kids %</td><td>21</td><td>Traffic Intensity</td></tr>
            <tr><td>11</td><td>Residential Stability %</td><td></td><td></td></tr>
        </table>
        <p><strong>Process:</strong> All 21 features for both benchmarks and target tracts are normalized together using <strong>MinMaxScaler</strong> (scikit-learn) to the 0–1 range before computing cosine similarity. Each tract receives its <strong>top-3</strong> benchmark matches. Only tracts with &ge; 70% similarity to at least one benchmark are included in the results.</p>

        <div class="meth-caveat">
            <strong>✅ Fully Calibrated:</strong> Each benchmark property is reverse-geocoded to its Census tract via the Census Geocoder API, and all 21 twin features are computed from actual ACS 5-Year data — the same source and methodology used for target tracts. No dimensions are estimated or imputed. The remaining proxy is that Census tract demographics represent the tract where the property sits, not a true trade-area analysis (e.g., using mobile device or loyalty card data).
        </div>

        <h3>The 9 NMM Benchmark Properties</h3>
        <table class="meth-table">
            <tr><th>Property</th><th>Type</th></tr>
            <tr><td>Bristol Warner (Santa Ana)</td><td>Hispanic Value</td></tr>
            <tr><td>Anaheim Town Square</td><td>Hispanic Value</td></tr>
            <tr><td>El Cajon Town &amp; Country</td><td>Hispanic Value</td></tr>
            <tr><td>Winston Plaza (Melrose)</td><td>Urban Core</td></tr>
            <tr><td>Bricktown Square</td><td>Urban Core</td></tr>
            <tr><td>Stratford Crossing</td><td>Suburban Power</td></tr>
            <tr><td>Marketplace 99 (Elk Grove)</td><td>Suburban Power</td></tr>
            <tr><td>Madison Marketplace</td><td>Suburban Power</td></tr>
            <tr><td>Lake Meadows (Chicago)</td><td>Urban Redevelopment</td></tr>
        </table>

        <h3>Hot Zone Clustering (DBSCAN)</h3>
        <p>Hot Zones group nearby qualifying tracts into contiguous trade areas using <strong>DBSCAN</strong> (Density-Based Spatial Clustering of Applications with Noise) from scikit-learn:</p>
        <table class="meth-table">
            <tr><th>Parameter</th><th>Value</th><th>Meaning</th></tr>
            <tr><td><code>eps</code></td><td>0.05 (~3.5 miles)</td><td>Maximum distance between two tracts to be in the same cluster</td></tr>
            <tr><td><code>min_samples</code></td><td>2</td><td>Minimum tracts needed to form a multi-tract cluster</td></tr>
        </table>
        <p>Unclustered tracts (DBSCAN label = −1) are promoted to individual "micro zones" so no qualifying tract is excluded. Zone names come from the FCC Area API reverse-geocode of each cluster's centroid. Zone scores are the mean of constituent tract scores.</p>
        <p>Zones are classified by total combined population:</p>
        <table class="meth-table">
            <tr><th>Size Class</th><th>Population</th></tr>
            <tr><td>Mega Zone</td><td>&gt; 30,000</td></tr>
            <tr><td>Large Zone</td><td>&gt; 15,000</td></tr>
            <tr><td>Medium Zone</td><td>&gt; 8,000</td></tr>
            <tr><td>Micro Zone</td><td>&le; 8,000</td></tr>
        </table>

        <h3>Known Limitations</h3>
        <p>This analysis should be used as a screening tool, not a definitive acquisition recommendation:</p>
        <ul>
            <li><strong>No retail supply data.</strong> The model identifies demand-side demographics but does not account for existing shopping center inventory, competitive density, or vacancy rates in retail corridors.</li>
            <li><strong>No rent/cap rate overlay.</strong> Acquisition economics (asking rents, cap rates, asset pricing) are not incorporated.</li>
            <li><strong>Census tract ≠ trade area.</strong> Shopping center trade areas (typically 1–3 mile radius) do not align with census tract boundaries. Multiple tracts may comprise one trade area.</li>
            <li><strong>ACS is backward-looking.</strong> The 2023 ACS 5-Year Estimates represent averages over 2019–2023. Forward-looking demand projections require ESRI or similar proprietary sources.</li>
            <li><strong>Anchor tenant suggestions are rule-based.</strong> Tenant fits shown on cards (e.g., "El Super, Ross") are derived from simple Hispanic % thresholds, not from actual leasing data or market studies.</li>
        </ul>
    `;
}

// ============================================================
// INIT
// ============================================================
Promise.all([loadDemoData(), loadTwinData(), loadZoneData()]).then(([demo, twins, zones]) => {
    demoData = demo.sort((a, b) => b.match_score - a.match_score);
    twinData = twins;
    if (twinData && twinData.twins) twinData.twins.sort((a, b) => b.twin_score - a.twin_score);
    zoneData = zones.sort((a, b) => (b.avg_score || 0) - (a.avg_score || 0));

    // Build zone_name lookup
    zoneData.forEach(z => {
        if (z.cluster_id != null) zoneNameMap[z.cluster_id] = z.zone_name;
    });

    // Compute normalization stats
    const allTracts = [...demoData, ...(twinData.twins || [])];
    computeFeatureNorms(allTracts);

    // Populate property selector
    const selector = document.getElementById('property-selector');
    if (twinData && twinData.benchmarks) {
        twinData.benchmarks.forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.name;
            opt.textContent = `${b.name} (${b.type})`;
            selector.appendChild(opt);
        });
        computeBenchmarkProfiles(twinData.twins, twinData.benchmarks);
        computeBenchmarkVectors();
    }

    // Update topbar with actual counts
    const topbarInfo = document.querySelector('.topbar-left');
    if (topbarInfo) {
        const states = new Set([...demoData.map(d => d.state), ...(twinData.twins || []).map(t => t.state), ...zoneData.map(z => z.state)]);
        topbarInfo.innerHTML = `
            <span>NewMark Merrill Companies</span>
            <span class="version-badge">v7.1</span>
            <span>ACS 5-Year 2023 · ${states.size} States · ${demoData.length.toLocaleString()} Tracts · ${(twinData.twins || []).length.toLocaleString()} Twins · ${zoneData.length} Zones</span>`;
    }

    switchTab('demographic');

    // Heatmap toggle
    const heatBtn = document.getElementById('heatmap-toggle');
    if (heatBtn) heatBtn.addEventListener('click', toggleHeatmap);

    // ── Methodology Content ──
    const methHTML = buildMethodologyHTML();
    const methContent = document.getElementById('methodology-content');
    const welcomeContent = document.getElementById('welcome-content');
    if (methContent) methContent.innerHTML = methHTML;
    if (welcomeContent) welcomeContent.innerHTML = methHTML;

    // Methodology slide-over toggle (topbar button)
    const methOverlay = document.getElementById('methodology-overlay');
    document.getElementById('btn-methodology').addEventListener('click', () => {
        methOverlay.classList.add('open');
    });
    document.getElementById('meth-close').addEventListener('click', () => {
        methOverlay.classList.remove('open');
    });
    document.getElementById('methodology-backdrop').addEventListener('click', () => {
        methOverlay.classList.remove('open');
    });

    // Welcome modal — auto-open once per session
    const welcomeOverlay = document.getElementById('welcome-overlay');
    if (!sessionStorage.getItem('atlas-meth-seen')) {
        welcomeOverlay.classList.add('open');
    }
    document.getElementById('welcome-enter').addEventListener('click', () => {
        welcomeOverlay.classList.remove('open');
        sessionStorage.setItem('atlas-meth-seen', '1');
    });
    document.getElementById('welcome-backdrop').addEventListener('click', () => {
        welcomeOverlay.classList.remove('open');
        sessionStorage.setItem('atlas-meth-seen', '1');
    });
});
