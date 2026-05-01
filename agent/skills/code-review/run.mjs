/**
 * code-review/run.mjs — Skill execution entry point
 * 
 * Performs automated code review on specified files.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

const LANG_MAP = {
  '.js': 'JavaScript', '.mjs': 'JavaScript (ESM)', '.ts': 'TypeScript',
  '.jsx': 'React JSX', '.tsx': 'React TSX', '.py': 'Python',
  '.go': 'Go', '.rs': 'Rust', '.java': 'Java',
};

/**
 * @param {Object} input
 * @param {string} input.path - File or directory path to review
 * @param {string} [input.focus] - Specific focus area (security/performance/all)
 * @returns {Object} { success, report, issues }
 */
export async function run(input) {
  const { path: targetPath, focus = 'all' } = input;
  
  if (!targetPath || !existsSync(targetPath)) {
    return { success: false, error: `Path not found: ${targetPath}` };
  }
  
  const stat = statSync(targetPath);
  const files = [];
  
  if (stat.isDirectory()) {
    // Collect code files from directory
    const entries = readdirSync(targetPath, { recursive: true });
    for (const entry of entries) {
      const full = join(targetPath, entry);
      if (statSync(full).isFile() && LANG_MAP[extname(full)]) {
        files.push(full);
      }
    }
  } else {
    files.push(targetPath);
  }
  
  if (files.length === 0) {
    return { success: false, error: 'No reviewable code files found' };
  }
  
  const issues = [];
  const fileReports = [];
  
  for (const file of files.slice(0, 10)) { // Limit to 10 files
    const content = readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const ext = extname(file);
    const lang = LANG_MAP[ext] || 'Unknown';
    
    const fileIssues = [];
    
    // Security checks
    if (focus === 'all' || focus === 'security') {
      lines.forEach((line, i) => {
        // Hardcoded secrets
        if (/(?:password|secret|api_?key|token)\s*[:=]\s*["'][^"']{8,}/i.test(line)) {
          fileIssues.push({ severity: 'critical', line: i + 1, type: 'security', msg: 'Possible hardcoded secret' });
        }
        // SQL injection
        if (/(?:query|execute|sql)\s*\(.*\+.*\)|f["']\s*(?:SELECT|INSERT|UPDATE|DELETE)/i.test(line)) {
          fileIssues.push({ severity: 'critical', line: i + 1, type: 'security', msg: 'Possible SQL injection' });
        }
        // eval usage
        if (/\beval\s*\(/.test(line) && !line.trim().startsWith('//')) {
          fileIssues.push({ severity: 'high', line: i + 1, type: 'security', msg: 'eval() usage detected' });
        }
      });
    }
    
    // Performance checks
    if (focus === 'all' || focus === 'performance') {
      lines.forEach((line, i) => {
        // Sync operations in async context
        if (/readFileSync|writeFileSync|execSync/.test(line)) {
          fileIssues.push({ severity: 'medium', line: i + 1, type: 'performance', msg: 'Synchronous I/O in potentially async context' });
        }
      });
    }
    
    // Maintainability checks
    if (focus === 'all' || focus === 'maintainability') {
      // Function length check
      if (lines.length > 200) {
        fileIssues.push({ severity: 'medium', line: 1, type: 'maintainability', msg: `File is ${lines.length} lines - consider splitting` });
      }
      // TODO/FIXME/HACK
      lines.forEach((line, i) => {
        if (/\b(?:TODO|FIXME|HACK|XXX)\b/.test(line)) {
          fileIssues.push({ severity: 'low', line: i + 1, type: 'maintainability', msg: `Unresolved marker: ${line.trim().substring(0, 80)}` });
        }
      });
    }
    
    issues.push(...fileIssues.map(iss => ({ ...iss, file })));
    
    const critCount = fileIssues.filter(i => i.severity === 'critical').length;
    const highCount = fileIssues.filter(i => i.severity === 'high').length;
    const grade = critCount >= 3 ? 'F' : critCount >= 1 ? 'D' : highCount >= 4 ? 'C' : highCount >= 2 ? 'B' : 'A';
    
    fileReports.push({ file, lang, lines: lines.length, issues: fileIssues.length, grade });
  }
  
  return {
    success: true,
    filesReviewed: fileReports.length,
    totalIssues: issues.length,
    critical: issues.filter(i => i.severity === 'critical').length,
    high: issues.filter(i => i.severity === 'high').length,
    medium: issues.filter(i => i.severity === 'medium').length,
    low: issues.filter(i => i.severity === 'low').length,
    fileReports,
    issues: issues.slice(0, 50), // Limit output
  };
}
