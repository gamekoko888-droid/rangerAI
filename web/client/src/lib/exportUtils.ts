/**
 * exportUtils — Chat export utilities for Markdown and JSON formats.
 * Generates downloadable files from chat messages, including tool call summaries.
 */

import type { Message, Chat } from './types';
import type { TranslationKeys } from './i18n';

type TFn = (key: keyof TranslationKeys) => string;

// Fallback labels when no translation function is provided
const defaultLabels = {
  toolCalls: 'Tool Calls',
  user: 'User',
  ai: 'AI',
  system: 'System',
  truncated: 'Content truncated',
  untitled: 'Untitled Chat',
  chatId: 'Chat ID',
  createdAt: 'Created',
  updatedAt: 'Updated',
  msgCount: 'Messages',
  tags: 'Tags',
  exportFrom: 'Exported from RangerAI',
  chat: 'Chat',
};

// ─── Markdown Export ────────────────────────────────────────

/**
 * Parse tool metadata from a message's metadata field.
 * Returns a human-readable summary of tool calls.
 */
function parseToolSummary(metadata: string | null, t?: TFn): string {
  if (!metadata) return '';
  try {
    const parsed = JSON.parse(metadata);
    const tools = parsed.tools || parsed.activeTools;
    if (!Array.isArray(tools) || tools.length === 0) return '';

    const summaries = tools.map((tc: any) => {
      const name = tc.displayName || tc.name || tc.tool || 'unknown';
      const status = tc.status === 'error' ? '❌' : '✅';
      return `${status} ${name}`;
    });
    const label = t ? t('export.toolCalls') : defaultLabels.toolCalls;
    return `\n> ${label}: ${summaries.join(' · ')}\n`;
  } catch {
    return '';
  }
}

/**
 * Format a single message to Markdown.
 */
function formatMessageToMd(msg: Message, locale: string, t?: TFn): string {
  const userLabel = t ? `👤 ${t('chat.user' as keyof TranslationKeys)}` : `👤 ${defaultLabels.user}`;
  const aiLabel = t ? `🤖 ${t('chat.ai' as keyof TranslationKeys)}` : `🤖 ${defaultLabels.ai}`;
  const sysLabel = t ? `⚙️ ${t('chat.system' as keyof TranslationKeys)}` : `⚙️ ${defaultLabels.system}`;
  const roleLabel = msg.role === 'user' ? userLabel : msg.role === 'assistant' ? aiLabel : sysLabel;
  const time = new Date(msg.createdAt).toLocaleString(locale, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const model = msg.model ? ` (${msg.model})` : '';
  const toolSummary = parseToolSummary(msg.metadata, t);

  let content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  // Trim very long content
  if (content.length > 10000) {
    content = content.slice(0, 10000) + '\n\n... (' + (t ? t('export.detail') : defaultLabels.truncated) + ')';
  }

  return `### ${roleLabel}${model}\n*${time}*\n\n${content}\n${toolSummary}`;
}

/**
 * Export a chat to Markdown format.
 */
export function exportToMarkdown(chat: Chat, messages: Message[], locale?: string, t?: TFn): string {
  const loc = locale || 'zh-CN';
  const header = [
    `# ${chat.title || (t ? t('export.mdTitle') : defaultLabels.untitled)}`,
    '',
    `- **${t ? t('export.detail') : defaultLabels.chatId}**: ${chat.id}`,
    `- **${t ? t('export.status') : defaultLabels.createdAt}**: ${new Date(chat.createdAt).toLocaleString(loc)}`,
    `- **${t ? t('export.status') : defaultLabels.updatedAt}**: ${new Date(chat.updatedAt).toLocaleString(loc)}`,
    `- **${t ? t('export.steps') : defaultLabels.msgCount}**: ${messages.length}`,
    chat.tags ? `- **${t ? t('export.status') : defaultLabels.tags}**: ${chat.tags}` : '',
    '',
    '---',
    '',
  ].filter(Boolean).join('\n');

  const body = messages
    .filter(m => m.role !== 'system') // Skip system messages
    .map(m => formatMessageToMd(m, loc, t))
    .join('\n\n---\n\n');

  const footer = [
    '',
    '---',
    '',
    `*${t ? t('export.mdTitle') : defaultLabels.exportFrom} · ${new Date().toLocaleString(loc)}*`,
  ].join('\n');

  return header + body + footer;
}

// ─── JSON Export ────────────────────────────────────────────

/**
 * Export a chat to JSON format.
 */
export function exportToJson(chat: Chat, messages: Message[]): string {
  const exportData = {
    exportedAt: new Date().toISOString(),
    exportedBy: 'RangerAI',
    chat: {
      id: chat.id,
      title: chat.title,
      tags: chat.tags,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    },
    messages: messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        model: m.model,
        createdAt: m.createdAt,
        metadata: m.metadata ? (() => { try { return JSON.parse(m.metadata!); } catch { return m.metadata; } })() : null,
      })),
    messageCount: messages.filter(m => m.role !== 'system').length,
  };

  return JSON.stringify(exportData, null, 2);
}

// ─── Download Trigger ───────────────────────────────────────

/**
 * Trigger a file download in the browser.
 */
export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export and download a chat in the specified format.
 */
export function exportChat(chat: Chat, messages: Message[], format: 'md' | 'json', locale?: string, t?: TFn) {
  const safeTitle = (chat.title || (t ? t('export.mdTitle') : 'Chat')).replace(/[/\\?%*:|"<>]/g, '-').slice(0, 50);
  const dateStr = new Date().toISOString().slice(0, 10);

  if (format === 'md') {
    const content = exportToMarkdown(chat, messages, locale, t);
    downloadFile(content, `${safeTitle}_${dateStr}.md`, 'text/markdown;charset=utf-8');
  } else {
    const content = exportToJson(chat, messages);
    downloadFile(content, `${safeTitle}_${dateStr}.json`, 'application/json;charset=utf-8');
  }
}
