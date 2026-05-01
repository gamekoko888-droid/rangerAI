/**
 * voice-api.mjs — RangerAI Real-time Voice (WebRTC via OpenAI Realtime API)
 *
 * Architecture: OpenAI Realtime API (WebRTC) with RangerAI system prompt injection
 * Uses the "unified interface" pattern from OpenAI docs:
 *   Browser → POST SDP to our server → server relays to OpenAI with session config → returns SDP answer
 *
 * Endpoints:
 *   POST /api/voice/session  — WebRTC SDP exchange (unified interface)
 *   POST /api/voice/search   — Web search proxy for voice function calling
 *   POST /api/voice/transcribe — Whisper speech-to-text transcription (R31-T4)
 *   GET  /api/voice/status   — Health check
 *
 * @version 5.1.0 — Optimized search speed + transition speech
 */
import { logger } from "../lib/logger.mjs";
import { readFileSync, existsSync } from "fs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = 'gpt-realtime-1.5';
const VOICE = "coral";

/**
 * Web search tool definition for Realtime API function calling
 */
const VOICE_TOOLS = [
  {
    type: "function",
    name: "web_search",
    description: "Search the internet for real-time, up-to-date information. Use this tool when the user asks about current events, recent news, live data, stock prices, weather, sports scores, or anything that requires the latest information beyond your training data cutoff. Also use it when you are unsure about facts that may have changed recently.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to look up on the web. Use clear, specific search terms."
        }
      },
      required: ["query"]
    }
  }
];

/**
 * Load RangerAI identity instructions for the voice session
 */
function getRangerVoiceInstructions() {
  // Try to load SOUL.md for identity
  const soulPath = "/home/admin/.openclaw/SOUL.md";
  let identity = "";
  try {
    if (existsSync(soulPath)) {
      const soul = readFileSync(soulPath, "utf-8");
      const lines = soul.split("\\n").slice(0, 60).join("\\n");
      identity = lines;
    }
  } catch (e) {
    logger.warn(`[voice-api] Could not load SOUL.md: ${e.message}`);
  }
  return `You are RangerAI (游侠AI), a real-time voice assistant for the Ranger Voyage (游侠出海) team.
Core identity:
- You are RangerAI, created by Voyage Games (游侠出海)
- Your underlying model is accessed through OpenAI Realtime API
- You speak naturally and conversationally in Chinese (简体中文) by default
- You can also speak English when the user speaks English
- Be helpful, concise, warm, and proactive
- Keep responses brief and natural for voice conversation (not too long)
Key rules:
- Always respond in the same language the user speaks
- Be honest - if you don't know something, say so
- For complex tasks, suggest the user use the text chat interface instead
- You are part of the RangerAI system that helps with game distribution, KOL outreach, market analysis, and customer service
- You have access to a web_search tool. When the user asks about current events, recent news, real-time data, or anything you're unsure about, USE the web_search tool to get up-to-date information. Do NOT make up answers when you can search instead.
- IMPORTANT: Before calling web_search, you MUST first speak a brief transition phrase to the user like "好的，让我帮你查一下" or "稍等，我搜索一下最新信息" so the user knows you are working on it. Never go silent while searching.
- After getting search results, summarize them naturally and conversationally. Cite key facts but keep it brief for voice.
${identity ? "Additional context from system config:\\n" + identity.substring(0, 2000) : ""}`;
}

/**
 * Handle voice API requests
 */
export async function handleVoiceApi(req, res) {
  const url = req.url?.split("?")[0] || "";

  if (url === "/api/voice/session" && req.method === "POST") {
    return handleSession(req, res);
  }

  if (url === "/api/voice/search" && req.method === "POST") {
    return handleSearch(req, res);
  }

  // [R33-T1] TTS endpoint
  if (url === "/api/voice/tts" && req.method === "POST") {
    return handleTTS(req, res);
  }
  if (url === "/api/voice/tts-stream" && req.method === "POST") {
    return handleTTSStream(req, res);
  }

  // R31-T4: Whisper transcription endpoint
  if (url === "/api/voice/transcribe" && req.method === "POST") {
    return handleTranscribe(req, res);
  }

  if (url === "/api/voice/status" && req.method === "GET") {
    const sendJson = (code, data) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    sendJson(200, {
      available: !!OPENAI_API_KEY,
      mode: "webrtc-realtime",
      model: REALTIME_MODEL,
      voice: VOICE,
      features: ["web_search"],
    });
    return true;
  }

  return false;
}

/**
 * POST /api/voice/session
 */
async function handleSession(req, res) {
  const sendJson = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (!OPENAI_API_KEY) {
    sendJson(500, { error: "OPENAI_API_KEY not configured" });
    return true;
  }

  try {
    const rawBody = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

    if (!rawBody || rawBody.trim().length === 0) {
      sendJson(400, { error: "Empty request body" });
      return true;
    }

    let sdpOffer;
    try {
      const parsed = JSON.parse(rawBody);
      sdpOffer = parsed.sdp || rawBody;
    } catch {
      sdpOffer = rawBody;
    }

    if (!sdpOffer || sdpOffer.trim().length === 0) {
      sendJson(400, { error: "Empty SDP offer" });
      return true;
    }

    logger.info(`[voice-api] Session request: SDP offer ${sdpOffer.length} bytes`);

    const instructions = getRangerVoiceInstructions();
    const sessionConfig = JSON.stringify({
      type: "realtime",
      model: REALTIME_MODEL,
      instructions: instructions,
      audio: { output: { voice: VOICE } },
      tools: VOICE_TOOLS,
      tool_choice: "auto",
    });

    const fd = new FormData();
    fd.set("sdp", sdpOffer);
    fd.set("session", sessionConfig);

    logger.info(`[voice-api] Calling OpenAI Realtime API...`);
    logger.info(`[voice-api] Session config: model=${REALTIME_MODEL}, voice=${VOICE}, tools=${VOICE_TOOLS.length}`);

    const response = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: fd,
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[voice-api] OpenAI Realtime API error: ${response.status} ${errorText}`);
      sendJson(response.status, { error: "OpenAI Realtime API error", detail: errorText });
      return true;
    }

    const sdpAnswer = await response.text();
    logger.info(`[voice-api] Got SDP answer: ${sdpAnswer.length} bytes`);

    res.writeHead(200, { "Content-Type": "application/sdp" });
    res.end(sdpAnswer);
    return true;
  } catch (e) {
    logger.error(`[voice-api] Session error: ${e.message}`);
    sendJson(500, { error: `Session creation failed: ${e.message}` });
    return true;
  }
}

/**
 * POST /api/voice/transcribe
 * R31-T4: Whisper speech-to-text transcription
 * Accepts: multipart/form-data with audio file, or JSON { audioUrl: string }
 * Returns: JSON { text, language, duration, segments }
 */
async function handleTranscribe(req, res) {
  const sendJson = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (!OPENAI_API_KEY) {
    sendJson(500, { error: "OPENAI_API_KEY not configured" });
    return true;
  }

  try {
    const startTime = Date.now();
    
    // Collect request body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);
    
    let audioBuffer, filename = "audio.webm";
    const contentType = req.headers["content-type"] || "";
    
    if (contentType.includes("multipart/form-data")) {
      // Parse multipart — extract audio file
      const boundary = contentType.split("boundary=")[1];
      if (!boundary) {
        sendJson(400, { error: "Missing multipart boundary" });
        return true;
      }
      const parts = bodyBuf.toString("binary").split("--" + boundary);
      for (const part of parts) {
        if (part.includes("Content-Disposition") && part.includes("name=\"file\"")) {
          const headerEnd = part.indexOf("\r\n\r\n");
          if (headerEnd > -1) {
            const fileData = part.substring(headerEnd + 4).replace(/\r\n$/, "");
            audioBuffer = Buffer.from(fileData, "binary");
            // Extract filename
            const fnMatch = part.match(/filename="([^"]+)"/);
            if (fnMatch) filename = fnMatch[1];
          }
        }
      }
      if (!audioBuffer) {
        sendJson(400, { error: "No audio file found in multipart data" });
        return true;
      }
    } else {
      // JSON body with audioUrl
      const body = JSON.parse(bodyBuf.toString());
      if (!body.audioUrl) {
        sendJson(400, { error: "Missing audioUrl or audio file" });
        return true;
      }
      // Download audio from URL
      const audioResp = await fetch(body.audioUrl);
      if (!audioResp.ok) {
        sendJson(400, { error: "Failed to download audio from URL" });
        return true;
      }
      audioBuffer = Buffer.from(await audioResp.arrayBuffer());
      filename = body.audioUrl.split("/").pop() || "audio.webm";
    }

    logger.info("[voice-api] Transcribe request: " + audioBuffer.length + " bytes, filename=" + filename);

    // Check file size (16MB limit)
    if (audioBuffer.length > 16 * 1024 * 1024) {
      sendJson(400, { error: "Audio file too large (max 16MB)" });
      return true;
    }

    // Call OpenAI Whisper API
    const fd = new FormData();
    fd.set("file", new Blob([audioBuffer]), filename);
    fd.set("model", "whisper-1");
    fd.set("response_format", "verbose_json");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
      },
      body: fd,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error("[voice-api] Whisper API error: " + response.status + " " + errorText);
      sendJson(response.status, { error: "Whisper API error", detail: errorText });
      return true;
    }

    const result = await response.json();
    const elapsed = Date.now() - startTime;
    logger.info("[voice-api] Transcription completed in " + elapsed + "ms: " + (result.text || "").substring(0, 100));

    // Emit audio_transcribed event via IPC if available
    try {
      const { emitEvent } = await import("../worker/event-stream.mjs");
      emitEvent("api", "voice-transcribe", "audio_transcribed", {
        duration_ms: elapsed,
        text_length: (result.text || "").length,
        language: result.language || "unknown",
        audio_size: audioBuffer.length,
      });
      logger.info("[R31-T4] audio_transcribed event emitted");
    } catch (evtErr) {
      logger.debug("[R31-T4] Event emit failed (non-fatal): " + evtErr.message);
    }

    sendJson(200, {
      text: result.text,
      language: result.language,
      duration: result.duration,
      segments: result.segments,
    });
    return true;
  } catch (e) {
    if (e.name === "AbortError") {
      logger.error("[voice-api] Transcription timeout");
      sendJson(504, { error: "Transcription timeout" });
    } else {
      logger.error("[voice-api] Transcription error: " + e.message);
      sendJson(500, { error: "Transcription failed: " + e.message });
    }
    return true;
  }
}

/**
 * POST /api/voice/search
 * Accepts: JSON { query: string }
 * Returns: JSON { result: string }
 *
 * Uses OpenAI Chat Completions API with web_search tool for fast results.
 */
async function handleSearch(req, res) {
  const sendJson = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };

  if (!OPENAI_API_KEY) {
    sendJson(500, { error: "OPENAI_API_KEY not configured" });
    return true;
  }

  try {
    const rawBody = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

    const { query } = JSON.parse(rawBody);
    if (!query) {
      sendJson(400, { error: "Missing query parameter" });
      return true;
    }

    logger.info(`[voice-api] Web search request: "${query}"`);
    const startTime = Date.now();

    // Use OpenAI Responses API with web_search_preview for speed
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "gpt-4o-mini",
        tools: [{ type: "web_search_preview" }],
        input: `搜索并简要回答以下问题，用中文回答，控制在100字以内，只给出关键事实和数据: ${query}`,
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[voice-api] Search API error: ${response.status} ${errorText}`);
      sendJson(500, { error: "Search failed", detail: errorText });
      return true;
    }

    const data = await response.json();

    // Extract the text output
    let resultText = "";
    if (data.output) {
      for (const item of data.output) {
        if (item.type === "message" && item.content) {
          for (const content of item.content) {
            if (content.type === "output_text") {
              resultText += content.text;
            }
          }
        }
      }
    }

    if (!resultText) {
      resultText = "抱歉，搜索没有找到相关结果。";
    }

    const elapsed = Date.now() - startTime;
    logger.info(`[voice-api] Search completed in ${elapsed}ms, result: ${resultText.length} chars`);

    sendJson(200, { result: resultText });
    return true;
  } catch (e) {
    if (e.name === 'AbortError') {
      logger.error(`[voice-api] Search timeout`);
      sendJson(200, { result: "搜索超时了，请稍后再试或换个问法。" });
    } else {
      logger.error(`[voice-api] Search error: ${e.message}`);
      sendJson(500, { error: `Search failed: ${e.message}` });
    }
    return true;
  }
}


/**
 * POST /api/voice/tts-stream
 * [R41-T5] Streaming Text-to-Speech endpoint
 * Accepts: JSON { text, voice?, model?, speed?, response_format? }
 * Returns: Chunked audio stream (first chunk ≤ 1s for text ≤ 1000 chars)
 */
async function handleTTSStream(req, res) {
  if (!OPENAI_API_KEY) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "OPENAI_API_KEY not configured" }));
    return true;
  }
  try {
    const rawBody = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
    const body = JSON.parse(rawBody);
    if (!body.text || typeof body.text !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing text parameter (string)" }));
      return true;
    }
    logger.info(`[voice-api] TTS-stream request: text="${body.text.substring(0, 60)}..." voice=${body.voice || "alloy"}`);
    
    // Emit tts_stream_started event
    try {
      const { emitEvent } = await import("../worker/event-stream.mjs");
      emitEvent("api", "voice-tts-stream", "tts_stream_started", {
        voice: body.voice || "alloy",
        model: body.model || "tts-1",
        text_length: body.text.length,
        timestamp: new Date().toISOString(),
      });
      logger.info("[R41-T5] tts_stream_started event emitted");
    } catch (evtErr) {
      logger.debug("[R41-T5] Event emit failed (non-fatal): " + evtErr.message);
    }
    
    const { generateSpeechStream } = await import("../worker/tts-generator.mjs");
    const result = await generateSpeechStream({
      text: body.text,
      voice: body.voice,
      model: body.model,
      speed: body.speed,
      response_format: body.response_format,
    }, res);
    
    // If streaming failed before headers were sent
    if (!result.success && !res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: result.error }));
    }
    
    // Emit tts_generated event after streaming completes
    if (result.success) {
      try {
        const { emitEvent } = await import("../worker/event-stream.mjs");
        emitEvent("api", "voice-tts-stream", "tts_generated", {
          voice: result.voice,
          model: result.model,
          text_length: body.text.length,
          size_bytes: result.size_bytes,
          streaming: true,
          totalTime: result.totalTime,
        });
      } catch (evtErr) { /* non-fatal */ }
    }
    
    return true;
  } catch (e) {
    logger.error("[voice-api] TTS-stream error: " + e.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "TTS stream failed: " + e.message }));
    }
    return true;
  }
}

/**
 * POST /api/voice/tts
 * [R33-T1] Text-to-Speech endpoint
 * Accepts: JSON { text, voice?, model?, speed?, response_format? }
 * Returns: JSON { success, url, voice, model, size_bytes, duration_estimate }
 */
async function handleTTS(req, res) {
  const sendJson = (code, data) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (!OPENAI_API_KEY) {
    sendJson(500, { error: "OPENAI_API_KEY not configured" });
    return true;
  }
  try {
    const rawBody = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
    const body = JSON.parse(rawBody);
    if (!body.text || typeof body.text !== "string") {
      sendJson(400, { error: "Missing text parameter (string)" });
      return true;
    }
    logger.info(`[voice-api] TTS request: text="${body.text.substring(0, 60)}..." voice=${body.voice || "alloy"}`);
    const { generateSpeech } = await import("../worker/tts-generator.mjs");
    const result = await generateSpeech({
      text: body.text,
      voice: body.voice,
      model: body.model,
      speed: body.speed,
      response_format: body.response_format,
    });
    if (!result.success) {
      sendJson(500, { error: result.error });
      return true;
    }
    // Emit tts_generated event
    try {
      const { emitEvent } = await import("../worker/event-stream.mjs");
      emitEvent("api", "voice-tts", "tts_generated", {
        voice: result.voice,
        model: result.model,
        text_length: body.text.length,
        size_bytes: result.size_bytes,
        url: result.url,
      });
      logger.info("[R33-T1] tts_generated event emitted");
    } catch (evtErr) {
      logger.debug("[R33-T1] Event emit failed (non-fatal): " + evtErr.message);
    }
    sendJson(200, result);
    return true;
  } catch (e) {
    logger.error("[voice-api] TTS error: " + e.message);
    sendJson(500, { error: "TTS failed: " + e.message });
    return true;
  }
}
