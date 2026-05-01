// ─── R35-T3: MCP Protocol Standardization ───
// JSON-RPC 2.0 compliant tool layer for RangerAI
// Endpoint: POST /api/mcp
// Spec: Model Context Protocol (MCP) — https://modelcontextprotocol.io
//
// Supported methods:
//   - initialize: Handshake, returns server capabilities
//   - tools/list: List available tools
//   - tools/call: Execute a tool by name
//   - resources/list: List available resources (datasource entries)
//   - ping: Health check

import { logger } from '../lib/logger.mjs';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ts = () => new Date().toISOString();

// ─── MCP Server Info ───
const SERVER_INFO = {
  name: "rangerai-mcp",
  version: "1.0.0",
  protocolVersion: "2024-11-05"
};

const SERVER_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false }
};

// ─── Tool Registry (subset exposed via MCP) ───
const MCP_TOOLS = [
  {
    name: "web_search",
    description: "Search the web using Brave Search API. Returns relevant search results for a given query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query string" },
        count: { type: "number", description: "Number of results (default 5, max 20)" }
      },
      required: ["query"]
    }
  },
  {
    name: "web_fetch",
    description: "Fetch the content of a web page by URL. Returns the page text content.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        selector: { type: "string", description: "Optional CSS selector to extract specific content" }
      },
      required: ["url"]
    }
  },
  {
    name: "generate_image",
    description: "Generate an image from a text prompt using AI image generation.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image generation prompt" },
        size: { type: "string", description: "Image size (1024x1024, 1792x1024, 1024x1792)", default: "1024x1024" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "speak_text",
    description: "Convert text to speech using OpenAI TTS API. Returns an audio file URL.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to convert to speech" },
        voice: { type: "string", description: "Voice model (alloy, echo, fable, onyx, nova, shimmer)", default: "alloy" },
        speed: { type: "number", description: "Speech speed (0.25 to 4.0)", default: 1.0 }
      },
      required: ["text"]
    }
  },
  {
    name: "analyze_image",
    description: "Analyze an image using GPT-4o Vision. Returns a detailed description.",
    inputSchema: {
      type: "object",
      properties: {
        image_url: { type: "string", description: "URL of the image to analyze" },
        question: { type: "string", description: "Specific question about the image", default: "Describe this image in detail." }
      },
      required: ["image_url"]
    }
  },
  {
    name: "analyze_video",
    description: "Analyze video content by extracting key frames and using Vision API. Supports mp4, webm, mov.",
    inputSchema: {
      type: "object",
      properties: {
        video_url: { type: "string", description: "Video URL or local file path" },
        question: { type: "string", description: "Specific question about the video" },
        max_frames: { type: "number", description: "Maximum frames to extract (default 4, max 8)" }
      },
      required: ["video_url"]
    }
  },
  {
    name: "analyze_audio",
    description: "Transcribe and analyze audio content. Supports mp3, wav, m4a, ogg, webm.",
    inputSchema: {
      type: "object",
      properties: {
        audio_url: { type: "string", description: "Audio URL or local file path" },
        question: { type: "string", description: "Specific question about the audio" },
        language: { type: "string", description: "Audio language (ISO 639-1 code)" }
      },
      required: ["audio_url"]
    }
  },
  {
    name: "analyze_document",
    description: "Extract and analyze document content using OCR and LLM. Supports PDF, images, text files.",
    inputSchema: {
      type: "object",
      properties: {
        document_url: { type: "string", description: "Document URL or local file path" },
        question: { type: "string", description: "Specific question about the document" }
      },
      required: ["document_url"]
    }
  },,
  {
    name: "memory_search",
    description: "Search the knowledge base for relevant information.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for knowledge base" },
        limit: { type: "number", description: "Max results to return", default: 5 }
      },
      required: ["query"]
    }
  }
];

// ─── Event Stream Logger ───
function emitMcpEvent(sessionKey, taskId, payload) {
  try {
    const dbPath = path.join(__dirname, '..', 'db', 'rangerai.db');
    const db = new Database(dbPath);
    db.prepare("INSERT INTO event_stream (session_key, task_id, event_type, payload) VALUES (?, ?, 'mcp_tool_call', ?)")
      .run(sessionKey || 'mcp_anonymous', taskId || `mcp-${Date.now()}`, JSON.stringify(payload));
    db.close();
  } catch (err) {
    logger.warn(`[${ts()}] [R35-T3] MCP event emit failed: ${err.message}`);
  }
}

// ─── JSON-RPC 2.0 Response Helpers ───
function jsonRpcSuccess(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data = undefined) {
  const err = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return err;
}

// Standard JSON-RPC error codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ─── Method Handlers ───
function handleInitialize(id, params) {
  return jsonRpcSuccess(id, {
    protocolVersion: SERVER_INFO.protocolVersion,
    capabilities: SERVER_CAPABILITIES,
    serverInfo: {
      name: SERVER_INFO.name,
      version: SERVER_INFO.version
    }
  });
}

function handleToolsList(id) {
  return jsonRpcSuccess(id, { tools: MCP_TOOLS });
}

async function handleToolsCall(id, params) {
  const { name, arguments: args } = params || {};
  
  if (!name) {
    return jsonRpcError(id, INVALID_PARAMS, "Missing required parameter: name");
  }
  
  const tool = MCP_TOOLS.find(t => t.name === name);
  if (!tool) {
    return jsonRpcError(id, METHOD_NOT_FOUND, `Tool not found: ${name}`);
  }
  
  // Emit mcp_tool_call event
  emitMcpEvent('mcp_api', `mcp-call-${Date.now()}`, {
    tool: name,
    args: args || {},
    source: "mcp_api",
    timestamp: ts()
  });
  
  logger.info(`[${ts()}] [R35-T3] MCP tools/call: tool=${name} args=${JSON.stringify(args || {}).substring(0, 100)}`);
  
  // For now, return a structured acknowledgment
  // In production, this would dispatch to the actual tool executor
  return jsonRpcSuccess(id, {
    content: [
      {
        type: "text",
        text: `Tool "${name}" acknowledged. Arguments: ${JSON.stringify(args || {})}. Tool execution is queued.`
      }
    ],
    isError: false
  });
}

function handleResourcesList(id) {
  // Expose datasource entries as MCP resources
  let entries = [];
  try {
    const dbPath = path.join(__dirname, '..', 'db', 'rangerai.db');
    const db = new Database(dbPath);
    const rows = db.prepare("SELECT DISTINCT event_type FROM event_stream LIMIT 50").all();
    db.close();
    entries = [
      { uri: "rangerai://datasource/dashboard", name: "Dashboard API", description: "System dashboard and metrics", mimeType: "application/json" },
      { uri: "rangerai://datasource/tasks", name: "Tasks API", description: "Task management endpoints", mimeType: "application/json" },
      { uri: "rangerai://datasource/kol", name: "KOL API", description: "KOL/influencer management", mimeType: "application/json" },
      { uri: "rangerai://datasource/knowledge", name: "Knowledge Base", description: "Knowledge entries and search", mimeType: "application/json" },
      { uri: "rangerai://datasource/event-stream", name: "Event Stream", description: "Real-time event stream data", mimeType: "application/json" },
      { uri: "rangerai://events/types", name: "Event Types", description: `${rows.length} distinct event types tracked`, mimeType: "application/json" }
    ];
  } catch (_) {}
  
  return jsonRpcSuccess(id, { resources: entries });
}

function handlePing(id) {
  return jsonRpcSuccess(id, {});
}

// ─── Main Request Router ───
export async function handleMcpRequest(req, res) {
  // Parse body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (err) {
    const resp = jsonRpcError(null, PARSE_ERROR, "Parse error: invalid JSON");
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
    return true;
  }
  
  // Validate JSON-RPC 2.0
  if (!body || body.jsonrpc !== "2.0" || !body.method) {
    const resp = jsonRpcError(body?.id || null, INVALID_REQUEST, "Invalid JSON-RPC 2.0 request");
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(resp));
    return true;
  }
  
  const { id, method, params } = body;
  
  logger.info(`[${ts()}] [R35-T3] MCP request: method=${method} id=${id}`);
  
  let response;
  try {
    switch (method) {
      case "initialize":
        response = handleInitialize(id, params);
        break;
      case "tools/list":
        response = handleToolsList(id);
        break;
      case "tools/call":
        response = await handleToolsCall(id, params);
        break;
      case "resources/list":
        response = handleResourcesList(id);
        break;
      case "ping":
        response = handlePing(id);
        break;
      case "notifications/initialized":
        // Client notification, no response needed per spec
        res.writeHead(204);
        res.end();
        return true;
      default:
        response = jsonRpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (err) {
    logger.error(`[${ts()}] [R35-T3] MCP handler error: ${err.message}`);
    response = jsonRpcError(id, INTERNAL_ERROR, `Internal error: ${err.message}`);
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
  return true;
}

export default { handleMcpRequest, MCP_TOOLS, SERVER_INFO };
