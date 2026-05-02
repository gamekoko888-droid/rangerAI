import { bindGatewaySession, getGatewaySession } from "./gateway-session-mux.mjs";
// ─── Gateway Intervention Connector ───
// Thin wrapper used by worker event handlers to inject corrective messages into
// an already-running Gateway session without crashing the worker on failure.

function interventionLog(level, message, meta = null) {
  const line = meta ? `${message} ${JSON.stringify(meta)}` : message;
  if (level === "warn" && console.warn) console.warn(line);
  else if (level === "error" && console.error) console.error(line);
  else console.log(line);
}

function normalizeSessionKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") return "";
  return sessionKey.startsWith("agent:main:") ? sessionKey : `agent:main:${sessionKey}`;
}

/**
 * Inject an intervention message into a running Gateway session.
 *
 * @param {string} sessionKey Gateway session key.
 * @param {string} message Message to inject.
 * @param {object} gateway Optional active GatewayConnector instance with request().
 * @returns {Promise<boolean>} true when accepted by Gateway, false otherwise.
 */
export async function injectMessage(sessionKey, message, gateway = null) {
  const key = normalizeSessionKey(sessionKey);
  interventionLog("info", `[INTERVENTION] inject message to session ${key}`);

  if (!key || !message || !gateway || typeof gateway.request !== "function") {
    interventionLog("warn", `[INTERVENTION] inject message failed for session ${key || "unknown"}`, {
      reason: "missing sessionKey/message/gateway.request",
    });
    return false;
  }

  const timeoutMs = 10_000;
  const baseParams = {
    sessionKey: key,
    message,
    deliver: false,
    channel: "internal",
    lane: "nested",
  };

  try {
    // Preferred public Gateway API shape requested by R106.
    await gateway.request("sessions.send", { key, sessionKey: key, message, timeoutSeconds: 0 }, timeoutMs);
    return true;
  } catch (firstErr) {
    try {
      // OpenClaw sessions_send tool ultimately dispatches through the Gateway agent method.
      await gateway.request("agent", baseParams, timeoutMs);
      return true;
    } catch (secondErr) {
      interventionLog("warn", `[INTERVENTION] inject message failed for session ${key}`, {
        sessionsSendError: firstErr?.message || String(firstErr),
        agentError: secondErr?.message || String(secondErr),
      });
      return false;
    }
  }
}

export default { injectMessage };

export function bindGatewaySessionForTask(taskId, sessionKey){ bindGatewaySession(taskId, sessionKey); return getGatewaySession(taskId); }
