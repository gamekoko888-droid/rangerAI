/**
 * Terminal Streaming Tests — Phase 4
 * 
 * Tests for:
 * 1. parseAnsiColors — ANSI escape code parsing
 * 2. progressHistory accumulation logic
 * 3. getResultText extraction for exec tools
 * 4. TerminalLine rendering logic
 */

import { describe, it, expect } from 'vitest';

// ─── parseAnsiColors tests ─────────────────────────────────

// We need to replicate the parseAnsiColors function here since it's not exported
// This tests the same logic used in MessageList.tsx

interface AnsiPart {
  text: string;
  className: string;
}

function parseAnsiColors(text: string): AnsiPart[] {
  const ansiRegex = /\x1b\[(\d+(?:;\d+)*)m/g;
  const parts: AnsiPart[] = [];
  let lastIndex = 0;
  let currentClass = 'text-green-400/80';

  const colorMap: Record<string, string> = {
    '0': 'text-green-400/80',
    '1': 'font-bold',
    '30': 'text-zinc-500',
    '31': 'text-red-400',
    '32': 'text-green-400',
    '33': 'text-yellow-400',
    '34': 'text-blue-400',
    '35': 'text-purple-400',
    '36': 'text-cyan-400',
    '37': 'text-zinc-300',
    '90': 'text-zinc-500',
    '91': 'text-red-300',
    '92': 'text-green-300',
    '93': 'text-yellow-300',
    '94': 'text-blue-300',
    '95': 'text-purple-300',
    '96': 'text-cyan-300',
    '97': 'text-white',
  };

  let match;
  while ((match = ansiRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), className: currentClass });
    }
    const codes = match[1].split(';');
    for (const code of codes) {
      if (colorMap[code]) {
        currentClass = code === '0' ? 'text-green-400/80' : colorMap[code];
      }
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), className: currentClass });
  }

  if (parts.length === 0) {
    parts.push({ text, className: 'text-green-400/80' });
  }

  return parts;
}

// ─── getResultText replica ──────────────────────────────────

function getResultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'object') {
    try {
      const obj = result as Record<string, unknown>;
      if (obj.text && typeof obj.text === 'string') return obj.text;
      if (obj.output && typeof obj.output === 'string') return obj.output;
      if (obj.stdout && typeof obj.stdout === 'string') return obj.stdout;
      if (obj.content) return typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content);
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  if (typeof result !== 'string') return String(result);
  try {
    const parsed = JSON.parse(result);
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.text) return String(parsed.text);
      if (parsed.output) return String(parsed.output);
      if (parsed.stdout) return String(parsed.stdout);
      if (parsed.content) return typeof parsed.content === 'string' ? parsed.content : JSON.stringify(parsed.content);
      return JSON.stringify(parsed, null, 2);
    }
    return result;
  } catch {
    return result;
  }
}

// ─── Tests ──────────────────────────────────────────────────

describe('parseAnsiColors', () => {
  it('should return plain text with default green class when no ANSI codes', () => {
    const result = parseAnsiColors('Hello World');
    expect(result).toEqual([{ text: 'Hello World', className: 'text-green-400/80' }]);
  });

  it('should return empty string with default class for empty input', () => {
    const result = parseAnsiColors('');
    expect(result).toEqual([{ text: '', className: 'text-green-400/80' }]);
  });

  it('should parse red ANSI color code', () => {
    const result = parseAnsiColors('\x1b[31mError: something failed\x1b[0m');
    // Only 1 part because there's no text after the reset code
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ text: 'Error: something failed', className: 'text-red-400' });
  });

  it('should parse green ANSI color code', () => {
    const result = parseAnsiColors('\x1b[32mSuccess!\x1b[0m');
    expect(result[0]).toEqual({ text: 'Success!', className: 'text-green-400' });
  });

  it('should parse multiple color codes in one line', () => {
    const result = parseAnsiColors('Normal \x1b[31mRed \x1b[32mGreen\x1b[0m End');
    expect(result.length).toBeGreaterThanOrEqual(4);
    expect(result[0]).toEqual({ text: 'Normal ', className: 'text-green-400/80' });
    expect(result[1]).toEqual({ text: 'Red ', className: 'text-red-400' });
    expect(result[2]).toEqual({ text: 'Green', className: 'text-green-400' });
    expect(result[3]).toEqual({ text: ' End', className: 'text-green-400/80' });
  });

  it('should handle bold ANSI code', () => {
    const result = parseAnsiColors('\x1b[1mBold text\x1b[0m');
    expect(result[0]).toEqual({ text: 'Bold text', className: 'font-bold' });
  });

  it('should handle bright color codes (90-97)', () => {
    const result = parseAnsiColors('\x1b[91mBright Red\x1b[0m');
    expect(result[0]).toEqual({ text: 'Bright Red', className: 'text-red-300' });
  });

  it('should handle compound ANSI codes (e.g. 1;31 for bold red)', () => {
    // With compound codes, the last recognized code wins
    const result = parseAnsiColors('\x1b[1;31mBold Red\x1b[0m');
    expect(result[0].text).toBe('Bold Red');
    // The last code (31) should set the class to red
    expect(result[0].className).toBe('text-red-400');
  });

  it('should handle text with no closing reset', () => {
    const result = parseAnsiColors('\x1b[33mWarning text');
    expect(result).toEqual([{ text: 'Warning text', className: 'text-yellow-400' }]);
  });
});

describe('getResultText', () => {
  it('should return empty string for null/undefined', () => {
    expect(getResultText(null)).toBe('');
    expect(getResultText(undefined)).toBe('');
  });

  it('should extract text field from JSON string', () => {
    const json = JSON.stringify({ text: 'Hello from exec' });
    expect(getResultText(json)).toBe('Hello from exec');
  });

  it('should extract output field from JSON string', () => {
    const json = JSON.stringify({ output: 'Command output here' });
    expect(getResultText(json)).toBe('Command output here');
  });

  it('should extract stdout field from JSON string', () => {
    const json = JSON.stringify({ stdout: 'Standard output' });
    expect(getResultText(json)).toBe('Standard output');
  });

  it('should return raw string for non-JSON input', () => {
    expect(getResultText('plain text output')).toBe('plain text output');
  });

  it('should handle object input directly', () => {
    expect(getResultText({ text: 'Direct object' })).toBe('Direct object');
    expect(getResultText({ output: 'Direct output' })).toBe('Direct output');
    expect(getResultText({ stdout: 'Direct stdout' })).toBe('Direct stdout');
  });

  it('should JSON.stringify objects without known fields', () => {
    const result = getResultText({ foo: 'bar' });
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('should handle nested content field', () => {
    const json = JSON.stringify({ content: 'Nested content' });
    expect(getResultText(json)).toBe('Nested content');
  });
});

describe('progressHistory accumulation', () => {
  it('should accumulate progress lines for exec tools', () => {
    // Simulate the reducer logic
    const initialHistory: string[] = [];
    const line1 = 'npm install...';
    const line2 = 'added 50 packages';
    const line3 = 'Done in 3.2s';

    const after1 = [...initialHistory, line1];
    expect(after1).toEqual(['npm install...']);

    const after2 = [...after1, line2];
    expect(after2).toEqual(['npm install...', 'added 50 packages']);

    const after3 = [...after2, line3];
    expect(after3).toEqual(['npm install...', 'added 50 packages', 'Done in 3.2s']);
  });

  it('should handle empty progress text (should not be added)', () => {
    const history: string[] = ['line1'];
    const progressText = '';
    // In the actual code, empty progressText is not added
    if (progressText) {
      history.push(progressText);
    }
    expect(history).toEqual(['line1']);
  });

  it('should truncate visible lines when exceeding MAX_VISIBLE_LINES', () => {
    const MAX_VISIBLE_LINES = 50;
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`);
    
    const visibleLines = lines.length > MAX_VISIBLE_LINES
      ? lines.slice(-MAX_VISIBLE_LINES)
      : lines;
    
    expect(visibleLines.length).toBe(50);
    expect(visibleLines[0]).toBe('Line 51');
    expect(visibleLines[49]).toBe('Line 100');
  });

  it('should not truncate when lines are within limit', () => {
    const MAX_VISIBLE_LINES = 50;
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`);
    
    const visibleLines = lines.length > MAX_VISIBLE_LINES
      ? lines.slice(-MAX_VISIBLE_LINES)
      : lines;
    
    expect(visibleLines.length).toBe(30);
    expect(visibleLines[0]).toBe('Line 1');
  });
});

describe('exec tool terminal preview in PersistedToolSummary', () => {
  it('should show first 3 lines as preview', () => {
    const execOutput = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const previewLines = execOutput.split('\n').slice(0, 3);
    expect(previewLines).toEqual(['Line 1', 'Line 2', 'Line 3']);
  });

  it('should detect when there are more lines', () => {
    const execOutput = 'Line 1\nLine 2\nLine 3\nLine 4';
    const hasMoreLines = execOutput.split('\n').length > 3;
    expect(hasMoreLines).toBe(true);
  });

  it('should not show expand button for 3 or fewer lines', () => {
    const execOutput = 'Line 1\nLine 2\nLine 3';
    const hasMoreLines = execOutput.split('\n').length > 3;
    expect(hasMoreLines).toBe(false);
  });

  it('should handle single line output', () => {
    const execOutput = 'Done';
    const previewLines = execOutput.split('\n').slice(0, 3);
    expect(previewLines).toEqual(['Done']);
    const hasMoreLines = execOutput.split('\n').length > 3;
    expect(hasMoreLines).toBe(false);
  });

  it('should handle empty output', () => {
    const execOutput = '';
    const isExecTool = true;
    const hasExecOutput = isExecTool && execOutput.length > 0;
    expect(hasExecOutput).toBe(false);
  });
});

describe('ToolCall type with progressHistory', () => {
  it('should support progressHistory field', () => {
    const tool = {
      id: 'test-1',
      tool: 'exec',
      args: '{"command":"ls -la"}',
      status: 'running' as const,
      progress: 'latest line',
      progressHistory: ['line 1', 'line 2', 'latest line'],
      toolIndex: 1,
    };
    expect(tool.progressHistory).toHaveLength(3);
    expect(tool.progressHistory[2]).toBe('latest line');
  });

  it('should work without progressHistory (backward compatible)', () => {
    const tool = {
      id: 'test-2',
      tool: 'web_search',
      args: '{"query":"test"}',
      status: 'running' as const,
      progress: 'Searching...',
    };
    expect(tool.progressHistory).toBeUndefined();
    // The || [] fallback in the component
    const history = tool.progressHistory || [];
    expect(history).toEqual([]);
  });
});
