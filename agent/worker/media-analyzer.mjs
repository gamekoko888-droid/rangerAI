/**
 * media-analyzer.mjs — [R44-T6] Multimodal Media Analyzer
 *
 * Provides unified media analysis capabilities:
 *   - analyze_video: Extract frames and analyze video content via vision LLM
 *   - analyze_audio: Transcribe and analyze audio content via Whisper + LLM
 *   - analyze_document: Parse and analyze PDF/document content
 *
 * Emits events: media_analyzed (with type, model, tokens, duration)
 *
 * Usage:
 *   import { analyzeMedia, MEDIA_TOOL_DEFINITIONS } from './media-analyzer.mjs';
 */
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import https from 'https';
import http from 'http';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

// ─── Logger ───
let _logger = null;
function getLogger() {
  if (!_logger) {
    try {
      const { createLogger } = _require('./logger.cjs');
      _logger = createLogger('media-analyzer');
    } catch {
      _logger = { info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    }
  }
  return _logger;
}
const ts = () => new Date().toISOString();
const logger = getLogger();

// ─── Constants ───
const UPLOAD_DIR = '/opt/rangerai-agent/uploads/media/';
const FILESERVER_BASE_URL = 'https://ranger.voyage';
const MAX_FRAMES = 4;  // Max video frames to extract

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ─── Tool Definitions ───
export const MEDIA_TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'analyze_video',
      description: '分析视频内容。提取关键帧并使用视觉模型分析视频中的场景、文字、动作等。支持 mp4、webm、mov 格式。',
      parameters: {
        type: 'object',
        properties: {
          video_url: { type: 'string', description: '视频 URL 或本地路径' },
          question: { type: 'string', description: '关于视频的具体问题（可选）' },
          max_frames: { type: 'number', description: '最大提取帧数（默认4）' },
        },
        required: ['video_url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_audio',
      description: '分析音频内容。先转录为文字，再用 LLM 分析内容。支持 mp3、wav、m4a、ogg、webm 格式。',
      parameters: {
        type: 'object',
        properties: {
          audio_url: { type: 'string', description: '音频 URL 或本地路径' },
          question: { type: 'string', description: '关于音频的具体问题（可选）' },
          language: { type: 'string', description: '音频语言（ISO 639-1，如 zh、en）' },
        },
        required: ['audio_url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_document',
      description: '分析文档内容（PDF、图片中的文字等）。使用 OCR 和 LLM 提取并分析文档信息。',
      parameters: {
        type: 'object',
        properties: {
          document_url: { type: 'string', description: '文档 URL 或本地路径' },
          question: { type: 'string', description: '关于文档的具体问题（可选）' },
        },
        required: ['document_url'],
      },
    },
  },
];

// ─── Helper: Download file ───
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ws = fs.createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(destPath); });
      ws.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Helper: Call LLM with vision ───
async function callVisionLLM(messages, model = 'openai/gpt-5.4') {
  const { invokeLLM } = await import('./llm-bridge.mjs');
  const startMs = Date.now();
  const result = await invokeLLM({
    model,
    messages,
    maxTokens: 2000,
    temperature: 0.3,
  });
  const durationMs = Date.now() - startMs;
  return {
    content: result.content || result.choices?.[0]?.message?.content || '',
    model: result.model || model,
    tokens: result.usage?.total_tokens || 0,
    durationMs,
  };
}

// ─── Helper: Call Whisper for transcription ───
async function transcribeAudio(audioPath, language) {
  const { readFileSync } = fs;
  const FormData = (await import('form-data')).default;
  
  // Read OpenAI API key from config
  let apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    try {
      const config = JSON.parse(fs.readFileSync('/home/admin/.openclaw/openclaw.json', 'utf8'));
      const openaiProvider = config.providers?.find(p => p.name === 'openai');
      apiKey = openaiProvider?.apiKey;
    } catch (e) {
      logger.warn(`[${ts()}] [media-analyzer] Failed to read OpenAI key from config: ${e.message}`);
    }
  }
  
  if (!apiKey) throw new Error('No OpenAI API key available for transcription');
  
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);
  form.append('response_format', 'verbose_json');
  
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 60000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200) reject(new Error(`Whisper API error: ${body}`));
          else resolve(data);
        } catch (e) { reject(new Error(`Parse error: ${body.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

// ─── Emit media_analyzed event ───
async function emitMediaEvent(sessionKey, taskId, mediaType, payload) {
  try {
    const { emitEvent } = await import('./event-stream.mjs');
    emitEvent(sessionKey, taskId, 'media_analyzed', {
      mediaType,
      ...payload,
      analyzedAt: new Date().toISOString(),
    });
  } catch (e) {
    logger.warn(`[${ts()}] [media-analyzer] Failed to emit event: ${e.message}`);
  }
}

// ─── Main: Analyze Video ───
export async function handleAnalyzeVideo(args, context = {}) {
  const { video_url, question, max_frames = MAX_FRAMES } = args;
  const startMs = Date.now();
  logger.info(`[${ts()}] [R45-T5] analyze_video: url="${video_url?.substring(0, 80)}" question="${(question || '').substring(0, 60)}" max_frames=${max_frames}`);
  
  try {
    let videoPath = video_url;
    let tempVideoFile = null;
    const frameDir = path.join(UPLOAD_DIR, `frames-${Date.now()}`);
    
    // Step 1: Download video if URL
    if (video_url.startsWith('http')) {
      const urlObj = new URL(video_url);
      const ext = path.extname(urlObj.pathname) || '.mp4';
      tempVideoFile = path.join(UPLOAD_DIR, `video-${Date.now()}${ext}`);
      logger.info(`[${ts()}] [R45-T5] Downloading video to ${tempVideoFile}`);
      await downloadFile(video_url, tempVideoFile);
      videoPath = tempVideoFile;
    }
    
    if (!fs.existsSync(videoPath)) {
      throw new Error(`Video not found: ${videoPath}`);
    }
    
    const fileSizeMB = (fs.statSync(videoPath).size / (1024 * 1024)).toFixed(2);
    logger.info(`[${ts()}] [R45-T5] Video file: ${fileSizeMB}MB`);
    
    // Step 2: Get video duration and metadata via ffprobe
    let duration = 0;
    let videoInfo = {};
    try {
      const probeOutput = execSync(
        `ffprobe -v quiet -print_format json -show_format -show_streams "${videoPath}" 2>/dev/null`,
        { maxBuffer: 5 * 1024 * 1024, timeout: 15000 }
      ).toString();
      const probe = JSON.parse(probeOutput);
      duration = parseFloat(probe.format?.duration || '0');
      const videoStream = probe.streams?.find(s => s.codec_type === 'video');
      videoInfo = {
        duration: duration.toFixed(1) + 's',
        width: videoStream?.width || 0,
        height: videoStream?.height || 0,
        codec: videoStream?.codec_name || 'unknown',
        fps: videoStream?.r_frame_rate || 'unknown',
        size: fileSizeMB + 'MB',
      };
      logger.info(`[${ts()}] [R45-T5] Video info: ${JSON.stringify(videoInfo)}`);
    } catch (probeErr) {
      logger.warn(`[${ts()}] [R45-T5] ffprobe failed: ${probeErr.message}`);
      duration = 30; // fallback estimate
    }
    
    // Step 3: Extract keyframes using ffmpeg
    fs.mkdirSync(frameDir, { recursive: true });
    const numFrames = Math.min(max_frames, 8); // Cap at 8 frames
    const extractedFrames = [];
    
    try {
      if (duration > 0) {
        // Extract frames at even intervals
        const interval = duration / (numFrames + 1);
        for (let i = 1; i <= numFrames; i++) {
          const timestamp = (interval * i).toFixed(2);
          const framePath = path.join(frameDir, `frame_${String(i).padStart(2, '0')}.jpg`);
          try {
            execSync(
              `ffmpeg -y -ss ${timestamp} -i "${videoPath}" -vframes 1 -q:v 2 -vf "scale='min(1280,iw)':-2" "${framePath}" 2>/dev/null`,
              { timeout: 10000 }
            );
            if (fs.existsSync(framePath) && fs.statSync(framePath).size > 0) {
              extractedFrames.push({ path: framePath, timestamp: parseFloat(timestamp) });
            }
          } catch (frameErr) {
            logger.warn(`[${ts()}] [R45-T5] Frame extraction at ${timestamp}s failed: ${frameErr.message}`);
          }
        }
      }
      
      // Fallback: if interval extraction failed, try scene detection
      if (extractedFrames.length === 0) {
        logger.info(`[${ts()}] [R45-T5] Interval extraction failed, trying thumbnail filter`);
        const thumbPath = path.join(frameDir, 'thumb_%02d.jpg');
        try {
          execSync(
            `ffmpeg -y -i "${videoPath}" -vf "thumbnail=${Math.max(30, Math.floor(duration * 2))},setpts=N/TB" -vframes ${numFrames} -q:v 2 "${thumbPath}" 2>/dev/null`,
            { timeout: 30000 }
          );
          const thumbFiles = fs.readdirSync(frameDir).filter(f => f.startsWith('thumb_')).sort();
          for (const tf of thumbFiles) {
            const fp = path.join(frameDir, tf);
            if (fs.statSync(fp).size > 0) {
              extractedFrames.push({ path: fp, timestamp: 0 });
            }
          }
        } catch (thumbErr) {
          logger.warn(`[${ts()}] [R45-T5] Thumbnail extraction also failed: ${thumbErr.message}`);
        }
      }
      
      logger.info(`[${ts()}] [R45-T5] Extracted ${extractedFrames.length} frames`);
    } catch (ffmpegErr) {
      logger.error(`[${ts()}] [R45-T5] ffmpeg extraction error: ${ffmpegErr.message}`);
    }
    
    // Step 4: Build Vision API request with extracted frames
    let result;
    if (extractedFrames.length > 0) {
      // Encode frames as base64 and send to Vision API
      const imageContents = extractedFrames.map((frame, idx) => {
        const imageData = fs.readFileSync(frame.path);
        const base64 = imageData.toString('base64');
        return {
          type: 'image_url',
          image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' },
        };
      });
      
      const frameDescriptions = extractedFrames.map((f, i) => 
        `Frame ${i + 1}: ${f.timestamp > 0 ? f.timestamp.toFixed(1) + 's' : 'keyframe'}`
      ).join(', ');
      
      const userContent = [
        ...imageContents,
        {
          type: 'text',
          text: `以上是从视频中提取的 ${extractedFrames.length} 个关键帧（${frameDescriptions}）。
视频信息: 时长=${videoInfo.duration || 'unknown'}, 分辨率=${videoInfo.width}x${videoInfo.height}, 编码=${videoInfo.codec}

${question ? `请回答以下问题: ${question}` : '请详细分析视频内容，包括：\n1. 场景描述和环境\n2. 人物/物体识别\n3. 动作和事件\n4. 文字信息（如有）\n5. 整体内容总结'}`,
        },
      ];
      
      // Try GPT-5.4 first (best vision), fallback to Gemini
      try {
        result = await callVisionLLM([
          { role: 'system', content: '你是一个专业的视频内容分析助手。你将收到从视频中提取的关键帧图片。请基于这些帧分析视频的完整内容。' },
          { role: 'user', content: userContent },
        ], 'openai/gpt-5.4');
      } catch (gptErr) {
        logger.warn(`[${ts()}] [R45-T5] GPT-5.4 vision failed, trying Gemini: ${gptErr.message}`);
        result = await callVisionLLM([
          { role: 'system', content: '你是一个专业的视频内容分析助手。' },
          { role: 'user', content: userContent },
        ], 'google/gemini-2.5-flash');
      }
    } else {
      // No frames extracted - fallback to text-only analysis
      logger.warn(`[${ts()}] [R45-T5] No frames extracted, using text-only fallback`);
      result = await callVisionLLM([
        { role: 'system', content: '你是一个视频分析助手。由于无法提取视频帧，请基于可用信息进行分析。' },
        { role: 'user', content: `视频URL: ${video_url}\n视频信息: ${JSON.stringify(videoInfo)}\n${question ? `问题: ${question}` : '请分析视频内容。'}` },
      ], 'openai/gpt-5.4-mini');
    }
    
    // Step 5: Cleanup temp files
    try {
      if (tempVideoFile && fs.existsSync(tempVideoFile)) fs.unlinkSync(tempVideoFile);
      if (fs.existsSync(frameDir)) {
        for (const f of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, f));
        fs.rmdirSync(frameDir);
      }
    } catch (cleanErr) {
      logger.warn(`[${ts()}] [R45-T5] Cleanup warning: ${cleanErr.message}`);
    }
    
    const durationMs = Date.now() - startMs;
    await emitMediaEvent(context.sessionKey, context.taskId, 'video', {
      url: video_url, model: result.model, tokens: result.tokens, durationMs,
      framesExtracted: extractedFrames.length,
      frameCount: extractedFrames.length,          // [R46-T1] G5 alias
      extractionMethod: extractedFrames.length > 0 ? "ffmpeg" : "text_fallback", // [R46-T1] G5
      videoInfo,
    });
    
    return {
      success: true,
      type: 'video',
      analysis: result.content,
      model: result.model,
      tokens_used: result.tokens,
      duration_ms: durationMs,
      frames_extracted: extractedFrames.length,
      frameCount: extractedFrames.length,          // [R46-T1] G5 alias
      extractionMethod: extractedFrames.length > 0 ? "ffmpeg" : "text_fallback", // [R46-T1] G5
      video_info: videoInfo,
    };
  } catch (err) {
    logger.error(`[${ts()}] [R45-T5] analyze_video error: ${err.message}`);
    return { success: false, error: err.message };
  }
}
// ─── Main: Analyze Audio ───
export async function handleAnalyzeAudio(args, context = {}) {
  const { audio_url, question, language } = args;
  const startMs = Date.now();
  logger.info(`[${ts()}] [R44-T6] analyze_audio: url="${audio_url?.substring(0, 80)}" language="${language || 'auto'}"`);
  
  try {
    let audioPath = audio_url;
    let tempFile = null;
    
    // Download if URL
    if (audio_url.startsWith('http')) {
      const ext = path.extname(new URL(audio_url).pathname) || '.mp3';
      tempFile = path.join(UPLOAD_DIR, `audio-${Date.now()}${ext}`);
      await downloadFile(audio_url, tempFile);
      audioPath = tempFile;
    }
    
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }
    
    // Step 1: Transcribe with Whisper
    const transcription = await transcribeAudio(audioPath, language);
    const transcriptText = transcription.text || '';
    const detectedLanguage = transcription.language || language || 'unknown';
    
    // Step 2: Analyze with LLM if question provided
    let analysis = '';
    let llmTokens = 0;
    if (question || transcriptText.length > 100) {
      const llmResult = await callVisionLLM([
        { role: 'system', content: '你是一个专业的音频内容分析助手。基于音频转录文本回答用户的问题。' },
        { role: 'user', content: `音频转录内容:\n${transcriptText}\n\n${question ? `问题: ${question}` : '请总结这段音频的主要内容和关键信息。'}` },
      ], 'openai/gpt-5.4-mini');
      analysis = llmResult.content;
      llmTokens = llmResult.tokens;
    }
    
    // Cleanup temp file
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
    }
    
    const durationMs = Date.now() - startMs;
    await emitMediaEvent(context.sessionKey, context.taskId, 'audio', {
      url: audio_url, model: 'whisper-1', tokens: llmTokens, durationMs,
      language: detectedLanguage, transcriptLength: transcriptText.length,
    });
    
    return {
      success: true,
      type: 'audio',
      transcript: transcriptText,
      language: detectedLanguage,
      analysis: analysis || null,
      duration_ms: durationMs,
      tokens_used: llmTokens,
      segments: transcription.segments?.length || 0,
    };
  } catch (err) {
    logger.error(`[${ts()}] [R44-T6] analyze_audio error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Main: Analyze Document ───
export async function handleAnalyzeDocument(args, context = {}) {
  const { document_url, question } = args;
  const startMs = Date.now();
  logger.info(`[${ts()}] [R44-T6] analyze_document: url="${document_url?.substring(0, 80)}"`);
  
  try {
    let docPath = document_url;
    let tempFile = null;
    
    // Download if URL
    if (document_url.startsWith('http')) {
      const ext = path.extname(new URL(document_url).pathname) || '.pdf';
      tempFile = path.join(UPLOAD_DIR, `doc-${Date.now()}${ext}`);
      await downloadFile(document_url, tempFile);
      docPath = tempFile;
    }
    
    if (!fs.existsSync(docPath)) {
      throw new Error(`Document not found: ${docPath}`);
    }
    
    const ext = path.extname(docPath).toLowerCase();
    let content = '';
    
    // Extract text based on file type
    if (ext === '.pdf') {
      // Try pdftotext
      const { execSync } = await import('child_process');
      try {
        content = execSync(`pdftotext "${docPath}" - 2>/dev/null`, { maxBuffer: 10 * 1024 * 1024 }).toString().trim();
      } catch (e) {
        content = `[PDF file: ${path.basename(docPath)}, size: ${(fs.statSync(docPath).size / 1024).toFixed(1)}KB]`;
      }
    } else if (['.txt', '.md', '.csv', '.json', '.xml', '.html'].includes(ext)) {
      content = fs.readFileSync(docPath, 'utf8').substring(0, 50000);
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      // Image document - use vision
      const imageData = fs.readFileSync(docPath);
      const base64 = imageData.toString('base64');
      const mimeType = ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      
      const result = await callVisionLLM([
        { role: 'system', content: '你是一个专业的文档分析助手。请提取并分析图片中的所有文字和信息。' },
        { role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
          { type: 'text', text: question || '请提取并分析这个文档/图片中的所有内容。' },
        ]},
      ], 'openai/gpt-5.4');
      
      if (tempFile && fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
      }
      
      const durationMs = Date.now() - startMs;
      await emitMediaEvent(context.sessionKey, context.taskId, 'document', {
        url: document_url, model: result.model, tokens: result.tokens, durationMs,
      });
      
      return {
        success: true,
        type: 'document',
        format: ext.replace('.', ''),
        analysis: result.content,
        model: result.model,
        tokens_used: result.tokens,
        duration_ms: durationMs,
      };
    } else {
      content = `[Unsupported format: ${ext}]`;
    }
    
    // Analyze extracted text with LLM
    const truncated = content.length > 30000 ? content.substring(0, 30000) + '\n...[truncated]' : content;
    const result = await callVisionLLM([
      { role: 'system', content: '你是一个专业的文档分析助手。请分析文档内容并回答用户的问题。' },
      { role: 'user', content: `文档内容:\n${truncated}\n\n${question ? `问题: ${question}` : '请总结这个文档的主要内容和关键信息。'}` },
    ], 'openai/gpt-5.4-mini');
    
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (e) { /* ignore */ }
    }
    
    const durationMs = Date.now() - startMs;
    await emitMediaEvent(context.sessionKey, context.taskId, 'document', {
      url: document_url, model: result.model, tokens: result.tokens, durationMs,
      format: ext.replace('.', ''), contentLength: content.length,
    });
    
    return {
      success: true,
      type: 'document',
      format: ext.replace('.', ''),
      content_preview: content.substring(0, 500),
      analysis: result.content,
      model: result.model,
      tokens_used: result.tokens,
      duration_ms: durationMs,
    };
  } catch (err) {
    logger.error(`[${ts()}] [R44-T6] analyze_document error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Unified entry point ───
export async function analyzeMedia(toolName, args, context = {}) {
  switch (toolName) {
    case 'analyze_video': return handleAnalyzeVideo(args, context);
    case 'analyze_audio': return handleAnalyzeAudio(args, context);
    case 'analyze_document': return handleAnalyzeDocument(args, context);
    default: return { success: false, error: `Unknown media tool: ${toolName}` };
  }
}

export default { analyzeMedia, handleAnalyzeVideo, handleAnalyzeAudio, handleAnalyzeDocument, MEDIA_TOOL_DEFINITIONS };
