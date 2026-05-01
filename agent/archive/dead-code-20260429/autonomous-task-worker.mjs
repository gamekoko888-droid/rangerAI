/**
 * autonomous-task-worker.mjs — Worker-side handler for autonomous tasks
 * 
 * Receives task submissions from Redis IPC, executes them via OpenClaw Gateway,
 * and persists results to SQLite.
 * 
 * @version 1.0.0
 */
import { logger } from '../lib/logger.mjs';
import { query, queryOne, run } from '../db-adapter.mjs';
import crypto from 'crypto';

const ts = () => new Date().toISOString();

/**
 * Handle autonomous task submission from IPC
 * @param {object} cmd - IPC command with task details
 * @param {object} deps - Worker dependencies (workerManager, etc.)
 */
export async function handleAutonomousTask(cmd, deps) {
  const { taskId, userId, title, description, taskType } = cmd;
  const { workerManager, sendEvent, taskStore } = deps;
  
  logger.info(`[${ts()}] [autonomous-task-worker] Received task ${taskId}: ${title}`);
  
  try {
    // Update task status to running
    await run(
      `UPDATE autonomous_tasks SET status = 'running', startedAt = datetime('now') WHERE id = ?`,
      [taskId]
    );
    
    // Create a virtual session for this task
    const sessionKey = `autonomous_${taskId}`;
    const msgId = `atask_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    
    // Start task in TaskStore (Redis)
    if (taskStore) {
      await taskStore.startTask(msgId, sessionKey, description);
    }
    
    // Create step record for planning
    await run(
      `INSERT INTO task_steps (taskId, stepNumber, type, title, status, createdAt)
       VALUES (?, 1, 'plan', '任务规划', 'running', datetime('now'))`,
      [taskId]
    );
    
    // Send to OpenClaw Gateway via workerManager
    // The task description becomes the user message
    const taskMessage = {
      content: description,
      sessionKey: sessionKey,
      metadata: {
        isAutonomousTask: true,
        taskId: taskId,
        taskType: taskType,
        forceAgent: true,
        hint: `这是一个自主任务，请完整执行并报告结果。任务类型：${taskType}。任务标题：${title}。`,
      },
    };
    
    // Use workerManager to process the task
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Task execution timeout (30 minutes)'));
      }, 30 * 60 * 1000);
      
      // Listen for task completion events
      const eventHandler = (event) => {
        if (event.sessionKey !== sessionKey) return;
        
        // Update progress in SQLite
        updateTaskProgress(taskId, event).catch(e => 
          logger.debug(`[autonomous-task-worker] Progress update failed: ${e.message}`)
        );
        
        if (event.type === 'done' || event.type === 'complete') {
          clearTimeout(timeout);
          resolve(event.content || 'Task completed');
        } else if (event.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(event.content || event.message || 'Task failed'));
        }
      };
      
      // Register event listener
      if (workerManager && workerManager.on) {
        workerManager.on('task_event', eventHandler);
      }
      
      // Submit to worker
      try {
        workerManager.processMessage(taskMessage, null, sessionKey);
      } catch (submitErr) {
        clearTimeout(timeout);
        reject(submitErr);
      }
    });
    
    // Task completed successfully
    await run(
      `UPDATE autonomous_tasks SET 
        status = 'completed', 
        result = ?, 
        completedAt = datetime('now'),
        duration = CAST((julianday('now') - julianday(startedAt)) * 86400 AS INTEGER),
        progress = 100
       WHERE id = ?`,
      [typeof result === 'string' ? result : JSON.stringify(result), taskId]
    );
    
    if (taskStore) {
      await taskStore.completeTask(msgId, typeof result === 'string' ? result : JSON.stringify(result));
    }
    
    logger.info(`[${ts()}] [autonomous-task-worker] Task ${taskId} completed successfully`);
    
  } catch (err) {
    logger.error(`[${ts()}] [autonomous-task-worker] Task ${taskId} failed: ${err.message}`);
    
    await run(
      `UPDATE autonomous_tasks SET 
        status = 'failed', 
        error = ?, 
        completedAt = datetime('now'),
        duration = CAST((julianday('now') - julianday(COALESCE(startedAt, createdAt))) * 86400 AS INTEGER)
       WHERE id = ?`,
      [err.message, taskId]
    );
  }
}

/**
 * Update task progress based on events
 */
async function updateTaskProgress(taskId, event) {
  const type = event.type;
  
  if (type === 'tool_start' || type === 'tool_call') {
    const toolName = event.tool || event.toolName || 'unknown';
    const stepNum = await getNextStepNumber(taskId);
    await run(
      `INSERT INTO task_steps (taskId, stepNumber, type, title, toolName, status, createdAt)
       VALUES (?, ?, 'tool_call', ?, ?, 'running', datetime('now'))`,
      [taskId, stepNum, `执行工具: ${toolName}`, toolName]
    );
    
    // Update progress estimate
    await run(
      `UPDATE autonomous_tasks SET currentStep = ?, completedSteps = completedSteps + 1 WHERE id = ?`,
      [`正在执行: ${toolName}`, taskId]
    );
  }
  
  if (type === 'tool_end' || type === 'tool_result') {
    // Mark latest tool step as completed
    await run(
      `UPDATE task_steps SET status = 'completed', completedAt = datetime('now')
       WHERE taskId = ? AND status = 'running' AND type = 'tool_call'
       ORDER BY stepNumber DESC LIMIT 1`,
      [taskId]
    );
  }
  
  if (type === 'thinking' || type === 'text') {
    // Update current step description
    const content = (event.content || '').substring(0, 200);
    if (content.length > 10) {
      await run(
        `UPDATE autonomous_tasks SET currentStep = ? WHERE id = ?`,
        [content, taskId]
      );
    }
  }
  
  if (type === 'screenshot') {
    // Store screenshot URL
    const screenshotUrl = event.url || event.content;
    if (screenshotUrl) {
      const task = await queryOne('SELECT screenshots FROM autonomous_tasks WHERE id = ?', [taskId]);
      const screenshots = JSON.parse(task?.screenshots || '[]');
      screenshots.push({ url: screenshotUrl, timestamp: new Date().toISOString() });
      await run('UPDATE autonomous_tasks SET screenshots = ? WHERE id = ?', [JSON.stringify(screenshots), taskId]);
    }
  }
}

async function getNextStepNumber(taskId) {
  const result = await queryOne('SELECT MAX(stepNumber) as maxStep FROM task_steps WHERE taskId = ?', [taskId]);
  return (result?.maxStep || 0) + 1;
}

export default { handleAutonomousTask };
