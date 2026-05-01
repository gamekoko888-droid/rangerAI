/**
 * tts-generator.mjs — [R33-T1] AI Text-to-Speech Tool
 *
 * Provides `speak_text` tool for RangerAI agent loop.
 * Calls OpenAI TTS API (tts-1 / tts-1-hd) to generate mp3 audio.
 *
 * Output: saves generated audio to fileserver uploads dir,
 * returns {url, localPath, text, voice, model, duration_estimate}
 *
 * Usage: import { handleSpeakText, TTS_TOOL_DEFINITION } from './tts-generator.mjs';
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── Constants ───
const UPLOAD_DIR = '/opt/rangerai-agent/uploads/audio/';
const DEFAULT_MODEL = 'tts-1';
const HD_MODEL = 'tts-1-hd';
const DEFAULT_VOICE = 'alloy';
const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
const VALID_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
const MAX_TEXT_LENGTH = 4096; // OpenAI TTS limit

// ─── Tool Definition (for tool registry / OpenAI function calling schema) ───
export const TTS_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'speak_text',
    description: '将文本转换为语音音频（Text-to-Speech）。使用 OpenAI TTS API 生成高质量语音。适用于语音播报、内容朗读、多语言语音生成等场景。返回音频文件 URL。',
    parameters: {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: '要转换为语音的文本内容。最大 4096 字符。支持中文、英文等多种语言。',
        },
        voice: {
          type: 'string',
          enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
          description: '语音角色。alloy=中性, echo=男性, fable=英式, onyx=深沉男性, nova=女性, shimmer=温柔女性。默认 alloy。',
        },
        model: {
          type: 'string',
          enum: ['tts-1', 'tts-1-hd'],
          description: '模型选择。tts-1=标准（快速）, tts-1-hd=高清（更高质量）。默认 tts-1。',
        },
        speed: {
          type: 'number',
          description: '语速倍率，范围 0.25-4.0。默认 1.0。',
        },
        response_format: {
          type: 'string',
          enum: ['mp3', 'opus', 'aac', 'flac', 'wav'],
          description: '输出音频格式。默认 mp3。',
        },
      },
    },
  },
};

// ─── Ensure upload directory exists ───
function ensureUploadDir() {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  } catch (e) {
    // ignore if already exists
  }
}

/**
 * Main TTS generation function.
 * @param {object} params
 * @param {string} params.text - Text to convert to speech
 * @param {string} [params.voice='alloy']
 * @param {string} [params.model='tts-1']
 * @param {number} [params.speed=1.0]
 * @param {string} [params.response_format='mp3']
 * @returns {Promise<{success: boolean, url?: string, localPath?: string, text: string, voice: string, model: string, duration_estimate?: number, error?: string}>}
 */
export async function generateSpeech(params = {}) {
  const {
    text,
    voice = DEFAULT_VOICE,
    model = DEFAULT_MODEL,
    speed = 1.0,
    response_format = 'mp3',
  } = params;

  if (!text || text.trim().length < 1) {
    return { success: false, error: 'text is required', text: text || '', voice, model };
  }

  if (text.length > MAX_TEXT_LENGTH) {
    return { success: false, error: `text exceeds maximum length of ${MAX_TEXT_LENGTH} characters (got ${text.length})`, text: text.substring(0, 50) + '...', voice, model };
  }

  // Validate voice
  const safeVoice = VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE;
  // Validate model
  const safeModel = (model === HD_MODEL) ? HD_MODEL : DEFAULT_MODEL;
  // Validate speed
  const safeSpeed = Math.max(0.25, Math.min(4.0, Number(speed) || 1.0));
  // Validate format
  const safeFormat = VALID_FORMATS.includes(response_format) ? response_format : 'mp3';

  // Resolve API key
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY not configured', text: text.substring(0, 50), voice: safeVoice, model: safeModel };
  }

  ensureUploadDir();

  logger.info(`[${ts()}] [R33-T1] speak_text: model=${safeModel} voice=${safeVoice} speed=${safeSpeed} format=${safeFormat} text="${text.substring(0, 80)}..."`);

  // ─── Call OpenAI TTS API ───
  const requestBody = JSON.stringify({
    model: safeModel,
    input: text.trim(),
    voice: safeVoice,
    speed: safeSpeed,
    response_format: safeFormat,
  });

  try {
    const audioBuffer = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/speech',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(requestBody),
        },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (chunk) => errBody += chunk);
          res.on('end', () => reject(new Error(`OpenAI TTS API error: HTTP ${res.statusCode} — ${errBody}`)));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('TTS request timeout (30s)')); });
      req.write(requestBody);
      req.end();
    });

    // Save to file
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).slice(2, 8);
    const filename = `tts-${timestamp}-${randomSuffix}.${safeFormat}`;
    const localPath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(localPath, audioBuffer);

    // Upload to fileserver for public URL
    const fileserverUrl = `https://ranger.voyage/files/${filename}`;

    // Also copy to fileserver files dir for direct serving
    const filesDir = '/opt/rangerai-agent/files/';
    try {
      fs.mkdirSync(filesDir, { recursive: true });
      fs.copyFileSync(localPath, path.join(filesDir, filename));
    } catch (e) {
      logger.warn(`[${ts()}] [R33-T1] Could not copy to files dir: ${e.message}`);
    }

    // Estimate duration (rough: ~150 words/min for English, ~200 chars/min for Chinese)
    const charCount = text.length;
    const durationEstimate = Math.round((charCount / 200) * 60 / safeSpeed);

    logger.info(`[${ts()}] [R33-T1] TTS generated: ${audioBuffer.length} bytes, saved to ${localPath}, served at ${fileserverUrl}`);

    return {
      success: true,
      phase: 'done',
      url: fileserverUrl,
      localPath,
      text: text.substring(0, 100),
      voice: safeVoice,
      model: safeModel,
      format: safeFormat,
      size_bytes: audioBuffer.length,
      duration_estimate: durationEstimate,
    };
  } catch (err) {
    logger.error(`[${ts()}] [R33-T1] TTS generation failed: ${err.message}`);
    return {
      success: false,
      phase: 'failed',
      error: err.message,
      text: text.substring(0, 50),
      voice: safeVoice,
      model: safeModel,
    };
  }
}

/**
 * Handle speak_text tool call from agent loop (same interface as handleGenerateImage).
 * @param {object} args - Tool arguments from the agent
 * @returns {Promise<object>} Result object
 */
export async function handleSpeakText(args) {
  const text = args.text || args.input || args.content || '';
  const voice = args.voice || DEFAULT_VOICE;
  const model = args.model || DEFAULT_MODEL;
  const speed = args.speed || 1.0;
  const response_format = args.response_format || args.format || 'mp3';

  return generateSpeech({ text, voice, model, speed, response_format });
}


/**
 * [R41-T5] Streaming TTS — pipes OpenAI TTS response directly to HTTP response
 * @param {object} params - Same as generateSpeech
 * @param {object} res - Node.js HTTP response object
 * @returns {Promise<{success: boolean, voice: string, model: string, size_bytes?: number, error?: string}>}
 */
export async function generateSpeechStream(params, res) {
  const {
    text,
    voice = DEFAULT_VOICE,
    model = DEFAULT_MODEL,
    speed = 1.0,
    response_format = 'mp3',
  } = params;
  if (!text || text.trim().length < 1) {
    return { success: false, error: 'text is required' };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { success: false, error: 'text exceeds max length of ' + MAX_TEXT_LENGTH };
  }
  const safeVoice = VALID_VOICES.includes(voice) ? voice : DEFAULT_VOICE;
  const safeModel = (model === HD_MODEL) ? HD_MODEL : DEFAULT_MODEL;
  const safeSpeed = Math.max(0.25, Math.min(4.0, Number(speed) || 1.0));
  const safeFormat = VALID_FORMATS.includes(response_format) ? response_format : 'mp3';
  
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY not configured' };
  }
  
  const mimeMap = { mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
  const contentType = mimeMap[safeFormat] || 'audio/mpeg';
  
  logger.info(`[${ts()}] [R41-T5] stream TTS: model=${safeModel} voice=${safeVoice} speed=${safeSpeed} format=${safeFormat} text="${text.substring(0, 60)}..."`);
  
  const requestBody = JSON.stringify({
    model: safeModel,
    input: text.trim(),
    voice: safeVoice,
    speed: safeSpeed,
    response_format: safeFormat,
  });
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody),
      },
      timeout: 30000,
    }, (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = '';
        apiRes.on('data', (chunk) => errBody += chunk);
        apiRes.on('end', () => {
          logger.error(`[${ts()}] [R41-T5] stream TTS API error: ${apiRes.statusCode} ${errBody}`);
          resolve({ success: false, error: `TTS API error: ${apiRes.statusCode}` });
        });
        return;
      }
      
      // Stream directly to HTTP response
      res.writeHead(200, {
        'Content-Type': contentType,
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-TTS-Voice': safeVoice,
        'X-TTS-Model': safeModel,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-TTS-Voice, X-TTS-Model',
      });
      
      let totalBytes = 0;
      let firstChunkSent = false;
      const startTime = Date.now();
      
      apiRes.on('data', (chunk) => {
        if (!firstChunkSent) {
          firstChunkSent = true;
          const latency = Date.now() - startTime;
          logger.info(`[${ts()}] [R41-T5] first audio chunk: ${chunk.length} bytes, latency=${latency}ms`);
        }
        totalBytes += chunk.length;
        res.write(chunk);
      });
      
      apiRes.on('end', () => {
        res.end();
        const totalTime = Date.now() - startTime;
        logger.info(`[${ts()}] [R41-T5] stream TTS done: ${totalBytes} bytes in ${totalTime}ms`);
        
        // Also save to file for caching
        ensureUploadDir();
        const timestamp = Date.now();
        const randomSuffix = Math.random().toString(36).slice(2, 8);
        const filename = `tts-${timestamp}-${randomSuffix}.${safeFormat}`;
        // Note: we don't save streamed audio to file (already sent to client)
        
        resolve({ success: true, voice: safeVoice, model: safeModel, size_bytes: totalBytes, totalTime });
      });
      
      apiRes.on('error', (err) => {
        logger.error(`[${ts()}] [R41-T5] stream TTS pipe error: ${err.message}`);
        try { res.end(); } catch(e) {}
        resolve({ success: false, error: err.message });
      });
    });
    
    req.on('error', (err) => {
      logger.error(`[${ts()}] [R41-T5] stream TTS request error: ${err.message}`);
      resolve({ success: false, error: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: 'TTS request timeout (30s)' });
    });
    req.write(requestBody);
    req.end();
  });
}

export default { generateSpeech, generateSpeechStream, handleSpeakText, TTS_TOOL_DEFINITION };
