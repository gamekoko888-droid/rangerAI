/**
 * image-generator.mjs — [R30-T4] AI Image Generation Tool
 *
 * Provides `generate_image` tool for RangerAI agent loop.
 * Supports:
 *   - gpt-image-1 (default, DALL·E 3 class quality)
 *   - dall-e-3 fallback
 *
 * Output: saves generated image to fileserver upload dir,
 * returns {url, localPath, prompt, model, revised_prompt}
 *
 * Usage in tool_orchestrator: import { generateImage, IMAGE_TOOL_DEFINITION } from './image-generator.mjs';
 */

import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

const _require = createRequire(import.meta.url);

// ─── Logger ───
let _logger = null;
function getLogger() {
  if (!_logger) {
    try {
      const { createLogger } = _require('./logger.cjs');
      _logger = createLogger('image-generator');
    } catch {
      _logger = { info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    }
  }
  return _logger;
}
const ts = () => new Date().toISOString();

// ─── Constants ───
const UPLOAD_DIR = '/opt/rangerai-agent/uploads/images/';
const FILESERVER_BASE_URL = 'https://ranger.voyage';
const DEFAULT_MODEL = 'gpt-image-1';
const FALLBACK_MODEL = 'dall-e-3';

// ─── Tool Definition (for tool registry / OpenAI function calling schema) ───
export const IMAGE_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: '使用 AI（DALL·E 3 / gpt-image-1）生成图片。适用于营销素材、KOL 内容提案、产品展示等场景。返回图片 URL 和本地路径。',
    parameters: {
      type: 'object',
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: '图片描述提示词（英文效果最佳，支持中文）。例如："A vibrant mobile game top-up promotional banner with neon colors"',
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1792x1024', '1024x1792'],
          description: '图片尺寸。1024x1024=正方形，1792x1024=横向，1024x1792=竖向。默认 1024x1024。',
        },
        quality: {
          type: 'string',
          enum: ['standard', 'hd'],
          description: '图片质量。hd 质量更高但消耗更多 tokens。默认 standard。',
        },
        style: {
          type: 'string',
          enum: ['vivid', 'natural'],
          description: '风格：vivid=鲜明活泼（适合营销），natural=自然真实（适合写实）。默认 vivid。',
        },
        filename: {
          type: 'string',
          description: '保存文件名（不含扩展名）。为空时自动生成。',
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

// ─── Download image from URL to local file ───
async function downloadImage(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (e) => {
      fs.unlink(destPath, () => {});
      reject(e);
    });
  });
}

// ─── Helper: make OpenAI API request ───
function callOpenAIImages(apiKey, body) {
  const requestBody = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/images/generations',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`OpenAI API error ${res.statusCode}: ${JSON.stringify(parsed?.error || parsed).substring(0, 300)}`));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error(`JSON parse failed: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenAI API timeout (60s)')); });
    req.write(requestBody);
    req.end();
  });
}

/**
 * Main image generation function.
 * @param {object} params
 * @param {string} params.prompt - Image description
 * @param {string} [params.size='1024x1024']
 * @param {string} [params.quality='standard']
 * @param {string} [params.style='vivid']
 * @param {string} [params.filename]
 * @returns {Promise<{success: boolean, url?: string, localPath?: string, servedUrl?: string, prompt: string, revised_prompt?: string, model: string, error?: string}>}
 */
export async function generateImage(params = {}) {
  const logger = getLogger();
  const {
    prompt,
    size = '1024x1024',
    quality = 'standard',
    style = 'vivid',
    filename,
  } = params;

  if (!prompt || prompt.trim().length < 3) {
    return { success: false, error: 'prompt is required and must be at least 3 characters', prompt: prompt || '' };
  }

  // Resolve API key
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    try {
      const { loadSecrets } = _require('./secrets.cjs');
      const secrets = loadSecrets();
      apiKey = secrets?.OPENAI_API_KEY;
    } catch { /* ignore */ }
  }
  if (!apiKey) {
    return { success: false, error: 'OPENAI_API_KEY not configured', prompt };
  }

  ensureUploadDir();

  const model = DEFAULT_MODEL;
  logger.info(`[${ts()}] [R30-T4] generate_image: model=${model} size=${size} quality=${quality} style=${style} prompt="${prompt.substring(0, 80)}..."`);

  let imageUrl = null;
  let revisedPrompt = null;
  let usedModel = model;
  let fallbackReason = null; // [R41-T3] Track why gpt-image-1 failed

  // ─── Call OpenAI Images API ───
  // R30-T4 fix: gpt-image-1 does not support style or response_format
  // [R41-T3] Map quality for gpt-image-1 (uses low/medium/high/auto, NOT standard/hd)
  const gptImageQuality = quality === 'standard' ? 'auto' : quality === 'hd' ? 'high' : quality;
  const bodyObj = {
    model,
    prompt: prompt.trim(),
    n: 1,
    size,
    quality: model === DEFAULT_MODEL ? gptImageQuality : quality,
    ...(model === "dall-e-3" ? { style, response_format: "url" } : {}),
  };

  try {
    const response = await callOpenAIImages(apiKey, bodyObj);

    if (!response?.data?.[0]?.url) {
      // gpt-image-1 may return b64_json format
      if (response?.data?.[0]?.b64_json) {
        // Save base64 image directly
        const imgFilename = (filename ? filename.replace(/[^a-zA-Z0-9_-]/g, '_') : `img_${Date.now()}`) + '.png';
        const localPath = path.join(UPLOAD_DIR, imgFilename);
        const buf = Buffer.from(response.data[0].b64_json, 'base64');
        fs.writeFileSync(localPath, buf);
        revisedPrompt = response.data[0].revised_prompt || null;
        // [R40-T5] Copy to /files/ dir for public serving (like TTS)
  const filesDir = '/opt/rangerai-agent/files/';
  try {
    fs.mkdirSync(filesDir, { recursive: true });
    fs.copyFileSync(localPath, path.join(filesDir, imgFilename));
  } catch (e) {
    getLogger().warn(`[${ts()}] [R40-T5] Could not copy to files dir: ${e.message}`);
  }
  const servedUrl = `${FILESERVER_BASE_URL}/files/${imgFilename}`;
        logger.info(`[${ts()}] [R30-T4] generate_image SUCCESS (b64): model=${usedModel} file=${imgFilename} size=${buf.length}`);
        return {
          success: true,
          url: servedUrl,
          localPath,
          servedUrl,
          prompt,
          revised_prompt: revisedPrompt,
          model: usedModel,
          fallbackReason, // [R41-T3]
          filename: imgFilename,
        };
      }
      throw new Error('No image URL or b64_json in API response');
    }

    imageUrl = response.data[0].url;
    revisedPrompt = response.data[0].revised_prompt || null;

  } catch (err) {
    // Fallback to dall-e-3
    fallbackReason = err.message; // [R41-T3] Record why primary model failed
    logger.warn(`[${ts()}] [R30-T4] ${model} failed: ${err.message} — falling back to ${FALLBACK_MODEL}`);
    logger.info(`[${ts()}] [R41-T3] gpt-image-1 fallback reason: ${err.message}`);

    const fallbackBody = {
      model: FALLBACK_MODEL,
      prompt: prompt.trim(),
      n: 1,
      size: size === '1792x1024' || size === '1024x1792' ? size : '1024x1024',
      quality,
      style,
      response_format: "url",
    };

    try {
      const fallbackResp = await callOpenAIImages(apiKey, fallbackBody);

      if (!fallbackResp?.data?.[0]?.url) {
        throw new Error('No image URL in dall-e-3 response');
      }
      imageUrl = fallbackResp.data[0].url;
      revisedPrompt = fallbackResp.data[0].revised_prompt || null;
      usedModel = FALLBACK_MODEL;
    } catch (fallbackErr) {
      logger.error(`[${ts()}] [R30-T4] Both models failed. Last error: ${fallbackErr.message}`);
      return { success: false, error: `Image generation failed: ${fallbackErr.message}`, prompt, model: FALLBACK_MODEL };
    }
  }

  // ─── Download and save image ───
  const imgFilename = (filename ? filename.replace(/[^a-zA-Z0-9_-]/g, '_') : `img_${Date.now()}`) + '.png';
  const localPath = path.join(UPLOAD_DIR, imgFilename);

  try {
    await downloadImage(imageUrl, localPath);
    const stat = fs.statSync(localPath);
    logger.info(`[${ts()}] [R30-T4] generate_image SUCCESS: model=${usedModel} file=${imgFilename} size=${stat.size} bytes`);
  } catch (dlErr) {
    logger.warn(`[${ts()}] [R30-T4] Download failed, returning CDN URL: ${dlErr.message}`);
    // Return CDN URL directly if download fails
    return {
      success: true,
      url: imageUrl,
      localPath: null,
      servedUrl: imageUrl,
      prompt,
      revised_prompt: revisedPrompt,
      model: usedModel,
      filename: null,
      note: 'Served from OpenAI CDN (local save failed)',
    };
  }

  // [R40-T5] Copy to /files/ dir for public serving (like TTS)
  const filesDir = '/opt/rangerai-agent/files/';
  try {
    fs.mkdirSync(filesDir, { recursive: true });
    fs.copyFileSync(localPath, path.join(filesDir, imgFilename));
  } catch (e) {
    getLogger().warn(`[${ts()}] [R40-T5] Could not copy to files dir: ${e.message}`);
  }
  const servedUrl = `${FILESERVER_BASE_URL}/files/${imgFilename}`;
  return {
    success: true,
    url: imageUrl,   // Original OpenAI CDN URL (temporary)
    localPath,
    servedUrl,       // Local fileserver URL (permanent)
    prompt,
    revised_prompt: revisedPrompt,
    model: usedModel,
    fallbackReason, // [R41-T3]
    filename: imgFilename,
  };
}

/**
 * Tool handler for integration with tool-orchestrator.mjs
 * Usage: const result = await handleGenerateImage({ prompt, size, quality, style, filename });
 */
export async function handleGenerateImage(args) {
  const logger = getLogger();
  try {
    logger.info(`[${ts()}] [R30-T4] handleGenerateImage called: ${JSON.stringify({ ...args, prompt: (args.prompt || '').substring(0, 60) })}`);
    const result = await generateImage(args);
    if (!result.success) {
      return { phase: 'failed', error: result.error, prompt: result.prompt };
    }
    return {
      phase: 'done',
      url: result.servedUrl || result.url,
      localPath: result.localPath || null,
      prompt: result.prompt,
      revised_prompt: result.revised_prompt || null,
      model: result.model,
      filename: result.filename || null,
      message: `图片已生成：${result.filename || '图片URL'}\n访问地址：${result.servedUrl || result.url}`,
    };
  } catch (e) {
    logger.error(`[${ts()}] [R30-T4] handleGenerateImage exception: ${e.message}`);
    return { phase: 'failed', error: e.message };
  }
}

export default { generateImage, handleGenerateImage, IMAGE_TOOL_DEFINITION };
