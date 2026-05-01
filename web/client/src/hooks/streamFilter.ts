/**
 * streamFilter — Frontend streaming content filter for RangerAI
 *
 * Extracted from useChatStore.tsx (Phase 1: Pure function extraction).
 * This is the SECOND defense layer; the backend stream-processor does heavy filtering.
 * System directives and non-text content markers are stripped before rendering.
 *
 * v2: Simplified — no buffering, only filter system directive lines.
 * The old version had a pendingBuffer that caused massive Chinese content loss
 * because LLM streaming deltas rarely contain newlines.
 */

const SYSTEM_PATTERNS: RegExp[] = [
  /^\[SYSTEM_DIRECTIVE\]/,
  /^\[SYSTEM_FORCE\]/,
  /^\[HIDDEN\]/,
  /^\[non-text content:[^\]]*\]/i,
  /^Assistant:\s*\[non-text content/i,
];

export interface StreamFilter {
  filter(delta: string): string;
  flush(): string;
  reset(): void;
}

export function createFrontendStreamFilter(): StreamFilter {
  function filter(delta: string): string {
    if (!delta) return '';

    // If delta contains newlines, check each line for system directives
    if (delta.includes('\n')) {
      const lines = delta.split('\n');
      const cleanLines: string[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        let isSystem = false;
        for (const pat of SYSTEM_PATTERNS) {
          if (pat.test(trimmed)) {
            isSystem = true;
            break;
          }
        }
        if (!isSystem) cleanLines.push(line);
      }
      return cleanLines.join('\n');
    }

    // Single-line delta: check if it starts with system directive
    const trimmed = delta.trim();
    for (const pat of SYSTEM_PATTERNS) {
      if (pat.test(trimmed)) return '';
    }

    // Normal content passes through directly — no buffering!
    return delta;
  }

  function flush(): string {
    return '';
  }

  function reset(): void {
    /* no buffer to reset in v2 */
  }

  return { filter, flush, reset };
}

let _streamFilter: StreamFilter | null = null;

export function getStreamFilter(): StreamFilter {
  if (!_streamFilter) _streamFilter = createFrontendStreamFilter();
  return _streamFilter;
}
