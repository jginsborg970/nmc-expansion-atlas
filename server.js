const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the current directory
app.use(express.static(path.join(__dirname), {
    maxAge: '1h',
    setHeaders: (res, filePath) => {
        // JSON data files should not be cached aggressively
        if (filePath.endsWith('.json')) {
            res.setHeader('Cache-Control', 'public, max-age=300'); // 5 min
        }
    }
}));

// Fallback to index.html for SPA-like behavior
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`NewMark Merrill Expansion Atlas running on port ${PORT}`);
});
