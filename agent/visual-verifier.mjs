/**
 * visual-verifier.mjs — Visual verification module for RangerAI.
 * 
 * Automatically takes screenshots after code changes and uses vision
 * to verify the result matches expectations. Integrates with the
 * browser automation already available in OpenClaw.
 * 
 * v1.0: Initial implementation
 */

import { saveCheckpoint } from './checkpoint-manager.mjs';

import { logger } from './lib/logger.mjs';
// ─── Verification Strategies ─────────────────────────────────

/**
 * Build a verification prompt for the vision model.
 * This is injected into the AI's context when it needs to verify its work.
 * 
 * @param {string} taskDescription - What the AI was trying to accomplish
 * @param {string} screenshotUrl - URL of the screenshot to verify
 * @returns {string} Prompt for the vision model
 */
export function buildVerificationPrompt(taskDescription, screenshotUrl) {
  return `你刚刚完成了以下开发任务，请通过截图验证结果：

**任务描述：** ${taskDescription}

请仔细查看截图，检查以下方面：
1. **功能完整性** — 预期的 UI 元素是否都存在？
2. **布局正确性** — 元素位置、对齐、间距是否合理？
3. **样式一致性** — 颜色、字体、边框是否与设计一致？
4. **错误检查** — 是否有报错信息、空白区域、或异常显示？
5. **响应式** — 在当前视口下是否正常显示？

请给出验证结论：
- ✅ 通过：如果所有方面都正常
- ⚠️ 部分通过：如果有小问题但不影响核心功能
- ❌ 失败：如果有明显错误需要修复

如果失败，请具体说明需要修复的问题。`;
}

// ─── Verification State Tracking ─────────────────────────────

const verificationHistory = [];

/**
 * Record a verification result.
 * @param {object} result
 * @param {string} result.taskId - Task/message ID
 * @param {string} result.description - What was verified
 * @param {'pass' | 'partial' | 'fail'} result.status - Verification result
 * @param {string} result.details - Detailed findings
 * @param {string} [result.screenshotUrl] - Screenshot URL
 */
export async function recordVerification(result) {
  const entry = {
    ...result,
    timestamp: Date.now(),
    id: `verify-${Date.now()}`,
  };
  verificationHistory.push(entry);
  
  // Keep only last 50 entries
  if (verificationHistory.length > 50) {
    verificationHistory.splice(0, verificationHistory.length - 50);
  }
  
  logger.info(`[visual-verify] ${result.status.toUpperCase()}: ${result.description}`);
  
  // Auto-save checkpoint on successful verification
  if (result.status === 'pass') {
    await saveCheckpoint(`Verified: ${result.description}`, result.taskId);
  }
  
  return entry;
}

/**
 * Get recent verification history.
 * @param {number} [limit=10]
 * @returns {Array}
 */
export function getVerificationHistory(limit = 10) {
  return verificationHistory.slice(-limit);
}

// ─── SOUL.md Integration ─────────────────────────────────────

/**
 * Generate the verification instructions to inject into SOUL.md context.
 * These instructions tell the AI how to perform visual verification.
 * 
 * This is already handled by the SOUL.md §3.5 自主验收协议 section,
 * but this function provides programmatic access to the same instructions.
 */
export function getVerificationInstructions() {
  return `
## 视觉验收流程

当你完成一个开发子任务后，必须执行以下验收步骤：

1. **截图验证**：使用浏览器工具打开目标页面，截取当前状态
2. **视觉检查**：检查截图中的 UI 是否符合预期
3. **功能测试**：如果涉及交互，点击/输入测试关键流程
4. **记录结果**：在进度汇报中说明验收结果
5. **修复循环**：如果验收失败，立即修复并重新验收（最多3轮）

### 验收标准
- 页面无报错（控制台无红色错误）
- UI 元素完整显示（无空白、无错位）
- 交互功能正常（按钮可点击、表单可提交）
- 样式与设计一致（颜色、字体、间距）
`;
}

// ─── Auto-Verify Hook ────────────────────────────────────────

/**
 * Determine if a tool call result should trigger auto-verification.
 * Called by openclaw-handler after tool_end events.
 * 
 * @param {string} toolName - Name of the completed tool
 * @param {object} toolResult - Result of the tool call
 * @returns {boolean} Whether to trigger visual verification
 */
export function shouldAutoVerify(toolName, toolResult) {
  // Trigger verification after file writes to frontend code
  const frontendTools = ['write_file', 'edit_file', 'create_file'];
  if (frontendTools.includes(toolName)) {
    const path = toolResult?.path || '';
    const isFrontend = path.match(/\.(tsx?|jsx?|css|html|vue|svelte)$/);
    return !!isFrontend;
  }
  
  // Trigger after shell commands that might affect the build
  if (toolName === 'execute_command') {
    const cmd = toolResult?.command || '';
    const isBuildCmd = cmd.match(/npm run|pnpm|yarn|vite|webpack|build|deploy/);
    return !!isBuildCmd;
  }
  
  return false;
}

/**
 * Build auto-verification context message.
 * Injected as a system message after relevant tool completions.
 * 
 * @param {string} toolName - Tool that triggered verification
 * @param {string} filePath - File that was modified
 * @returns {string} System message to inject
 */
export function buildAutoVerifyMessage(toolName, filePath) {
  return `[系统提示] 你刚刚修改了前端文件 ${filePath}。根据自主验收协议，请在完成当前阶段后使用浏览器截图验证修改效果。如果发现问题，请立即修复。`;
}
