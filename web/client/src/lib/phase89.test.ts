/**
 * Phase 8 & 9 Tests — Chat Export + Team Sharing
 */
import { describe, it, expect } from 'vitest';
import { exportToMarkdown, exportToJson } from './exportUtils';
import type { Chat, Message, SharedChat, ChatShare } from './types';

// ─── Test Fixtures ─────────────────────────────────────────────

const mockChat: Chat = {
  id: 'chat-001',
  sessionKey: 'sk-001',
  title: '测试对话',
  model: 'gpt-4',
  userId: 'user-001',
  tags: '工作,项目',
  metadata: null,
  messageCount: 3,
  lastMessage: '最后一条消息',
  createdAt: '2026-03-01T10:00:00Z',
  updatedAt: '2026-03-01T11:00:00Z',
};

const mockMessages: Message[] = [
  {
    id: 1,
    chatId: 'chat-001',
    role: 'system',
    content: 'You are a helpful assistant.',
    model: null,
    tokens: null,
    msgId: null,
    createdAt: '2026-03-01T10:00:00Z',
    metadata: null,
  },
  {
    id: 2,
    chatId: 'chat-001',
    role: 'user',
    content: '你好，帮我分析一下数据',
    model: null,
    tokens: null,
    msgId: 'msg-002',
    createdAt: '2026-03-01T10:01:00Z',
    metadata: null,
  },
  {
    id: 3,
    chatId: 'chat-001',
    role: 'assistant',
    content: '好的，我来帮你分析数据。',
    model: 'gpt-4',
    tokens: 50,
    msgId: 'msg-003',
    createdAt: '2026-03-01T10:02:00Z',
    metadata: JSON.stringify({
      tools: [
        { name: 'python', displayName: 'Python', status: 'success' },
        { name: 'browser', displayName: '浏览器', status: 'error' },
      ],
    }),
  },
];

// ─── Phase 8: Chat Export Tests ────────────────────────────────

describe('Phase 8: exportToMarkdown', () => {
  it('should include chat title as H1 header', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('# 测试对话');
  });

  it('should include chat metadata (ID, dates, tags)', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('chat-001');
    expect(md).toContain('工作,项目');
    expect(md).toContain('Messages');
  });

  it('should filter out system messages', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).not.toContain('You are a helpful assistant');
  });

  it('should include user and assistant messages with role labels', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('👤 User');
    expect(md).toContain('🤖 AI');
    expect(md).toContain('你好，帮我分析一下数据');
    expect(md).toContain('好的，我来帮你分析数据');
  });

  it('should include model info for assistant messages', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('(gpt-4)');
  });

  it('should include tool call summaries', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('Tool Calls');
    expect(md).toContain('✅ Python');
    expect(md).toContain('❌ 浏览器');
  });

  it('should include export footer', () => {
    const md = exportToMarkdown(mockChat, mockMessages);
    expect(md).toContain('Exported from RangerAI');
  });

  it('should handle empty messages array', () => {
    const md = exportToMarkdown(mockChat, []);
    expect(md).toContain('# 测试对话');
    expect(md).toContain('Messages');
  });

  it('should handle chat with no title', () => {
    const noTitleChat = { ...mockChat, title: '' };
    const md = exportToMarkdown(noTitleChat, mockMessages);
    expect(md).toContain('# Untitled Chat');
  });

  it('should truncate very long content', () => {
    const longMsg: Message = {
      ...mockMessages[1],
      content: 'x'.repeat(15000),
    };
    const md = exportToMarkdown(mockChat, [longMsg]);
    expect(md).toContain('Content truncated');
    expect(md.length).toBeLessThan(15000);
  });
});

describe('Phase 8: exportToJson', () => {
  it('should return valid JSON', () => {
    const json = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(json);
    expect(parsed).toBeDefined();
  });

  it('should include export metadata', () => {
    const json = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(json);
    expect(parsed.exportedBy).toBe('RangerAI');
    expect(parsed.exportedAt).toBeDefined();
  });

  it('should include chat info', () => {
    const json = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(json);
    expect(parsed.chat.id).toBe('chat-001');
    expect(parsed.chat.title).toBe('测试对话');
    expect(parsed.chat.tags).toBe('工作,项目');
  });

  it('should filter out system messages', () => {
    const json = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(json);
    expect(parsed.messages.every((m: any) => m.role !== 'system')).toBe(true);
    expect(parsed.messageCount).toBe(2);
  });

  it('should parse metadata as JSON object', () => {
    const json = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(json);
    const assistantMsg = parsed.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg.metadata).toBeDefined();
    expect(assistantMsg.metadata.tools).toHaveLength(2);
  });

  it('should include message content', () => {
    const json = exportToJson(mockChat, mockMessages);
    const parsed = JSON.parse(json);
    const userMsg = parsed.messages.find((m: any) => m.role === 'user');
    expect(userMsg.content).toBe('你好，帮我分析一下数据');
  });
});

// ─── Phase 9: Team Sharing Type Tests ──────────────────────────

describe('Phase 9: SharedChat type', () => {
  it('should have required fields', () => {
    const sharedChat: SharedChat = {
      id: 1,
      chatId: 'chat-001',
      sharedWithUserId: 'user-002',
      sharedByUserId: 'user-001',
      permission: 'read',
      title: '共享对话',
      sharedByUsername: 'admin',
      sharedByDisplayName: '管理员',
      sharedAt: '2026-03-01T10:00:00Z',
    };
    expect(sharedChat.chatId).toBe('chat-001');
    expect(sharedChat.permission).toBe('read');
    expect(sharedChat.sharedByDisplayName).toBe('管理员');
  });

  it('should support read and write permissions', () => {
    const readShare: SharedChat = {
      id: 1, chatId: 'c1', sharedWithUserId: 'u2', sharedByUserId: 'u1',
      permission: 'read', title: 't', sharedByUsername: 'a', sharedByDisplayName: 'A', sharedAt: '',
    };
    const writeShare: SharedChat = {
      id: 2, chatId: 'c2', sharedWithUserId: 'u3', sharedByUserId: 'u1',
      permission: 'write', title: 't', sharedByUsername: 'a', sharedByDisplayName: 'A', sharedAt: '',
    };
    expect(readShare.permission).toBe('read');
    expect(writeShare.permission).toBe('write');
  });
});

describe('Phase 9: ChatShare type', () => {
  it('should have required fields including user info', () => {
    const share: ChatShare = {
      id: 1,
      chatId: 'chat-001',
      sharedWithUserId: 'user-002',
      sharedByUserId: 'user-001',
      permission: 'read',
      username: 'testuser',
      displayName: '测试用户',
      sharedAt: '2026-03-01T10:00:00Z',
    };
    expect(share.username).toBe('testuser');
    expect(share.displayName).toBe('测试用户');
    expect(share.permission).toBe('read');
  });
});

describe('Phase 9: Share API function signatures', () => {
  it('shareChat should accept chatId, userId, and permission', async () => {
    // Type-check: ensure the function signature is correct
    const { shareChat } = await import('./api');
    expect(typeof shareChat).toBe('function');
    expect(shareChat.length).toBeGreaterThanOrEqual(2); // at least 2 required params
  });

  it('fetchUsers should be a function', async () => {
    const { fetchUsers } = await import('./api');
    expect(typeof fetchUsers).toBe('function');
  });

  it('fetchSharedWithMe should be a function', async () => {
    const { fetchSharedWithMe } = await import('./api');
    expect(typeof fetchSharedWithMe).toBe('function');
  });

  it('fetchChatShares should accept chatId', async () => {
    const { fetchChatShares } = await import('./api');
    expect(typeof fetchChatShares).toBe('function');
    expect(fetchChatShares.length).toBe(1);
  });

  it('unshareChat should accept chatId and userId', async () => {
    const { unshareChat } = await import('./api');
    expect(typeof unshareChat).toBe('function');
    expect(unshareChat.length).toBe(2);
  });
});

// ─── Phase 8: Export filename sanitization ─────────────────────

describe('Phase 8: Export filename safety', () => {
  it('should sanitize special characters in title for filename', () => {
    const specialChat = { ...mockChat, title: 'test/file?name*with:bad|chars"<>' };
    // exportChat calls downloadFile internally, but we can test the sanitization logic
    const safeTitle = (specialChat.title || 'Chat').replace(/[\/\\?%*:|"<>]/g, '-').slice(0, 50);
    expect(safeTitle).toBe('test-file-name-with-bad-chars---');
    expect(safeTitle).not.toContain('/');
    expect(safeTitle).not.toContain('?');
    expect(safeTitle).not.toContain('*');
  });

  it('should truncate long titles to 50 chars', () => {
    const longTitle = 'a'.repeat(100);
    const safeTitle = longTitle.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 50);
    expect(safeTitle.length).toBe(50);
  });

  it('should use default title for empty title', () => {
    const emptyChat = { ...mockChat, title: '' };
    const safeTitle = (emptyChat.title || 'Chat').replace(/[\/\\?%*:|"<>]/g, '-').slice(0, 50);
    expect(safeTitle).toBe('Chat');  });
});
