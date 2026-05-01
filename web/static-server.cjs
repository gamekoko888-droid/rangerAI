const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PORT = 3000;
const API_BACKEND = 'http://127.0.0.1:3002';
const DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
};

// 可压缩的 MIME 类型
const COMPRESSIBLE = new Set([
    'text/html', 'text/javascript', 'text/css', 'application/json',
    'image/svg+xml', 'text/plain', 'text/xml', 'application/xml'
]);

http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // Proxy /api/* requests to backend
    if (url.startsWith('/api/')) {
        const proxyReq = http.request(
            `${API_BACKEND}${req.url}`,
            {
                method: req.method,
                headers: {
                    ...req.headers,
                    host: '127.0.0.1:3002',
                },
            },
            (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res, { end: true });
            }
        );
        proxyReq.on('error', (err) => {
            console.error('[Proxy] Error:', err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Backend unavailable' }));
        });
        req.pipe(proxyReq, { end: true });
        return;
    }

    // Serve static files
    let filePath = path.join(DIR, url === '/' ? 'index.html' : url);
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeType = MIME_TYPES[extname] || 'application/octet-stream';

    // 检查客户端是否支持 gzip
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const supportsGzip = acceptEncoding.includes('gzip');

    // 对 /assets/ 下的 JS/CSS，优先尝试预压缩的 .gz 文件
    const isAsset = url.startsWith('/assets/');
    const canUsePrecompressed = isAsset && supportsGzip && COMPRESSIBLE.has(mimeType);

    const tryServeFile = (fPath, encoding, headers, fallback) => {
        fs.readFile(fPath, (err, content) => {
            if (err) {
                if (fallback) {
                    fallback();
                } else if (err.code === 'ENOENT') {
                    // SPA fallback: serve index.html
                    fs.readFile(path.join(DIR, 'index.html'), (err2, indexContent) => {
                        if (err2) { res.writeHead(500); res.end('Server Error'); return; }
                        res.writeHead(200, {
                            'Content-Type': 'text/html',
                            'Cache-Control': 'no-cache, no-store, must-revalidate',
                        });
                        res.end(indexContent, 'utf-8');
                    });
                } else {
                    res.writeHead(500);
                    res.end('Server Error: ' + err.code);
                }
                return;
            }
            const h = { 'Content-Type': headers['Content-Type'] };
            if (isAsset) h['Cache-Control'] = 'public, max-age=31536000, immutable';
            else if (headers["Content-Type"] === "text/html") h["Cache-Control"] = "no-cache, no-store, must-revalidate";
            else if (extname === '.json' || extname === '.svg' || extname === '.ico' || extname === '.png') h['Cache-Control'] = 'public, max-age=86400';  // 1 day for static config files
            if (encoding) h['Content-Encoding'] = encoding;
            h['Vary'] = 'Accept-Encoding';
            res.writeHead(200, h);
            res.end(content);
        });
    };

    if (canUsePrecompressed) {
        // 优先尝试预压缩 .gz 文件
        tryServeFile(
            filePath + '.gz',
            'gzip',
            { 'Content-Type': mimeType },
            () => {
                // .gz 不存在，降级到原始文件（Caddy 会动态 gzip）
                tryServeFile(filePath, null, { 'Content-Type': mimeType }, null);
            }
        );
    } else {
        tryServeFile(filePath, null, { 'Content-Type': mimeType }, null);
    }

}).listen(PORT, () => {
    console.log(`Static server v3 (pre-compressed gzip + cache headers) running at http://127.0.0.1:${PORT}/`);
});
