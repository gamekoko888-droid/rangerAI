// Stateless plan parsing helpers extracted from task-engine.mjs (R98)

// ─── Circled number map ───
const CIRCLED_NUMS = { "①": 1, "②": 2, "③": 3, "④": 4, "⑤": 5, "⑥": 6, "⑦": 7, "⑧": 8, "⑨": 9, "⑩": 10 };

/**
 * Parse a plan block from AI text output (v3.0 — ultra-flexible)
 * Returns null if no plan found, or a plan object
 */
export function parsePlanFromText(text) {
  if (!text) return null;
  
  // ─── Header detection strategies (ordered by specificity) ───
  const headerPatterns = [
    // Strategy 1: 📋 emoji header
    /📋\s*\*{0,2}[任务]*[计划分解]\*{0,2}[：:]?\s*\n/,
    // Strategy 2: 【xxx】bracket header (任务计划/任务分解/执行计划/分析计划)
    /【(?:任务[计划分解]|执行计划|行动计划|分析计划|工作计划)】[：:]?\s*\n?/,
    // Strategy 3: **任务计划** bold header
    /\*{2}(?:任务[计划分解]|执行计划|行动计划|分析计划)\*{2}[：:]?\s*\n/,
    // Strategy 4: 任务计划：plain text header
    /^(?:任务[计划分解]|执行计划|行动计划)[：:]\s*\n/m,
  ];
  
  let headerMatch = null;
  for (const pattern of headerPatterns) {
    headerMatch = text.match(pattern);
    if (headerMatch) break;
  }
  
  // ─── Strategy 5: Inline plan without explicit header ───
  // Match: 步骤：①xxx → ②xxx or 步骤：①xxx ②xxx
  let isInlinePlan = false;
  let inlineMatch = null;
  if (!headerMatch) {
    inlineMatch = text.match(/(?:步骤|计划|流程)[：:]\s*(①.+)/);
    if (inlineMatch) {
      isInlinePlan = true;
    }
  }
  
  if (!headerMatch && !isInlinePlan) return null;
  
  // ─── Extract text after header ───
  let afterHeader;
  if (isInlinePlan) {
    afterHeader = inlineMatch[1];
  } else {
    const headerEnd = headerMatch.index + headerMatch[0].length;
    afterHeader = text.substring(headerEnd);
  }
  
  // ─── Extract goal line (optional) ───
  let goal = "";
  const goalRegex = /^(?:\*\s*)?(?:目标|目的|总目标)[：:]\s*(.+?)(?:\n|$)/m;
  const goalMatch = afterHeader.match(goalRegex);
  if (goalMatch) {
    goal = goalMatch[1].trim().replace(/\*+/g, "");
  }
  
  // ─── Extract plan items with multiple format support ───
  const phases = [];
  let usedPattern = null;
  
  // ─── Pattern A: Circled numbers ①②③④ (inline or multiline) ───
  const circledRegex = /([①②③④⑤⑥⑦⑧⑨⑩])\s*([^①②③④⑤⑥⑦⑧⑨⑩\n→➡]+)/g;
  let match;
  while ((match = circledRegex.exec(afterHeader)) !== null) {
    const num = CIRCLED_NUMS[match[1]] || phases.length + 1;
    let title = match[2].trim();
    // Clean trailing punctuation and arrows
    title = title.replace(/[→➡\s]+$/, "").trim();
    if (title.length < 2) continue;
    const toolMatch = title.match(/\[tools?:\s*([^\]]+)\]/i);
    const allowedTools = toolMatch ? toolMatch[1].trim().split(/[,\s]+/) : ['all'];
    title = title.replace(/\s*\[tools?:[^\]]+\]/i, '').trim();
    phases.push({ id: num, title, status: "pending", allowedTools });
    usedPattern = "circled";
  }
  
  // ─── Pattern B: Checkbox format - [ ] xxx / - [x] xxx ───
  if (phases.length === 0) {
    const checkboxRegex = /- \[([ x])\]\s*(?:(?:步骤|阶段)\s*)?(\d+)?[：:.]?\s*(.+)/g;
    while ((match = checkboxRegex.exec(afterHeader)) !== null) {
      const isCompleted = match[1] === "x";
      const stepNum = match[2] ? parseInt(match[2]) : phases.length + 1;
      const title = match[3].trim();
      if (title.length < 2) continue;
      const toolMatchC = title.match(/\[tools?:\s*([^\]]+)\]/i);
      const allowedToolsC = toolMatchC ? toolMatchC[1].trim().split(/[,\s]+/) : ['all'];
      title = title.replace(/\s*\[tools?:[^\]]+\]/i, '').trim();
      phases.push({ id: stepNum, title, status: isCompleted ? "completed" : "pending", allowedTools: allowedToolsC });
      usedPattern = "checkbox";
    }
  }
  
  // ─── Pattern C: Numbered list 1. xxx / 2) xxx ───
  if (phases.length === 0) {
    const nearHeader = afterHeader.substring(0, 800);
    const numberedRegex = /^(\d+)[.)]\s+(.+)/gm;
    while ((match = numberedRegex.exec(nearHeader)) !== null) {
      const stepNum = parseInt(match[1]);
      const title = match[2].trim();
      if (title.length > 120 || title.length < 2) continue;
      const toolMatchN = title.match(/\[tools?:\s*([^\]]+)\]/i);
      const allowedToolsN = toolMatchN ? toolMatchN[1].trim().split(/[,\s]+/) : ['all'];
      title = title.replace(/\s*\[tools?:[^\]]+\]/i, '').trim();
      phases.push({ id: stepNum, title, status: "pending", allowedTools: allowedToolsN });
      usedPattern = "numbered";
    }
  }
  
  // ─── Pattern D: 步骤N：xxx / 阶段N：xxx (labeled steps) ───
  if (phases.length === 0) {
    const nearHeader = afterHeader.substring(0, 800);
    const labeledRegex = /(?:步骤|阶段)\s*(\d+)[：:.]\s*(.+?)(?:\n|$)/gm;
    while ((match = labeledRegex.exec(nearHeader)) !== null) {
      const stepNum = parseInt(match[1]);
      const title = match[2].trim();
      if (title.length > 120 || title.length < 2) continue;
      phases.push({ id: stepNum, title, status: "pending" });
      usedPattern = "labeled";
    }
  }
  
  // ─── Pattern E: Simple bullet list - xxx ───
  if (phases.length === 0) {
    const nearHeader = afterHeader.substring(0, 500);
    const bulletRegex = /^- (.+)/gm;
    let bulletIdx = 0;
    while ((match = bulletRegex.exec(nearHeader)) !== null) {
      bulletIdx++;
      const title = match[1].trim();
      if (title.length > 100 || title.length < 2) continue;
      if (title.startsWith("注意") || title.startsWith("说明") || title.startsWith("风险")) continue;
      phases.push({ id: bulletIdx, title, status: "pending" });
      usedPattern = "bullet";
    }
  }
  
  // ─── Pattern F: Arrow-separated inline steps (xxx → xxx → xxx) ───
  if (phases.length === 0) {
    const arrowMatch = afterHeader.match(/(.+?(?:→|➡).+)/);
    if (arrowMatch) {
      const parts = arrowMatch[1].split(/\s*[→➡]\s*/);
      parts.forEach((part, idx) => {
        const title = part.trim().replace(/^\d+[.)：:]\s*/, "");
        if (title.length >= 2 && title.length <= 100) {
          phases.push({ id: idx + 1, title, status: "pending" });
        }
      });
      usedPattern = "arrow";
    }
  }
  
  if (phases.length < 2) return null;
  
  // Set first pending phase as "running"
  const firstPending = phases.find(p => p.status === "pending");
  if (firstPending) firstPending.status = "running";
  
  return {
    id: `plan-${Date.now()}`,
    goal: goal || phases[0]?.title || "任务执行中",
    phases,
    currentPhaseId: firstPending ? firstPending.id : phases[phases.length - 1].id,
    totalPhases: phases.length,
    completedPhases: phases.filter(p => p.status === "completed").length,
    createdAt: Date.now(),
    _pattern: usedPattern,
  };
}

/**
 * Parse phase completion markers from AI text (v3.0 — flexible matching)
 * Matches multiple formats:
 * - ✅ 步骤N：xxx（已完成）
 * - ✅ 阶段N：xxx（已完成）
 * - ✅ N. xxx（完成）
 * - ✅ xxx 已完成
 * - ✅ ①xxx 完成
 * Returns: { phaseId: number, title: string } or null
 */
export function parsePhaseCompletion(text) {
  if (!text) return null;
  
  // Pattern 1: ✅ 步骤/阶段N：xxx
  const pattern1 = /✅\s*(?:步骤|阶段)\s*(\d+)[：:.]\s*(.+?)(?:（已完成）|（完成）|\(完成\)|\(已完成\)|已完成|完成|$)/;
  // Pattern 2: ✅ N. xxx or ✅ N：xxx
  const pattern2 = /✅\s*(\d+)[.)：:.]\s*(.+?)(?:（已完成）|（完成）|\(完成\)|\(已完成\)|已完成|完成|$)/;
  // Pattern 3: ✅ ①②③ circled number
  const pattern3 = /✅\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*(.+?)(?:（已完成）|（完成）|\(完成\)|\(已完成\)|已完成|完成|$)/;
  
  let match = text.match(pattern1) || text.match(pattern2);
  if (match) {
    return { phaseId: parseInt(match[1]), title: match[2].trim() };
  }
  
  match = text.match(pattern3);
  if (match) {
    return { phaseId: CIRCLED_NUMS[match[1]] || 1, title: match[2].trim() };
  }
  
  return null;
}

/**
 * Parse recovery marker from AI text
 * Matches: 🔄 恢复任务，从步骤 N 继续...
 */
export function parseRecoveryMarker(text) {
  if (!text) return null;
  
  const recoveryRegex = /🔄\s*恢复任务.*?(?:步骤|阶段)\s*(\d+)/;
  const match = text.match(recoveryRegex);
  if (!match) return null;
  
  return { resumeFromPhase: parseInt(match[1]) };
}


/**
 * Extract user goal from a message using simple heuristics.
 * For complex extraction, use LLM (done in user-message-handler).
 */
export function extractGoalHeuristic(message) {
  if (!message || message.length < 10) return null;
  
  // If message is short enough, use it directly
  if (message.length <= 200) return message.trim();
  
  // Try to extract the first sentence or question
  const firstSentence = message.match(/^[^.!?。！？]+[.!?。！？]/);
  if (firstSentence) return firstSentence[0].trim();
  
  // Fallback: first 200 chars
  return message.substring(0, 200).trim() + '...';
}

