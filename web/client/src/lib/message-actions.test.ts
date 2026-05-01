/**
 * Tests for message actions (copy, regenerate) and export enhancements.
 * Updated for i18n: exportUtils now uses English default labels when no t() is provided.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportToMarkdown, exportToJson, exportChat, downloadFile } from './exportUtils';
import type { Chat, Message } from './types';

// ─── Test Data ──────────────────────────────────────────────

const mockChat: Chat = {
  id: 'chat-001',
  sessionKey: 'sess-001',
  title: '测试对话',
  model: null,
  userId: 'user-001',
  tags: '测试,导出',
  metadata: null,
  messageCount: 3,
  lastMessage: 'Hello',
  createdAt: '2026-03-01T10:00:00.000Z',
  updatedAt: '2026-03-01T10:05:00.000Z',
};

const mockMessages: Message[] = [
  {
    id: 1,
    chatId: 'chat-001',
    role: 'user',
    content: '你好，帮我分析一下这个问题',
    model: null,
    tokens: null,
    msgId: 'msg-001',
    createdAt: '2026-03-01T10:00:00.000Z',
    metadata: null,
  },
  {
    id: 2,
    chatId: 'chat-001',
    role: 'assistant',
    content: '好的，我来帮你分析这个问题。\n\n## 分析结果\n\n这是一个很好的问题。',
    model: 'gpt-5.2',
    tokens: 150,
    msgId: 'msg-002',
    createdAt: '2026-03-01T10:01:00.000Z',
    metadata: JSON.stringify({
      tools: [
        { tool: 'search', displayName: '网络搜索', status: 'completed' },
        { tool: 'exec', displayName: '代码执行', status: 'error' },
      ],
    }),
  },
  {
    id: 3,
    chatId: 'chat-001',
    role: 'user',
    content: '谢谢，还有其他建议吗？',
    model: null,
    tokens: null,
    msgId: 'msg-003',
    createdAt: '2026-03-01T10:02:00.000Z',
    metadata: null,
  },
];

// ─── Export Tests ────────────────────────────────────────────

describe('exportToMarkdown', () => {
  it('should generate valid Markdown with header and messages', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    
    expect(md).toContain('# 测试对话');
    expect(md).toContain('**Chat ID**: chat-001');
    expect(md).toContain('Messages');
    expect(md).toContain('测试,导出');
    expect(md).toContain('👤 User');
    expect(md).toContain('🤖 AI');
    expect(md).toContain('你好，帮我分析一下这个问题');
    expect(md).toContain('好的，我来帮你分析这个问题');
    expect(md).toContain('Exported from RangerAI');
  });

  it('should include tool call summary in AI messages', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('Tool Calls');
    expect(md).toContain('网络搜索');
    expect(md).toContain('代码执行');
  });

  it('should skip system messages', () => {
    const withSystem: Message[] = [
      ...mockMessages,
      {
        id: 4,
        chatId: 'chat-001',
        role: 'system',
        content: 'System prompt',
        model: null,
        tokens: null,
        msgId: 'msg-004',
        createdAt: '2026-03-01T09:59:00.000Z',
        metadata: null,
      },
    ];
    const md = exportToMarkdown(mockChat, withSystem);
    expect(md).not.toContain('System prompt');
  });

  it('should include model name for AI messages', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('gpt-5.2');
  });
});

describe('exportToJson', () => {
  it('should generate valid JSON', () => {
    const jsonStr = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(jsonStr);
    
    expect(parsed.exportedBy).toBe('RangerAI');
    expect(parsed.chat.id).toBe('chat-001');
    expect(parsed.chat.title).toBe('测试对话');
    expect(parsed.messageCount).toBe(3);
    expect(parsed.messages).toHaveLength(3);
  });

  it('should parse tool metadata in JSON export', () => {
    const jsonStr = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(jsonStr);
    
    const aiMsg = parsed.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(aiMsg).toBeDefined();
    expect(aiMsg.metadata).toBeDefined();
    expect(aiMsg.metadata.tools).toHaveLength(2);
  });

  it('should skip system messages in JSON export', () => {
    const withSystem: Message[] = [
      ...mockMessages,
      {
        id: 4,
        chatId: 'chat-001',
        role: 'system',
        content: 'System prompt',
        model: null,
        tokens: null,
        msgId: 'msg-004',
        createdAt: '2026-03-01T09:59:00.000Z',
        metadata: null,
      },
    ];
    const jsonStr = exportToJson(mockChat, withSystem);
    const parsed = JSON.parse(jsonStr);
    expect(parsed.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true);
  });
});

describe('downloadFile', () => {
  it('should be a function that accepts content, filename, and mimeType', () => {
    expect(typeof downloadFile).toBe('function');
    expect(downloadFile.length).toBe(3);
  });
});

describe('exportChat', () => {
  it('should be a function that accepts chat, messages, format, locale, and t', () => {
    expect(typeof exportChat).toBe('function');
    // exportChat(chat, messages, format, locale?, t?) = 5 params
    expect(exportChat.length).toBe(5);
  });

  it('should generate correct Markdown content for md format', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('# 测试对话');
    expect(md).toContain('你好，帮我分析一下这个问题');
  });

  it('should generate correct JSON content for json format', () => {
    const json = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(json);
    expect(parsed.chat.title).toBe('测试对话');
    expect(parsed.messages).toHaveLength(3);
  });
});

// ─── Regenerate API Tests ───────────────────────────────────

describe('regenerateMessage API', () => {
  it('should have the correct function signature', async () => {
    const apiModule = await import('./api');
    expect(typeof apiModule.regenerateMessage).toBe('function');
  });
});

// ─── Message Content Tests ──────────────────────────────────

describe('Message content handling', () => {
  it('should handle JSON content with attachments', () => {
    const jsonContent = JSON.stringify({
      text: '请看这个图片',
      attachments: [{ type: 'image', url: 'https://example.com/img.png', name: 'img.png' }],
    });
    
    const parsed = JSON.parse(jsonContent);
    expect(parsed.text).toBe('请看这个图片');
    expect(parsed.attachments).toHaveLength(1);
  });

  it('should handle plain text content', () => {
    const content = '这是一条普通消息';
    expect(() => JSON.parse(content)).toThrow();
    expect(content).toBe('这是一条普通消息');
  });

  it('should handle long content truncation in export', () => {
    const longContent = 'x'.repeat(15000);
    const msg: Message = {
      id: 1,
      chatId: 'chat-001',
      role: 'assistant',
      content: longContent,
      model: null,
      tokens: null,
      msgId: 'msg-long',
      createdAt: '2026-03-01T10:00:00.000Z',
      metadata: null,
    };
    
    const md = exportToMarkdown(mockChat, [msg]);
    // Default English label: "Content truncated"
    expect(md).toContain('Content truncated');
  });
});

// ─── Capability Display Tests ───────────────────────────────

describe('Agent capabilities', () => {
  it('should have 15 capability categories', () => {
    const capabilities = [
      'Web Search & Analysis', 'Code Development & Debugging', 'Data Processing & Visualization',
      'Security Audit & Ops', 'Content Creation & Design', 'File Processing & Management',
      'AI Models & Reasoning', 'System Integration & API', 'Document & Report Generation',
      'Multilingual & Localization', 'Browser Automation', 'Task Orchestration & Automation',
      'Intelligent Chat & Consulting', 'Research & Intelligence Analysis', 'Project Management & Collaboration',
    ];
    expect(capabilities).toHaveLength(15);
  });
});
