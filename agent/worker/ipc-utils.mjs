import { logger } from '../lib/logger.mjs';
// ─── IPC Utilities (extracted from agent-worker.mjs) ───────
// All communication with the main process (server.mjs) goes through here.

let stepCounter = 0;

export function resetStepCounter() {
  stepCounter = 0;
}

export function getStepCounter() {
  return stepCounter;
}

export function sendToMain(msgId, eventData) {
  try {
    const evType = eventData?.type;
    const ts2 = new Date().toISOString();
    logger.info(`[${ts2}] [IPC-SEND] msgId=${msgId} type=${evType} hasProcessSend=${typeof process.send}`);
    process.send({ type: "frontend_event", msgId, event: eventData });
  } catch (err) {
    const ts = new Date().toISOString();
    logger.info(`[${ts}] [worker] IPC send error: ${err.message}`);
  }
}

export function sendStep(msgId, title, status, detail = "") {
  stepCounter++;
  const stepId = `step-${stepCounter}`;
  sendToMain(msgId, { type: "step", id: stepId, title, status, detail, stepIndex: stepCounter });
  return stepId;
}

export function updateStep(msgId, stepId, status, detail = "") {
  sendToMain(msgId, { type: "step_update", id: stepId, status, detail });
}

export function sendEvent(msgId, data) {
  sendToMain(msgId, data);
}

export function sendNotify(msgId, content, category = "progress") {
  sendToMain(msgId, { type: "notify", content, category, ts: Date.now() });
}
