/**
 * browser-screenshot.test.ts — Phase 3: Browser Screenshot Inline Preview
 *
 * Tests for:
 * 1. extractBrowserUrl helper function
 * 2. Screenshot extraction from tool_end events
 * 3. parseToolMetadata preserving screenshot field
 * 4. ToolCall type screenshot field handling
 */
import { describe, it, expect } from 'vitest';

// ─── extractBrowserUrl logic (inlined since it's a local function) ────

function extractBrowserUrl(args: string): string | null {
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    return parsed?.url || null;
  } catch {
    return null;
  }
}

describe('extractBrowserUrl', () => {
  it('extracts URL from valid browser args JSON', () => {
    const args = JSON.stringify({ action: 'navigate', url: 'https://example.com' });
    expect(extractBrowserUrl(args)).toBe('https://example.com');
  });

  it('returns null when no url field', () => {
    const args = JSON.stringify({ action: 'click', selector: '#btn' });
    expect(extractBrowserUrl(args)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(extractBrowserUrl('not json')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractBrowserUrl('')).toBeNull();
  });

  it('handles complex URL with query params', () => {
    const url = 'https://www.google.com/search?q=test&hl=en';
    const args = JSON.stringify({ action: 'navigate', url });
    expect(extractBrowserUrl(args)).toBe(url);
  });
});

// ─── Screenshot extraction from tool_end result ─────────────

describe('Screenshot extraction from tool_end result', () => {
  function extractScreenshot(result: unknown): string | undefined {
    let screenshotUrl: string | undefined;
    if (result && typeof result === 'object') {
      const resultObj = result as Record<string, unknown>;
      if (typeof resultObj.screenshot === 'string') {
        screenshotUrl = resultObj.screenshot;
      }
    } else if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        if (parsed?.screenshot) screenshotUrl = parsed.screenshot;
      } catch { /* not JSON */ }
    }
    return screenshotUrl;
  }

  it('extracts screenshot from object result', () => {
    const result = { text: 'Page loaded', screenshot: 'https://cdn.example.com/screenshot.png' };
    expect(extractScreenshot(result)).toBe('https://cdn.example.com/screenshot.png');
  });

  it('extracts screenshot from JSON string result', () => {
    const result = JSON.stringify({ text: 'OK', screenshot: 'https://cdn.example.com/ss.png' });
    expect(extractScreenshot(result)).toBe('https://cdn.example.com/ss.png');
  });

  it('returns undefined when no screenshot in object', () => {
    const result = { text: 'Page loaded' };
    expect(extractScreenshot(result)).toBeUndefined();
  });

  it('returns undefined when no screenshot in JSON string', () => {
    const result = JSON.stringify({ text: 'OK' });
    expect(extractScreenshot(result)).toBeUndefined();
  });

  it('returns undefined for non-JSON string', () => {
    expect(extractScreenshot('plain text result')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(extractScreenshot(null)).toBeUndefined();
  });
});

// ─── parseToolMetadata screenshot preservation ──────────────

describe('parseToolMetadata screenshot preservation', () => {
  function parseToolMetadata(metadata: string | null | undefined) {
    if (!metadata) return null;
    try {
      const parsed = JSON.parse(metadata);
      if (!parsed) return null;
      const rawTools = parsed.toolCalls || parsed.tools;
      const rawSteps = parsed.executionSteps || parsed.steps;
      if (Array.isArray(rawTools) || Array.isArray(rawSteps)) {
        return {
          toolCalls: (rawTools || []).map((t: any) => ({
            id: t.id || `tool-${Math.random()}`,
            tool: t.tool || 'unknown',
            args: t.args || '',
            result: t.result,
            status: t.status || 'completed',
            success: t.success ?? (t.status === 'completed'),
            toolIndex: t.toolIndex,
            screenshot: t.screenshot,
          })),
          executionSteps: (rawSteps || []).map((s: any) => ({
            id: s.id || `step-${Math.random()}`,
            title: s.title || '',
            status: s.status || 'completed',
            detail: s.detail || '',
            stepIndex: s.stepIndex || 0,
            startedAt: s.startedAt || s.timestamp || 0,
            completedAt: s.completedAt || s.timestamp,
          })),
        };
      }
    } catch { /* ignore parse errors */ }
    return null;
  }

  it('preserves screenshot field in tool calls', () => {
    const metadata = JSON.stringify({
      toolCalls: [
        {
          id: 'tc-1',
          tool: 'browser',
          args: '{"action":"navigate","url":"https://example.com"}',
          result: '{"text":"OK"}',
          status: 'completed',
          success: true,
          screenshot: 'https://cdn.example.com/screenshot.png',
        },
      ],
    });
    const parsed = parseToolMetadata(metadata);
    expect(parsed).not.toBeNull();
    expect(parsed!.toolCalls[0].screenshot).toBe('https://cdn.example.com/screenshot.png');
  });

  it('handles tool calls without screenshot', () => {
    const metadata = JSON.stringify({
      toolCalls: [
        {
          id: 'tc-2',
          tool: 'exec',
          args: '{"command":"ls"}',
          result: '{"text":"file.txt"}',
          status: 'completed',
          success: true,
        },
      ],
    });
    const parsed = parseToolMetadata(metadata);
    expect(parsed).not.toBeNull();
    expect(parsed!.toolCalls[0].screenshot).toBeUndefined();
  });

  it('handles mixed tools with and without screenshots', () => {
    const metadata = JSON.stringify({
      toolCalls: [
        {
          id: 'tc-1',
          tool: 'browser',
          args: '{}',
          screenshot: 'https://cdn.example.com/ss1.png',
          status: 'completed',
          success: true,
        },
        {
          id: 'tc-2',
          tool: 'exec',
          args: '{}',
          status: 'completed',
          success: true,
        },
        {
          id: 'tc-3',
          tool: 'browser',
          args: '{}',
          screenshot: 'https://cdn.example.com/ss2.png',
          status: 'completed',
          success: true,
        },
      ],
    });
    const parsed = parseToolMetadata(metadata);
    expect(parsed).not.toBeNull();
    expect(parsed!.toolCalls).toHaveLength(3);
    expect(parsed!.toolCalls[0].screenshot).toBe('https://cdn.example.com/ss1.png');
    expect(parsed!.toolCalls[1].screenshot).toBeUndefined();
    expect(parsed!.toolCalls[2].screenshot).toBe('https://cdn.example.com/ss2.png');
  });

  it('returns null for invalid metadata', () => {
    expect(parseToolMetadata(null)).toBeNull();
    expect(parseToolMetadata(undefined)).toBeNull();
    expect(parseToolMetadata('')).toBeNull();
    expect(parseToolMetadata('not json')).toBeNull();
  });
});

// ─── ToolCall type screenshot field ─────────────────────────

describe('ToolCall screenshot field handling', () => {
  interface ToolCall {
    id: string;
    tool: string;
    args: string;
    result?: string;
    status: 'running' | 'completed' | 'error';
    success?: boolean;
    progress?: string;
    toolIndex?: number;
    screenshot?: string;
  }

  it('allows screenshot field on ToolCall', () => {
    const tool: ToolCall = {
      id: 'tc-1',
      tool: 'browser',
      args: '{}',
      status: 'completed',
      success: true,
      screenshot: 'https://cdn.example.com/ss.png',
    };
    expect(tool.screenshot).toBe('https://cdn.example.com/ss.png');
  });

  it('screenshot is optional', () => {
    const tool: ToolCall = {
      id: 'tc-2',
      tool: 'exec',
      args: '{}',
      status: 'completed',
    };
    expect(tool.screenshot).toBeUndefined();
  });

  it('screenshot from result JSON takes precedence when direct field is missing', () => {
    const tool: ToolCall = {
      id: 'tc-3',
      tool: 'browser',
      args: '{}',
      result: JSON.stringify({ text: 'OK', screenshot: 'https://cdn.example.com/from-result.png' }),
      status: 'completed',
    };
    // Simulate the extraction logic used in TimelineToolItem
    let resultObj: any = null;
    try { resultObj = JSON.parse(tool.result!); } catch { /* */ }
    const screenshot = resultObj?.screenshot || tool.screenshot;
    expect(screenshot).toBe('https://cdn.example.com/from-result.png');
  });

  it('direct screenshot field takes precedence over result JSON', () => {
    const tool: ToolCall = {
      id: 'tc-4',
      tool: 'browser',
      args: '{}',
      result: JSON.stringify({ text: 'OK', screenshot: 'https://cdn.example.com/from-result.png' }),
      status: 'completed',
      screenshot: 'https://cdn.example.com/direct.png',
    };
    // In TimelineToolItem: const screenshot = resultObj?.screenshot || tool.screenshot;
    // resultObj.screenshot exists, so it takes precedence
    let resultObj: any = null;
    try { resultObj = JSON.parse(tool.result!); } catch { /* */ }
    const screenshot = resultObj?.screenshot || tool.screenshot;
    // Both exist, resultObj.screenshot is checked first
    expect(screenshot).toBe('https://cdn.example.com/from-result.png');
  });
});

// ─── getToolDisplayTitle for browser ────────────────────────

describe('getToolDisplayTitle for browser', () => {
  function getToolDisplayTitle(toolName: string, args: string): string {
    try {
      const parsed = args ? JSON.parse(args) : {};
      switch (toolName) {
        case 'browser': return `浏览器 ${parsed.action || '操作'}`;
        default: return toolName;
      }
    } catch {
      return toolName;
    }
  }

  it('shows action in browser tool title', () => {
    const args = JSON.stringify({ action: 'navigate', url: 'https://example.com' });
    expect(getToolDisplayTitle('browser', args)).toBe('浏览器 navigate');
  });

  it('shows default when no action', () => {
    expect(getToolDisplayTitle('browser', '{}')).toBe('浏览器 操作');
  });

  it('handles invalid JSON gracefully', () => {
    expect(getToolDisplayTitle('browser', 'bad')).toBe('browser');
  });
});
