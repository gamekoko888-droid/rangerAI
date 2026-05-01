import assert from 'node:assert';
import test from 'node:test';

// Mock formatBytes equivalent logic
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

test('Utility: formatBytes logic', () => {
  assert.strictEqual(formatBytes(0), '0 Bytes');
  assert.strictEqual(formatBytes(1024), '1 KB');
  assert.strictEqual(formatBytes(1024 * 1024), '1 MB');
  assert.strictEqual(formatBytes(1536), '1.5 KB');
});

// Test logic: Finding the main JS file from HTML/FS
function mockFindMainJs(htmlContent, jsFiles, mockFsStats) {
  // Regex from our Iter-61 update
  const match = htmlContent.match(/src="\/assets\/(index-[^"]+\.js)"/);
  if (match) return match[1];
  
  // Fallback check
  return jsFiles
    .filter(f => f.startsWith('index-'))
    .map(f => ({ name: f, size: mockFsStats[f] || 0 }))
    .sort((a,b) => b.size - a.size)[0]?.name || null;
}

test('Logic: Smart Entry Point Detection', () => {
  const html = '... src="/assets/index-ACTUAL.js" ...';
  const files = ['index-SMALL.js', 'index-ACTUAL.js', 'index-LEGACY.js'];
  const stats = { 'index-SMALL.js': 1000, 'index-ACTUAL.js': 200000, 'index-LEGACY.js': 300000 };
  
  // Should prefer HTML match over larger files
  assert.strictEqual(mockFindMainJs(html, files, stats), 'index-ACTUAL.js');
  
  // Should fallback to largest file if HTML match fails
  assert.strictEqual(mockFindMainJs('', files, stats), 'index-LEGACY.js');
});
