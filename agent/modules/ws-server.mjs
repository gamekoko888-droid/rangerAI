/**
 * modules/ws-server.mjs — WebSocket server setup
 *
 * Extracted from server.mjs (Iter-6.2).
 * Creates the WSS instance, registers connection handler, and starts heartbeat interval.
 *
 * v2 (Iter-61): Increased heartbeat tolerance for mobile background tabs.
 *   - Interval: 30s → 45s
 *   - Tolerance: 1 miss → 3 misses (= 135s before terminate)
 *   - Reason: Mobile browsers suspend JS when backgrounded, causing pong misses.
 */

import { WebSocketServer } from "ws";
import { setWss } from "./worker-manager.mjs";
import * as wsHandler from "./ws-handler.mjs";

/**
 * Create and wire up the WebSocket server.
 * @param {http.Server} server
 * @param {object} ctx — full DI context (ctx.runtime.wss will be set)
 * @returns {{ wss, wsHeartbeatInterval }}
 */
export function createWsServer(server, ctx) {
  const wss = new WebSocketServer({ server });
  ctx.runtime.wss = wss;

  // Give WorkerManager a reference to WSS (was null during early init)
  setWss(wss);

  // Heartbeat interval to detect dead connections
  // v2: 45s interval, 3 missed pings before terminate (= ~135s tolerance)
  // This allows mobile browsers to background for 2+ minutes without disconnection
  const HEARTBEAT_INTERVAL_MS = 45000;
  const MAX_MISSED_PINGS = 3;

  const wsHeartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws._missedPings = (ws._missedPings || 0) + 1;
        if (ws._missedPings >= MAX_MISSED_PINGS) {
          ws.terminate();
          return;
        }
      } else {
        ws._missedPings = 0;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  wss.on("connection", (ws, req) => {
    ws._missedPings = 0;
    wsHandler.handleConnection(ws, req);
  });

  return { wss, wsHeartbeatInterval };
}


export function tagSessionFrame(sessionKey, payload = {}) { return { sessionKey, ...payload }; }
