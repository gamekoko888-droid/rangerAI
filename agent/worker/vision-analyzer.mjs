/**
 * vision-analyzer.mjs — [R35-T1] AI Vision / Image Understanding Tool
 *
 * Provides `analyze_image` tool for RangerAI agent loop.
 * Calls OpenAI GPT-4o Vision API to analyze/describe images.
 *
 * Supports:
 *   - URL-based images (http/https)
 *   - Local file images (base64 encoded)
 *   - Multiple images in single request
 *
 * Output: returns { success, analysis, model, image_count, tokens_used }
 *
 * Usage: import { handleAnalyzeImage, VISION_TOOL_DEFINITION } from './vision-analyzer.mjs';
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { readFileSync } from 'fs';
import { logger } from '../lib/logger.mjs';

const ts = () => new Date().toISOString();

// ─── Constants ───
const VISION_MODEL = 'gpt-4o';
const FALLBACK_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT = 60000; // Vision can be slow
const MAX_IMAGES = 5;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

// ─── Tool Definition ───
export const VISION_TOOL_DEFINITION = {
  type: 'function',
  function: {
    name: 'analyze_image',
    description: '分析和理解图片内容（AI Vision）。使用 GPT-4o 视觉模型分析图片，支持：图片描述、文字识别(OCR)、物体检测、场景理解、图表解读等。支持 URL 或本地文件路径。',
    parameters: {
      type: 'object',
      required: ['image_url'],
      properties: {
        image_url: {
          type: 'string',
          description: '图片 URL（http/https）或本地文件路径。支持 jpg/png/gif/webp 格式。',
        },
        question: {
          type: 'string',
          description: '关于图片的具体问题。例如："这张图片中有什么？"、"识别图中的文字"、"分析这个图表的数据趋势"。留空则进行通用描述。',
        },
        detail: {
          type: 'string',
          enum: ['auto', 'low', 'high'],
          description: '分析精度：auto（自动）、low（快速概览）、high（高精度分析）。默认 auto。',
        },
      },
    },
  },
};

// ─── API Key ───
let _cachedKey = '';
function getApiKey() {
  if (_cachedKey) return _cachedKey;
  if (process.env.OPENAI_API_KEY) {
    _cachedKey = process.env.OPENAI_API_KEY;
    return _cachedKey;
  }
  try {
    const cfgText = readFileSync('/home/admin/.openclaw/config.json', 'utf-8');
    const cfg = JSON.parse(cfgText);
    const key = cfg?.models?.providers?.openai?.apiKey;
    if (key) { _cachedKey = key; return key; }
  } catch (_) { /* silent */ }
  return '';
}

// ─── Image URL Builder ───
function buildImageContent(imageUrl, detail = 'auto') {
  // If it's a local file, convert to base64 data URL
  if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
    const localPath = imageUrl;
    if (!fs.existsSync(localPath)) {
      throw new Error(`Image file not found: ${localPath}`);
    }
    const stat = fs.statSync(localPath);
    if (stat.size > MAX_IMAGE_SIZE) {
      throw new Error(`Image too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)`);
    }
    const ext = path.extname(localPath).toLowerCase().replace('.', '');
    const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
    const mime = mimeMap[ext] || 'image/png';
    const base64 = fs.readFileSync(localPath).toString('base64');
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mime};base64,${base64}`,
        detail,
      },
    };
  }
  // Remote URL
  return {
    type: 'image_url',
    image_url: {
      url: imageUrl,
      detail,
    },
  };
}

// ─── Core Handler ───
/**
 * Analyze an image using GPT-4o Vision.
 * @param {Object} args - Tool arguments
 * @param {string} args.image_url - Image URL or local path
 * @param {string} [args.question] - Specific question about the image
 * @param {string} [args.detail] - Detail level: auto/low/high
 * @returns {Promise<Object>} Analysis result
 */
export async function handleAnalyzeImage(args) {
  const imageUrl = args.image_url || args.imageUrl || args.url || '';
  const question = args.question || args.prompt || args.query || '';
  const detail = args.detail || 'auto';

  if (!imageUrl) {
    return {
      success: false,
      phase: 'failed',
      error: 'image_url is required',
      analysis: '',
    };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      success: false,
      phase: 'failed',
      error: 'OPENAI_API_KEY not configured',
      analysis: '',
    };
  }

  // Build message content
  const contentParts = [];

  // Add text prompt
  const textPrompt = question
    ? question
    : '请详细描述这张图片的内容，包括：主要元素、文字内容（如有）、颜色、布局、场景等关键信息。如果是图表，请分析数据趋势。';
  contentParts.push({ type: 'text', text: textPrompt });

  // Handle multiple images (comma-separated URLs)
  const imageUrls = imageUrl.split(',').map(u => u.trim()).filter(Boolean).slice(0, MAX_IMAGES);
  for (const url of imageUrls) {
    try {
      contentParts.push(buildImageContent(url, detail));
    } catch (err) {
      logger.warn(`[${ts()}] [R35-T1] Skip image: ${err.message}`);
    }
  }

  if (contentParts.length <= 1) {
    return {
      success: false,
      phase: 'failed',
      error: 'No valid images could be processed',
      analysis: '',
    };
  }

  const body = JSON.stringify({
    model: VISION_MODEL,
    messages: [
      {
        role: 'system',
        content: '你是一个专业的图像分析助手。请用中文回答，提供详细、准确的图像分析。如果图片包含文字，请完整识别。如果是图表或数据可视化，请分析数据趋势和关键指标。',
      },
      {
        role: 'user',
        content: contentParts,
      },
    ],
    max_completion_tokens: 2000,
    temperature: 0.3,
  });

  logger.info(`[${ts()}] [R35-T1] Vision request: model=${VISION_MODEL} images=${imageUrls.length} detail=${detail} question="${(question || 'general').substring(0, 60)}"`);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy();
      logger.warn(`[${ts()}] [R35-T1] Vision timeout, trying fallback model`);
      // Try fallback model
      tryFallback(apiKey, contentParts, resolve);
    }, DEFAULT_TIMEOUT);

    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const json = JSON.parse(data);
            if (json.error) {
              logger.error(`[${ts()}] [R35-T1] Vision API error: ${json.error.message}`);
              // Try fallback on error
              tryFallback(apiKey, contentParts, resolve);
              return;
            }
            const analysis = json.choices?.[0]?.message?.content || '';
            const usage = json.usage || {};
            logger.info(`[${ts()}] [R35-T1] Vision success: ${analysis.length} chars, tokens: ${usage.total_tokens || 0}`);
            resolve({
              success: true,
              phase: 'done',
              analysis,
              model: VISION_MODEL,
              image_count: imageUrls.length,
              tokens_used: usage.total_tokens || 0,
              prompt_tokens: usage.prompt_tokens || 0,
              completion_tokens: usage.completion_tokens || 0,
            });
          } catch (parseErr) {
            logger.error(`[${ts()}] [R35-T1] Vision parse error: ${parseErr.message}`);
            resolve({
              success: false,
              phase: 'failed',
              error: `Response parse error: ${parseErr.message}`,
              analysis: '',
            });
          }
        });
      }
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      logger.error(`[${ts()}] [R35-T1] Vision request error: ${err.message}`);
      tryFallback(apiKey, contentParts, resolve);
    });

    req.write(body);
    req.end();
  });
}

// ─── Fallback to gpt-4o-mini ───
function tryFallback(apiKey, contentParts, resolve) {
  logger.info(`[${ts()}] [R35-T1] Trying fallback model: ${FALLBACK_MODEL}`);
  const body = JSON.stringify({
    model: FALLBACK_MODEL,
    messages: [
      {
        role: 'system',
        content: '你是一个图像分析助手。请用中文简洁回答。',
      },
      {
        role: 'user',
        content: contentParts,
      },
    ],
    max_completion_tokens: 1000,
    temperature: 0.3,
  });

  const req = https.request(
    {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    },
    (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            resolve({
              success: false,
              phase: 'failed',
              error: `Vision API error: ${json.error.message}`,
              analysis: '',
            });
            return;
          }
          const analysis = json.choices?.[0]?.message?.content || '';
          resolve({
            success: true,
            phase: 'done',
            analysis,
            model: FALLBACK_MODEL,
            image_count: contentParts.filter(p => p.type === 'image_url').length,
            tokens_used: json.usage?.total_tokens || 0,
            fallback: true,
          });
        } catch (e) {
          resolve({
            success: false,
            phase: 'failed',
            error: `Fallback parse error: ${e.message}`,
            analysis: '',
          });
        }
      });
    }
  );
  req.on('error', (err) => {
    resolve({
      success: false,
      phase: 'failed',
      error: `Fallback request error: ${err.message}`,
      analysis: '',
    });
  });
  req.write(body);
  req.end();
}

export default { handleAnalyzeImage, VISION_TOOL_DEFINITION };
