/**
 * Test: handleSend DOM value fallback logic (v2.2)
 * 
 * When React state hasn't synced yet (e.g., automated input tools set DOM value
 * but React onChange hasn't fired), handleSend should use the longer of
 * DOM value vs React state to prevent truncation.
 */
import { describe, it, expect } from 'vitest';

describe('MessageInput DOM fallback logic', () => {
  // Simulate the core logic from handleSend v2.2
  function getEffectiveInput(reactState: string, domValue: string): string {
    return domValue.length > reactState.length ? domValue : reactState;
  }

  it('uses React state when DOM and state are identical', () => {
    const state = 'Hello world';
    const dom = 'Hello world';
    expect(getEffectiveInput(state, dom)).toBe('Hello world');
  });

  it('uses DOM value when it is longer than React state (truncation scenario)', () => {
    const state = 'First line only';  // React state only captured first line
    const dom = 'First line only\nSecond line\nThird line';  // DOM has full content
    const result = getEffectiveInput(state, dom);
    expect(result).toBe(dom);
    expect(result).toContain('Second line');
    expect(result).toContain('Third line');
  });

  it('uses React state when DOM is empty (normal clear scenario)', () => {
    const state = 'Some text';
    const dom = '';
    expect(getEffectiveInput(state, dom)).toBe('Some text');
  });

  it('uses DOM value for multiline content when state has only title', () => {
    const state = 'Lesson 15 Task 1: 前端文件修改练习';
    const dom = 'Lesson 15 Task 1: 前端文件修改练习\n\n请修改 /var/www/rangerai1/public/src/components/chat/ModelSelector.tsx 文件';
    const result = getEffectiveInput(state, dom);
    expect(result).toBe(dom);
    expect(result.split('\n').length).toBeGreaterThan(1);
  });

  it('handles both empty gracefully', () => {
    expect(getEffectiveInput('', '')).toBe('');
  });

  it('uses React state when it is longer (normal typing scenario)', () => {
    const state = 'User typed a long message here';
    const dom = 'User typed';  // DOM might lag behind
    expect(getEffectiveInput(state, dom)).toBe(state);
  });
});
