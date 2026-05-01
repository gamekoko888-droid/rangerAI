/**
 * RangerAI Worker - Segmentation Module
 * Handles splitting long documents/contexts into segments for Gateway infusion.
 */

const GATEWAY_SAFE_LENGTH = 12000;
const SEGMENT_SIZE = 4000;
const MAX_SEGMENTS = 5;

/**
 * Utility to split text into chunks of roughly targetSize.
 */
export function splitIntoSegments(text, targetSize = SEGMENT_SIZE, maxSegments = MAX_SEGMENTS) {
  if (!text) return [];
  const segments = [];
  let remaining = text;
  
  while (remaining.length > 0 && segments.length < maxSegments) {
    let splitAt = targetSize;
    if (remaining.length > splitAt) {
      const lastNewline = remaining.lastIndexOf('\n', splitAt);
      if (lastNewline > targetSize * 0.7) splitAt = lastNewline;
    }
    
    segments.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }
  
  if (remaining.length > 0 && segments.length > 0) {
    segments[segments.length - 1] += "\n\n... (后续内容已省略)";
  }
  
  return segments;
}

/**
 * Strategy-based message segmenter for user message + context.
 */
export function segmentLongMessage(message) {
  // Strategy A: KNOWLEDGE_CONTEXT tags
  const ctxStart = message.indexOf("[KNOWLEDGE_CONTEXT]");
  const ctxEnd = message.indexOf("[/KNOWLEDGE_CONTEXT]");
  
  if (ctxStart !== -1 && ctxEnd !== -1) {
    const beforeCtx = message.substring(0, ctxStart).trim();
    const contextBody = message.substring(ctxStart + "[KNOWLEDGE_CONTEXT]".length, ctxEnd).trim();
    const afterCtx = message.substring(ctxEnd + "[/KNOWLEDGE_CONTEXT]".length).trim();
    
    const userQuestion = afterCtx || beforeCtx;
    const segments = splitIntoSegments(contextBody);
    
    let finalQuestion = userQuestion;
    if (finalQuestion.length > GATEWAY_SAFE_LENGTH) {
      finalQuestion = finalQuestion.substring(0, GATEWAY_SAFE_LENGTH - 100) + "\n\n... (问题已截断)";
    }
    
    return { segments, question: finalQuestion };
  }

  // Strategy B: File markers
  if (message.includes("--- 文件:")) {
    const segments = [];
    const question = message.replace(/--- 文件: .+? ---[\s\S]+?--- 文件结束 ---/g, (match) => {
      segments.push(match);
      return "[已注入文件内容到上下文]";
    });
    return { segments: segments.slice(0, MAX_SEGMENTS), question };
  }

  return { segments: [], question: message };
}
