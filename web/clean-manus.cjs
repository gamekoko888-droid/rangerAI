const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'dist/public/index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const origSize = html.length;

// Strategy: find and remove the manus-runtime script block
// It's typically a very large inline script (>100KB) injected by the Manus platform
// Pattern 1: <script id="manus-runtime">...</script>
html = html.replace(/<script\s+id\s*=\s*"manus-runtime"[^>]*>[\s\S]*?<\/script>/gi, '');

// Pattern 2: Large inline script containing __MANUS or __manus
html = html.replace(/<script[^>]*>[\s\S]*?__MANUS[\s\S]*?<\/script>/gi, function(match) {
  // Only remove if it's large (>10KB) to avoid false positives
  if (match.length > 10000) return '';
  return match;
});

// Pattern 3: Any inline script > 50KB (definitely not application code)
const parts = [];
let lastIndex = 0;
const scriptRegex = /<script(?:\s[^>]*)?>[\s\S]*?<\/script>/gi;
let m;
while ((m = scriptRegex.exec(html)) !== null) {
  const tag = m[0];
  // Skip scripts with src attribute (external scripts are fine)
  if (/\ssrc\s*=/.test(tag)) continue;
  // Skip scripts with type="application/ld+json" (structured data)
  if (/type\s*=\s*["']application\/ld\+json["']/.test(tag)) continue;
  // Remove if > 50KB
  if (tag.length > 50000) {
    parts.push(html.substring(lastIndex, m.index));
    lastIndex = m.index + tag.length;
  }
}
if (parts.length > 0) {
  parts.push(html.substring(lastIndex));
  html = parts.join('');
}

fs.writeFileSync(htmlPath, html);
const newSize = html.length;
console.log(`Cleaned: ${origSize} -> ${newSize} bytes (removed ${origSize - newSize} bytes)`);

// Verify essential elements are preserved
const hasRoot = html.includes('id="root"');
const hasJs = /src="\/assets\/index-[^"]+\.js"/.test(html);
const hasCss = /href="\/assets\/[^"]+\.css"/.test(html);
console.log(`Verification: root=${hasRoot}, js=${hasJs}, css=${hasCss}`);
if (!hasRoot || !hasJs) {
  console.error('ERROR: Essential elements missing after cleanup!');
  process.exit(1);
}
