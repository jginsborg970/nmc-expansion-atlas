# NewMark Merrill — Expansion Atlas v7.1

Demographic targeting tool for discount retail shopping center acquisitions across IL, IN, WI, MI, OH, and DFW-TX.

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

## Deploy to Render

1. Push this directory to a GitHub repo
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect the repo → Render auto-detects `render.yaml`
4. Deploy (free tier works fine)

The URL will be something like `https://nmc-expansion-atlas.onrender.com`

## Data Files

| File | Records | Description |
|------|---------|-------------|
| `expansion_targets.json` | 2,402 | All qualifying census tracts with composite demographic scores |
| `property_twins.json` | 2,288 twins, 9 benchmarks | Tracts matched to NMM properties via 21-dim cosine similarity |
| `hot_zones.json` | 264 | DBSCAN spatial clusters of qualifying tracts |

## Regenerating Data

```bash
pip install pandas census us geopy numpy scikit-learn requests
python fetch_expansion_targets.py
```

Requires Census API key (already embedded in script).

## Architecture

- **Frontend:** Vanilla HTML/CSS/JS + Leaflet maps
- **Server:** Express static file server
- **Data:** Pre-computed JSON from Census ACS 5-Year (2023)
- **No database required** — all data is static JSON

## Internal Use Only

This tool is for NewMark Merrill internal strategic planning. Do not share externally.
