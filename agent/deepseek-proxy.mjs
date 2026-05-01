/**
 * DeepSeek API Proxy — fixes reasoning_content issue
 * 
 * Problem: Gateway (OpenClaw binary) stores reasoning_content from DeepSeek
 * responses in its internal conversation history. When it sends the next
 * request, it includes the full history. DeepSeek V4 API requires that
 * assistant messages with tool_calls MUST include reasoning_content.
 * But sometimes the Gateway sends messages WITHOUT reasoning_content,
 * causing a 400 error.
 *
 * Solution: This proxy intercepts all requests to DeepSeek API and ensures
 * every assistant message has reasoning_content set (empty string if missing).
 * It also handles streaming responses correctly.
 *
 * Port: 18793
 * Target: https://api.deepseek.com
 */

import http from 'node:http';
import https from 'node:https';

const PORT = 18793;
const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_API_KEY = 'sk-4589c30b577d4771a2f214a1ee9a5ba9';

let requestCount = 0;
let fixCount = 0;

function fixRequestBody(body) {
  try {
    const data = JSON.parse(body);
    
    if (!data.messages || !Array.isArray(data.messages)) {
      return body;
    }

    let fixed = 0;
    for (const msg of data.messages) {
      if (msg.role === 'assistant') {
        // If reasoning_content is missing/null/undefined, set to empty string
        if (msg.reasoning_content === undefined || msg.reasoning_content === null) {
          msg.reasoning_content = '';
          fixed++;
        }
      }
    }

    if (fixed > 0) {
      fixCount += fixed;
      const assistantCount = data.messages.filter(m => m.role === 'assistant').length;
      console.log(`[deepseek-proxy] Fixed ${fixed}/${assistantCount} assistant messages (added reasoning_content="")`);
      return JSON.stringify(data);
    }

    return body;
  } catch (e) {
    console.error(`[deepseek-proxy] Failed to parse request body: ${e.message}`);
    return body;
  }
}

const server = http.createServer((req, res) => {
  requestCount++;
  const reqId = requestCount;
  
  // Only process POST requests to chat/completions
  const isChatEndpoint = req.url.includes('/chat/completions');
  
  let bodyChunks = [];
  
  req.on('data', chunk => bodyChunks.push(chunk));
  
  req.on('end', () => {
    let body = Buffer.concat(bodyChunks).toString();
    
    // Fix reasoning_content for chat completion requests
    if (isChatEndpoint && req.method === 'POST') {
      body = fixRequestBody(body);
    }

    // Forward to DeepSeek API
    const options = {
      hostname: DEEPSEEK_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        'host': DEEPSEEK_HOST,
        'content-length': Buffer.byteLength(body),
        'authorization': `Bearer ${DEEPSEEK_API_KEY}`,
      },
    };
    
    // Remove hop-by-hop headers
    delete options.headers['connection'];
    delete options.headers['keep-alive'];
    delete options.headers['transfer-encoding'];

    const proxyReq = https.request(options, (proxyRes) => {
      const statusCode = proxyRes.statusCode;
      
      if (statusCode >= 400) {
        // Log error responses
        let errBody = '';
        proxyRes.on('data', chunk => errBody += chunk);
        proxyRes.on('end', () => {
          console.error(`[deepseek-proxy] #${reqId} ${req.method} ${req.url} → ${statusCode}: ${errBody.slice(0, 200)}`);
          res.writeHead(statusCode, proxyRes.headers);
          res.end(errBody);
        });
        return;
      }

      // Stream successful responses through
      console.log(`[deepseek-proxy] #${reqId} ${req.method} ${req.url} → ${statusCode} (total: ${requestCount}, fixes: ${fixCount})`);
      res.writeHead(statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error(`[deepseek-proxy] #${reqId} Proxy error: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Proxy error: ${err.message}`, type: 'proxy_error' } }));
    });

    proxyReq.write(body);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[deepseek-proxy] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[deepseek-proxy] Forwarding to https://${DEEPSEEK_HOST}`);
  console.log(`[deepseek-proxy] Will fix reasoning_content in assistant messages`);
});

server.on('error', (err) => {
  console.error(`[deepseek-proxy] Server error: ${err.message}`);
  process.exit(1);
});
