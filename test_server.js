const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/submit-results') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const results = JSON.parse(body);
                const filePath = path.join(PUBLIC_DIR, 'test_results.json');
                fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf8');
                console.log(`\n[Server] Test results written to ${filePath}`);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success' }));
                
                console.log('[Server] Test completed. Shutting down in 2 seconds...');
                setTimeout(() => {
                    process.exit(0);
                }, 2000);
            } catch (e) {
                console.error('[Server] Failed to parse or save results:', e);
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Invalid JSON');
            }
        });
        return;
    }

    if (req.method === 'GET') {
        // Resolve URL path to local file path
        let safeUrl = req.url.split('?')[0];
        if (safeUrl === '/') safeUrl = '/index.html';
        
        const filePath = path.join(PUBLIC_DIR, safeUrl);
        
        // Security check: ensure path is within PUBLIC_DIR
        if (!filePath.startsWith(PUBLIC_DIR)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Forbidden');
            return;
        }

        fs.access(filePath, fs.constants.F_OK, (err) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('File Not Found');
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';

            res.writeHead(200, { 'Content-Type': contentType });
            fs.createReadStream(filePath).pipe(res);
        });
        return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
});

server.listen(PORT, () => {
    console.log(`[Server] Static server running at http://localhost:${PORT}`);
    console.log(`[Server] Automatically launching stress test page...`);
    
    // Open in default browser on Windows
    exec(`start http://localhost:${PORT}/stress_test.html?auto=true`, (err) => {
        if (err) {
            console.error('[Server] Failed to auto-launch browser:', err);
        }
    });
});
