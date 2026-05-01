// R43-T6: final_answer quality scoring - completeness + confidence
const fs = require('fs');

// === 1. Patch openclaw-handler.mjs ===
const ochPath = '/opt/rangerai-agent/worker/openclaw-handler.mjs';
let ochCode = fs.readFileSync(ochPath, 'utf8');

// Add quality scoring function before the FINAL_ANSWER emit
const qualityFn = `
      // [R43-T6] Quality scoring for final_answer
      const _r43QualityScore = (() => {
        const _text = text || "";
        const _len = _text.length;
        // Completeness: based on content richness
        let _completeness = 0;
        if (_len > 50) _completeness += 0.2;
        if (_len > 200) _completeness += 0.2;
        if (_len > 500) _completeness += 0.15;
        if (_len > 1000) _completeness += 0.1;
        if (_len > 2000) _completeness += 0.05;
        // Structural markers: lists, tables, headers, code blocks
        if (/\\n[-*]\\s/.test(_text)) _completeness += 0.1; // bullet lists
        if (/\\|.*\\|/.test(_text)) _completeness += 0.1; // tables
        if (/^#{1,3}\\s/m.test(_text)) _completeness += 0.05; // headers
        if (/\`\`\`/.test(_text)) _completeness += 0.05; // code blocks
        _completeness = Math.min(1, Math.round(_completeness * 100) / 100);
        // Confidence: based on tool usage and task completion signals
        let _confidence = 0.5; // base confidence
        const _tc = tracker.toolCount || 0;
        if (_tc > 0) _confidence += 0.15; // used tools
        if (_tc > 3) _confidence += 0.1; // used multiple tools
        if (_tc > 6) _confidence += 0.05; // extensive tool usage
        // Check for error/uncertainty language
        const _uncertainWords = ['不确定', '可能', 'might', 'perhaps', 'not sure', '无法确认'];
        const _hasUncertainty = _uncertainWords.some(w => _text.toLowerCase().includes(w));
        if (_hasUncertainty) _confidence -= 0.1;
        // Check for citations/references
        if (/\\[\\d+\\]/.test(_text)) _confidence += 0.1; // numbered citations
        if (/https?:\\/\\//.test(_text)) _confidence += 0.05; // URLs
        _confidence = Math.min(1, Math.max(0, Math.round(_confidence * 100) / 100));
        return { completeness: _completeness, confidence: _confidence };
      })();
`;

// Insert before the FINAL_ANSWER emitEvent call
const oldFinalEmit = `emitEvent(sessionKey, msgId, EVENT_TYPES.FINAL_ANSWER, {
            content: text || "",
            toolCount: tracker.toolCount,
          });`;
const newFinalEmit = `${qualityFn}
          emitEvent(sessionKey, msgId, EVENT_TYPES.FINAL_ANSWER, {
            content: text || "",
            toolCount: tracker.toolCount,
            completeness: _r43QualityScore.completeness,
            confidence: _r43QualityScore.confidence,
          });`;

if (ochCode.includes(oldFinalEmit)) {
  ochCode = ochCode.replace(oldFinalEmit, newFinalEmit);
  console.log('✅ Added quality scoring to openclaw-handler FINAL_ANSWER');
} else {
  console.log('❌ Could not find openclaw-handler FINAL_ANSWER emit');
  // Try partial match
  const partial = 'content: text || "",\n            toolCount: tracker.toolCount,';
  if (ochCode.includes(partial)) {
    ochCode = ochCode.replace(partial, `content: text || "",
            toolCount: tracker.toolCount,
            completeness: 0.5,
            confidence: 0.5,`);
    console.log('✅ Added placeholder quality scores (partial match)');
  }
}

fs.writeFileSync(ochPath, ochCode);

// === 2. Patch user-message-handler.mjs ===
const umhPath = '/opt/rangerai-agent/worker/user-message-handler.mjs';
let umhCode = fs.readFileSync(umhPath, 'utf8');

// Find the simple path FINAL_ANSWER emit
const oldSimpleEmit = `emitEvent(sessionKey, taskId, EVENT_TYPES.FINAL_ANSWER, { content: typeof result === "string" ? result : "", model: routing?.fallbackModel || "unknown", path: "simple" }, routing?.fallbackModel);`;
const newSimpleEmit = `// [R43-T6] Quality scoring for simple path
      const _r43SimpleQuality = (() => {
        const _t = typeof result === "string" ? result : "";
        const _l = _t.length;
        let _c = 0;
        if (_l > 50) _c += 0.2;
        if (_l > 200) _c += 0.2;
        if (_l > 500) _c += 0.15;
        if (_l > 1000) _c += 0.1;
        if (/\\n[-*]\\s/.test(_t)) _c += 0.1;
        if (/\\|.*\\|/.test(_t)) _c += 0.1;
        if (/^#{1,3}\\s/m.test(_t)) _c += 0.05;
        _c = Math.min(1, Math.round(_c * 100) / 100);
        // Simple path has lower base confidence (no tool usage)
        let _cf = 0.4;
        if (_l > 200) _cf += 0.1;
        if (_l > 500) _cf += 0.1;
        if (/https?:\\/\\//.test(_t)) _cf += 0.05;
        _cf = Math.min(1, Math.max(0, Math.round(_cf * 100) / 100));
        return { completeness: _c, confidence: _cf };
      })();
      emitEvent(sessionKey, taskId, EVENT_TYPES.FINAL_ANSWER, { content: typeof result === "string" ? result : "", model: routing?.fallbackModel || "unknown", path: "simple", completeness: _r43SimpleQuality.completeness, confidence: _r43SimpleQuality.confidence }, routing?.fallbackModel);`;

if (umhCode.includes(oldSimpleEmit)) {
  umhCode = umhCode.replace(oldSimpleEmit, newSimpleEmit);
  console.log('✅ Added quality scoring to user-message-handler FINAL_ANSWER');
} else {
  console.log('❌ Could not find user-message-handler FINAL_ANSWER emit');
  // Try to find the line
  const lines = umhCode.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('FINAL_ANSWER') && lines[i].includes('simple')) {
      console.log(`  Found at line ${i+1}: ${lines[i].trim().substring(0, 100)}`);
    }
  }
}

fs.writeFileSync(umhPath, umhCode);

// Verify
const finalOch = fs.readFileSync(ochPath, 'utf8');
const finalUmh = fs.readFileSync(umhPath, 'utf8');
console.log('\n=== Verification ===');
console.log('OCH has completeness:', finalOch.includes('completeness: _r43QualityScore.completeness'));
console.log('OCH has confidence:', finalOch.includes('confidence: _r43QualityScore.confidence'));
console.log('UMH has completeness:', finalUmh.includes('completeness: _r43SimpleQuality.completeness'));
console.log('UMH has confidence:', finalUmh.includes('confidence: _r43SimpleQuality.confidence'));
