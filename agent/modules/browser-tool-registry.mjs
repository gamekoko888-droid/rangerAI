// modules/browser-tool-registry.mjs — Register browser tools into tool-orchestrator
// Q7: Maps browser_* tool names to browser-service.mjs functions
// This module is imported by the tool execution path to handle browser tool calls
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// Lazy-load browser service
let _svc = null;
async function svc() {
  if (!_svc) {
    _svc = await import('../worker/browser-service.mjs');
  }
  return _svc;
}

/**
 * Browser tool name → handler mapping.
 * Each handler accepts (args, context) and returns a result object.
 */
export const BROWSER_TOOL_HANDLERS = {
  browser_navigate: async (args, ctx) => {
    const s = await svc();
    return s.browserNavigate({ url: args.url, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_screenshot: async (args, ctx) => {
    const s = await svc();
    return s.browserScreenshot({ url: args.url, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_click: async (args, ctx) => {
    const s = await svc();
    return s.browserClick({ selector: args.selector, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_type: async (args, ctx) => {
    const s = await svc();
    return s.browserType({ selector: args.selector, text: args.text, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_extract_text: async (args, ctx) => {
    const s = await svc();
    return s.browserExtractText({ selector: args.selector, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_fill_form: async (args, ctx) => {
    const s = await svc();
    return s.browserFillForm({ fields: args.fields, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_select: async (args, ctx) => {
    const s = await svc();
    return s.browserSelect({ selector: args.selector, value: args.value, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_hover: async (args, ctx) => {
    const s = await svc();
    return s.browserHover({ selector: args.selector, sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_get_cookies: async (args, ctx) => {
    const s = await svc();
    return s.browserGetCookies({ sessionKey: ctx?.sessionKey || 'default' });
  },
  browser_set_cookies: async (args, ctx) => {
    const s = await svc();
    return s.browserSetCookies({ cookies: args.cookies, sessionKey: ctx?.sessionKey || 'default' });
  },
};

/**
 * Check if a tool name is a browser tool.
 */
export function isBrowserTool(toolName) {
  return toolName in BROWSER_TOOL_HANDLERS;
}

/**
 * Execute a browser tool by name.
 * @param {string} toolName - e.g. "browser_navigate"
 * @param {Object} args - Tool arguments
 * @param {Object} context - Execution context (sessionKey, etc.)
 * @returns {Promise<Object>} Tool result
 */
export async function executeBrowserTool(toolName, args, context = {}) {
  const handler = BROWSER_TOOL_HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown browser tool: ${toolName}`);
  }
  const startTime = Date.now();
  try {
    const result = await handler(args, context);
    const duration = Date.now() - startTime;
    logger.info(`[${ts()}] [browser-tool] ${toolName} completed in ${duration}ms`);
    return { success: true, result, durationMs: duration };
  } catch (e) {
    const duration = Date.now() - startTime;
    logger.error(`[${ts()}] [browser-tool] ${toolName} failed after ${duration}ms: ${e.message}`);
    return { success: false, error: e.message, durationMs: duration };
  }
}

// File tool handlers (delegates to file-tools.mjs)
let _fileTools = null;
async function getFileTools() {
  if (!_fileTools) {
    _fileTools = await import('../worker/file-tools.mjs');
  }
  return _fileTools;
}

export const FILE_TOOL_HANDLERS = {
  file_read: async (args, ctx) => {
    const ft = await getFileTools();
    return ft.fileRead({ path: args.path, sessionKey: ctx?.sessionKey });
  },
  file_write: async (args, ctx) => {
    const ft = await getFileTools();
    return ft.fileWrite({ path: args.path, content: args.content, sessionKey: ctx?.sessionKey });
  },
  file_append: async (args, ctx) => {
    const ft = await getFileTools();
    return ft.fileAppend({ path: args.path, content: args.content, sessionKey: ctx?.sessionKey });
  },
  file_edit: async (args, ctx) => {
    const ft = await getFileTools();
    return ft.fileEdit({ path: args.path, edits: args.edits, sessionKey: ctx?.sessionKey });
  },
  file_list: async (args, ctx) => {
    const ft = await getFileTools();
    return ft.fileList({ path: args.path, recursive: args.recursive, sessionKey: ctx?.sessionKey });
  },
  file_grep: async (args, ctx) => {
    const ft = await getFileTools();
    return ft.fileGrep({ pattern: args.pattern, path: args.path, sessionKey: ctx?.sessionKey });
  },
  file_delete: async (args, ctx) => {
    const ft = await getFileTools();
    return ft.fileDelete({ path: args.path, sessionKey: ctx?.sessionKey });
  },
};

export function isFileTool(toolName) {
  return toolName in FILE_TOOL_HANDLERS;
}

export async function executeFileTool(toolName, args, context = {}) {
  const handler = FILE_TOOL_HANDLERS[toolName];
  if (!handler) {
    throw new Error(`Unknown file tool: ${toolName}`);
  }
  const startTime = Date.now();
  try {
    const result = await handler(args, context);
    const duration = Date.now() - startTime;
    logger.info(`[${ts()}] [file-tool] ${toolName} completed in ${duration}ms`);
    return { success: true, result, durationMs: duration };
  } catch (e) {
    const duration = Date.now() - startTime;
    logger.error(`[${ts()}] [file-tool] ${toolName} failed after ${duration}ms: ${e.message}`);
    return { success: false, error: e.message, durationMs: duration };
  }
}
