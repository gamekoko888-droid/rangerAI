/**
 * vision-handler.mjs — 视觉消息处理管道
 * 从 user-message-handler.mjs 中提取（Iter-63 重构）
 *
 * v25.1 重大修复：纯理解路径不再绕过 Gateway
 *
 * 职责：
 *   1. 判断图片消息是"需要工具操作"还是"纯理解/参考截图"
 *   2. 工具操作路径：下载图片到工作区，增强消息后 fall-through 到 Gateway
 *   3. 纯理解路径（v25.1）：下载图片到工作区，增强消息后 fall-through 到 Gateway
 *      （之前直接调用 Direct API，绕过 Gateway，导致上下文丢失）
 *
 * 返回值：
 *   { handled: false, userMessage: string } — 需要 fall-through，调用方继续执行 Gateway 流程
 *   （v25.1: 不再返回 handled: true，所有路径都 fall-through 到 Gateway）
 */

import fs from "fs";
import { sendEvent, sendStep, updateStep } from "./ipc-utils.mjs";
import { estimateTokens } from "./format-utils.mjs";

import { logger } from '../lib/logger.mjs';
const ts = () => new Date().toISOString();

/** 判断图片消息是否需要工具操作（编辑/生成），而非纯理解 */
function needsToolExecution(userMessage) {
  const msg = userMessage.toLowerCase();
  const ctxEndIdx = msg.indexOf("[/knowledge_context]");
  const questionPart = ctxEndIdx !== -1 ? msg.substring(ctxEndIdx + 20) : msg;

  const toolKeywords = [
    /nano\s*banana/i, /nanobanana/i,
    /修改这[张个幅].*图/i, /编辑这[张个幅].*图/i, /处理这[张个幅].*图/i,
    /把.*图.*[变改换]/i, /图片.*编辑/i,
    /[把帮].*变成/i, /[把帮].*改成/i, /[把帮].*换成/i, /[把帮].*替换/i,
    /加上.*[到在]/i, /去掉.*[中里上]/i, /去除.*[中里上]/i,
    /头发.*变/i, /变.*头发/i, /换.*发型/i,
    /背景.*换/i, /换.*背景/i,
    /风格.*转/i, /转.*风格/i,
    /生成一[张个幅]/i, /画一[张个幅]/i, /做一[张个幅]/i,
    /用.*生成.*图/i, /用.*画.*图/i,
    /generate.*image/i, /edit.*image/i, /modify.*image/i
  ];

  return toolKeywords.some(kw => kw.test(questionPart));
}

/** 下载图片附件到本地工作区，返回本地路径数组 */
async function downloadImagesToWorkspace(imageAttachments) {
  const downloadedPaths = [];
  for (const img of imageAttachments) {
    try {
      const url = img.url;
      const ext = (url.match(/\.(png|jpg|jpeg|webp|gif)/i) || [".png"])[0];
      const filename = `user-upload-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
      const localPath = `/home/admin/.openclaw/workspace/${filename}`;
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      await execAsync(`curl -sL -o "${localPath}" "${url}"`, { timeout: 30000 });
      if (fs.existsSync(localPath) && fs.statSync(localPath).size > 0) {
        downloadedPaths.push(localPath);
        logger.info(`[${ts()}] [vision] Downloaded: ${localPath} (${fs.statSync(localPath).size} bytes)`);
      }
    } catch (err) {
      logger.info(`[${ts()}] [vision] Download failed: ${err.message}`);
    }
  }
  return downloadedPaths;
}

/**
 * 处理含图片附件的消息。
 *
 * v25.1: ALL paths now fall-through to Gateway to preserve conversation context.
 * Previously, the "pure understanding" path called Direct API directly, which
 * bypassed the Gateway session and caused context loss on the next message.
 *
 * @returns {{ handled: boolean, content?: string, userMessage?: string }}
 */
export async function handleVisionMessage(msgId, userMessage, attachments, conversationHistory, routing, { forceVision = false } = {}) {
  const imageAttachments = attachments.filter(a => a.type === "image" && a.url);
  if (imageAttachments.length === 0) return { handled: false, userMessage };

  const requiresTool = forceVision ? false : needsToolExecution(userMessage);

  // ── v25.1: ALL image messages go through Gateway via fall-through ──
  // Download images to workspace and augment the message, then let Gateway handle it.
  // This ensures the AI's response is part of the Gateway session history,
  // preventing context loss on subsequent messages.

  logger.info(`[${ts()}] [vision] [v25.1] Image message detected (requiresTool=${requiresTool}), downloading to workspace for Gateway fall-through`);
  
  const stepId = sendStep(msgId, "📷 准备图片资源", "running", `正在处理 ${imageAttachments.length} 个附件...`);
  const downloadedPaths = await downloadImagesToWorkspace(imageAttachments);
  
  if (downloadedPaths.length > 0) {
    updateStep(msgId, stepId, "success", `已就绪 ${downloadedPaths.length} 张图`);
    
    const pathList = downloadedPaths.map(p => `- ${p}`).join("\n");
    
    let imageNote;
    if (requiresTool) {
      // Tool execution path: include nano-banana hint for image editing
      imageNote = `[用户上传了${downloadedPaths.length}张图片，已保存到工作区]\n图片路径:\n${pathList}\n\nuv run /opt/openclaw/skills/nano-banana-pro/scripts/generate_image.py --prompt "编辑指令" --filename "output.png" -i "${downloadedPaths[0]}"\n\n`;
    } else {
      // Pure understanding path: just provide image paths as context
      const urlList = imageAttachments.map(a => `- ${a.url}`).join("\n");
      imageNote = `[用户上传了${downloadedPaths.length}张截图作为参考]\n图片路径:\n${pathList}\n图片URL:\n${urlList}\n请仔细查看截图内容来理解用户的问题。\n\n`;
    }

    const ctxStartIdx = userMessage.indexOf("[KNOWLEDGE_CONTEXT]");
    const enrichedMessage = ctxStartIdx > 0
      ? userMessage.substring(0, ctxStartIdx) + imageNote + userMessage.substring(ctxStartIdx)
      : imageNote + userMessage;

    if (requiresTool) {
      sendEvent(msgId, { type: "thinking", content: "🔧 图片已准备就绪，正在调用 AI 工具处理...\n" });
    } else {
      sendEvent(msgId, { type: "thinking", content: "📷 截图已准备就绪，正在分析...\n" });
    }
    
    logger.info(`[${ts()}] [vision] [v25.1] Augmented message with ${downloadedPaths.length} image(s), falling through to Gateway (preserves context)`);
    return { handled: false, userMessage: enrichedMessage };
  }

  // Download failed — still fall through to Gateway with original message + image URLs
  updateStep(msgId, stepId, "error", "图片下载失败，使用URL引用");
  logger.info(`[${ts()}] [vision] [v25.1] Image download failed, falling through with URL references`);
  
  // Even if download fails, include image URLs in the message for Gateway's vision model
  const urlList = imageAttachments.map(a => `- ${a.url}`).join("\n");
  const urlNote = `[用户上传了${imageAttachments.length}张图片]\n图片URL:\n${urlList}\n请参考这些截图来理解用户的问题。\n\n`;
  const enrichedMessage = urlNote + userMessage;
  
  return { handled: false, userMessage: enrichedMessage };
}
