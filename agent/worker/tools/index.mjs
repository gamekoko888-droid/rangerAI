/**
 * Iter-A: Unified Tool Registry
 * 
 * Central repository for all tools used by RangerAI Agent.
 * Features:
 * - Unified tool metadata (name, description, category, permissions)
 * - maxResultSizeChars: Infinity for file_read (never truncate)
 * - Tool classification (READONLY, STATE_MUTATING, CRITICAL)
 * - Integration with Iter-B permission chain
 * 
 * Usage:
 *   import { getToolRegistry, getTool, getAllTools } from './tools/index.mjs';
 *   const registry = getToolRegistry();
 *   const fileTool = getTool('file_read');
 */

// ─── Tool Categories ───
export const TOOL_CATEGORIES = {
  READONLY: 'readonly',           // Read-only operations (file_read, grep, web_search)
  STATE_MUTATING: 'state_mutating', // Write operations (write_file, edit_file, exec)
  CRITICAL: 'critical',           // Dangerous operations (rm -rf, DROP TABLE)
};

// ─── Tool Registry ───
// Central definition of all tools
const TOOL_REGISTRY = {
  // ─── Read-only Tools (READONLY) ───
  file_read: {
    name: 'file_read',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Read file contents',
    maxResultSizeChars: Infinity,  // Never truncate file_read results
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      range: { type: 'array', required: false, description: '[start, end] line numbers' },
    },
    permissionTier: 'readonly',
  },

  read_file: {
    name: 'read_file',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Read file contents (alias)',
    maxResultSizeChars: Infinity,
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
    },
    permissionTier: 'readonly',
  },

  grep: {
    name: 'grep',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Search text in files',
    maxResultSizeChars: Infinity,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Regex pattern' },
      scope: { type: 'string', required: true, description: 'File glob pattern' },
    },
    permissionTier: 'readonly',
  },

  glob: {
    name: 'glob',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Find files matching pattern',
    maxResultSizeChars: Infinity,
    parameters: {
      pattern: { type: 'string', required: true, description: 'Glob pattern' },
    },
    permissionTier: 'readonly',
  },

  find: {
    name: 'find',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Find files by name/path',
    maxResultSizeChars: Infinity,
    parameters: {
      path: { type: 'string', required: true, description: 'Search path' },
      name: { type: 'string', required: false, description: 'File name pattern' },
    },
    permissionTier: 'readonly',
  },

  web_search: {
    name: 'web_search',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Search the web',
    maxResultSizeChars: 50000,  // Web search results are typically large
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
    },
    permissionTier: 'readonly',
  },

  web_fetch: {
    name: 'web_fetch',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Fetch web page content',
    maxResultSizeChars: 100000,
    parameters: {
      url: { type: 'string', required: true, description: 'URL to fetch' },
    },
    permissionTier: 'readonly',
  },

  memory_search: {
    name: 'memory_search',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Search memory/knowledge base',
    maxResultSizeChars: 50000,
    parameters: {
      query: { type: 'string', required: true, description: 'Search query' },
    },
    permissionTier: 'readonly',
  },

  memory_get: {
    name: 'memory_get',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Get memory entry',
    maxResultSizeChars: Infinity,
    parameters: {
      id: { type: 'string', required: true, description: 'Memory ID' },
    },
    permissionTier: 'readonly',
  },

  image: {
    name: 'image',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Generate or analyze images',
    maxResultSizeChars: 10000,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Image prompt' },
    },
    permissionTier: 'readonly',
  },

  // ─── [R35-T1] Vision / Image Analysis ─────────────────────────
  analyze_image: {
    name: "analyze_image",
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: "Vision: analyze and understand images using GPT-4o Vision API",
    maxResultSizeChars: 20000,
    parameters: {
      image_url: { type: "string", required: true, description: "Image URL (http/https) or local file path" },
      question: { type: "string", required: false, description: "Specific question about the image" },
      detail: { type: "string", required: false, description: "Detail level: auto, low, high" },
    },
    permissionTier: "standard",
  },
  speak_text: {
    name: "speak_text",
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: "Text-to-Speech: convert text to audio using OpenAI TTS API",
    maxResultSizeChars: 10000,
    parameters: {
      text: { type: "string", required: true, description: "Text to convert to speech" },
      voice: { type: "string", required: false, description: "Voice: alloy, echo, fable, onyx, nova, shimmer" },
      model: { type: "string", required: false, description: "Model: tts-1 or tts-1-hd" },
    },
    permissionTier: "standard",
  },
  canvas: {
    name: 'canvas',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Render visual content',
    maxResultSizeChars: 10000,
    parameters: {
      content: { type: 'string', required: true, description: 'Canvas content' },
    },
    permissionTier: 'readonly',
  },

  code: {
    name: 'code',
    category: TOOL_CATEGORIES.READONLY,
    description: 'Execute code and get results',
    maxResultSizeChars: 50000,
    parameters: {
      language: { type: 'string', required: true, description: 'Programming language' },
      code: { type: 'string', required: true, description: 'Code to execute' },
    },
    permissionTier: 'readonly',
  },

  // ─── State-Mutating Tools (STATE_MUTATING) ───
  write_file: {
    name: 'write_file',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Write or create file',
    maxResultSizeChars: 5000,
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      content: { type: 'string', required: true, description: 'File content' },
    },
    permissionTier: 'high',
  },

  write: {
    name: 'write',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Write or create file (alias)',
    maxResultSizeChars: 5000,
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      text: { type: 'string', required: true, description: 'File content' },
    },
    permissionTier: 'high',
  },

  edit_file: {
    name: 'edit_file',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Edit file with find/replace',
    maxResultSizeChars: 5000,
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      find: { type: 'string', required: true, description: 'Text to find' },
      replace: { type: 'string', required: true, description: 'Replacement text' },
    },
    permissionTier: 'high',
  },

  edit: {
    name: 'edit',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Edit file with find/replace (alias)',
    maxResultSizeChars: 5000,
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      find: { type: 'string', required: true, description: 'Text to find' },
      replace: { type: 'string', required: true, description: 'Replacement text' },
    },
    permissionTier: 'high',
  },

  create_file: {
    name: 'create_file',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Create new file',
    maxResultSizeChars: 5000,
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      content: { type: 'string', required: true, description: 'File content' },
    },
    permissionTier: 'high',
  },

  exec: {
    name: 'exec',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Execute shell command',
    maxResultSizeChars: 100000,
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command' },
    },
    permissionTier: 'high',  // Can be elevated to 'critical' based on command content
  },

  browser: {
    name: 'browser',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Browser automation',
    maxResultSizeChars: 100000,
    parameters: {
      action: { type: 'string', required: true, description: 'Browser action (navigate, click, etc)' },
    },
    permissionTier: 'high',  // Can be elevated based on action
  },

  sessions: {
    name: 'sessions',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Manage sessions',
    maxResultSizeChars: 10000,
    parameters: {
      action: { type: 'string', required: true, description: 'Session action' },
    },
    permissionTier: 'high',
  },

  subagents: {
    name: 'subagents',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Spawn sub-agents',
    maxResultSizeChars: 50000,
    parameters: {
      action: { type: 'string', required: true, description: 'Sub-agent action' },
    },
    permissionTier: 'high',
  },

  prose: {
    name: 'prose',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: 'Generate prose/text',
    maxResultSizeChars: 50000,
    parameters: {
      prompt: { type: 'string', required: true, description: 'Prose prompt' },
    },
    permissionTier: 'high',
  },

  // ─── Critical Tools (CRITICAL) ───
  // These are identified at runtime based on command content
  // (e.g., "rm -rf /", "DROP TABLE", etc.)
  // ─── Iter-F: SkillTool ─────────────────────────────────
  skill_tool: {
    name: 'skill_tool',
    description: 'Execute a registered Skill by name. Skills are modular capabilities (data-analysis, code-review, server-ops, etc.) that extend Agent functionality.',
    category: 'skill',
    permission: 'high',
    parameters: {
      name: { type: 'string', required: true, description: 'Skill name (e.g., "data-analysis", "code-review", "server-ops")' },
      input: { type: 'object', required: false, description: 'Input parameters for the skill (varies by skill)' },
    },
    maxResultSizeChars: 50_000,
    concurrency: 'STATE_MUTATING',
  },

  // ─── [R30-T4] Image Generation ─────────────────────────────────
  generate_image: {
    name: 'generate_image',
    description: '使用 AI（gpt-image-1 / DALL·E 3）生成图片。适用于营销素材、KOL 内容提案、产品展示图等场景。返回图片 URL 和本地路径。',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    permission: 'medium',
    parameters: {
      prompt: { type: 'string', required: true, description: '图片描述提示词（英文效果最佳，支持中文）' },
      size: { type: 'string', required: false, description: '图片尺寸：1024x1024 / 1792x1024 / 1024x1792，默认 1024x1024' },
      quality: { type: 'string', required: false, description: '质量：standard / hd，默认 standard' },
      style: { type: 'string', required: false, description: '风格：vivid（营销/活泼）/ natural（写实），默认 vivid' },
      filename: { type: 'string', required: false, description: '保存文件名（不含扩展名），为空自动生成' },
    },
    maxResultSizeChars: 5_000,
    concurrency: 'STATE_MUTATING',
    handler: 'image-generator.mjs#handleGenerateImage',  // [R30-T4] handler path
  },
  // [R44-T6] Multimodal Media Analysis Tools
  analyze_video: {
    name: 'analyze_video',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: '分析视频内容：提取关键帧并使用视觉模型分析视频中的场景、文字、动作等',
    maxResultSizeChars: Infinity,
    parameters: {
      video_url: { type: 'string', required: true, description: '视频 URL 或本地路径' },
      question: { type: 'string', required: false, description: '关于视频的具体问题' },
      max_frames: { type: 'number', required: false, description: '最大提取帧数（默认4）' },
    },
    permissionTier: 'state_mutating',
    handler: 'media-analyzer.mjs#handleAnalyzeVideo',
  },
  analyze_audio: {
    name: 'analyze_audio',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: '分析音频内容：转录为文字并用 LLM 分析。支持 mp3、wav、m4a、ogg、webm',
    maxResultSizeChars: Infinity,
    parameters: {
      audio_url: { type: 'string', required: true, description: '音频 URL 或本地路径' },
      question: { type: 'string', required: false, description: '关于音频的具体问题' },
      language: { type: 'string', required: false, description: '音频语言（ISO 639-1）' },
    },
    permissionTier: 'state_mutating',
    handler: 'media-analyzer.mjs#handleAnalyzeAudio',
  },
  analyze_document: {
    name: 'analyze_document',
    category: TOOL_CATEGORIES.STATE_MUTATING,
    description: '分析文档内容（PDF、图片中的文字等）。使用 OCR 和 LLM 提取并分析文档信息',
    maxResultSizeChars: Infinity,
    parameters: {
      document_url: { type: 'string', required: true, description: '文档 URL 或本地路径' },
      question: { type: 'string', required: false, description: '关于文档的具体问题' },
    },
    permissionTier: 'state_mutating',
    handler: 'media-analyzer.mjs#handleAnalyzeDocument',
  },
};

/**
 * Get the complete tool registry
 */
export function getToolRegistry() {
  return { ...TOOL_REGISTRY };
}

/**
 * Get a specific tool by name
 */
export function getTool(toolName) {
  return TOOL_REGISTRY[toolName] || null;
}

/**
 * Get all tools in a category
 */
export function getToolsByCategory(category) {
  return Object.values(TOOL_REGISTRY).filter(tool => tool.category === category);
}

/**
 * Get all tools
 */
export function getAllTools() {
  return Object.values(TOOL_REGISTRY);
}

/**
 * Get tool's max result size
 * Returns Infinity if not truncated, otherwise the max chars
 */
export function getToolMaxResultSize(toolName) {
  const tool = getTool(toolName);
  return tool?.maxResultSizeChars ?? 100000;  // Default 100KB
}

/**
 * Check if tool result should be truncated
 */
export function shouldTruncateResult(toolName, resultLength) {
  const maxSize = getToolMaxResultSize(toolName);
  return maxSize !== Infinity && resultLength > maxSize;
}

/**
 * Truncate result if needed
 */
export function truncateResultIfNeeded(toolName, result) {
  if (typeof result !== 'string') return result;
  
  const maxSize = getToolMaxResultSize(toolName);
  if (maxSize === Infinity) return result;  // Never truncate
  
  if (result.length > maxSize) {
    return result.substring(0, maxSize) + `\n\n[... truncated ${result.length - maxSize} chars ...]`;
  }
  return result;
}

/**
 * Get tool permission tier
 */
export function getToolPermissionTier(toolName) {
  const tool = getTool(toolName);
  return tool?.permissionTier ?? 'high';  // Default to high for safety
}

/**
 * Get all readonly tools (for whitelist passthrough)
 */
export function getReadonlyTools() {
  return getToolsByCategory(TOOL_CATEGORIES.READONLY);
}

/**
 * Get all state-mutating tools
 */
export function getStateMutatingTools() {
  return getToolsByCategory(TOOL_CATEGORIES.STATE_MUTATING);
}

/**
 * Get tool statistics
 */
export function getToolStats() {
  const readonly = getReadonlyTools();
  const mutating = getStateMutatingTools();
  
  return {
    total: getAllTools().length,
    readonly: readonly.length,
    stateMutating: mutating.length,
    categories: {
      [TOOL_CATEGORIES.READONLY]: readonly.length,
      [TOOL_CATEGORIES.STATE_MUTATING]: mutating.length,
      [TOOL_CATEGORIES.CRITICAL]: 0,
    },
  };
}
export const TOOLS_SUMMARY = `
Unified Tool Registry (Iter-A)

Total Tools: ${getAllTools().length}
- Readonly: ${getReadonlyTools().length} (zero-cost passthrough)
- State-Mutating: ${getStateMutatingTools().length} (require approval)
- Critical: identified at runtime (force confirmation)

Key Feature: maxResultSizeChars: Infinity for file_read
- file_read results are NEVER truncated
- Other tools have sensible defaults (100KB-100MB)
- Integration with Iter-B permission chain
`;
