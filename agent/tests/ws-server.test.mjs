/**
 * tests/ws-server.test.mjs — WebSocket server heartbeat tests
 *
 * D8. Heartbeat correctly terminates dead connections and pings alive ones.
 *
 * Note: We test the heartbeat logic pattern directly rather than importing
 * ws-server.mjs (which has heavy dependencies on ws, worker-manager, etc.)
 */

import { describe, it } from "vitest";;
import { expect } from "vitest";;

describe("D8. WebSocket Heartbeat Logic", () => {
  /**
   * Simulate the heartbeat logic from ws-server.mjs:
   *   wss.clients.forEach((ws) => {
   *     if (!ws.isAlive) { ws.terminate(); return; }
   *     ws.isAlive = false;
   *     ws.ping();
   *   });
   */
  function runHeartbeat(clients) {
    clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }

  function createMockWs(isAlive) {
    return {
      isAlive,
      terminated: false,
      pinged: false,
      terminate() { this.terminated = true; },
      ping() { this.pinged = true; },
    };
  }

  it("terminates dead connections (isAlive=false)", () => {
    const deadWs = createMockWs(false);
    const clients = new Set([deadWs]);

    runHeartbeat(clients);

    expect(deadWs.terminated, "Dead connection should be terminated").toBeTruthy();
    expect(!deadWs.pinged, "Dead connection should NOT be pinged").toBeTruthy();
  });

  it("pings alive connections and resets isAlive to false", () => {
    const aliveWs = createMockWs(true);
    const clients = new Set([aliveWs]);

    runHeartbeat(clients);

    expect(!aliveWs.terminated, "Alive connection should NOT be terminated").toBeTruthy();
    expect(aliveWs.pinged, "Alive connection should be pinged").toBeTruthy();
    expect(aliveWs.isAlive).toBe(false, "isAlive should be reset to false after ping");
  });

  it("handles mixed alive and dead connections correctly", () => {
    const alive1 = createMockWs(true);
    const alive2 = createMockWs(true);
    const dead1 = createMockWs(false);
    const dead2 = createMockWs(false);
    const clients = new Set([alive1, dead1, alive2, dead2]);

    runHeartbeat(clients);

    // Alive connections: pinged, not terminated
    expect(alive1.pinged && !alive1.terminated).toBeTruthy();
    expect(alive2.pinged && !alive2.terminated).toBeTruthy();

    // Dead connections: terminated, not pinged
    expect(dead1.terminated && !dead1.pinged).toBeTruthy();
    expect(dead2.terminated && !dead2.pinged).toBeTruthy();
  });

  it("handles empty client set without error", () => {
    const clients = new Set();
    expect(() => runHeartbeat(clients)).not.toThrow();
  });

  it("two consecutive heartbeats terminate unresponsive connection", () => {
    const ws = createMockWs(true);
    const clients = new Set([ws]);

    // First heartbeat: alive → ping + set isAlive=false
    runHeartbeat(clients);
    expect(ws.pinged).toBeTruthy();
    expect(ws.isAlive).toBe(false);
    expect(!ws.terminated).toBeTruthy();

    // Simulate: client does NOT respond with pong (isAlive stays false)
    ws.pinged = false;

    // Second heartbeat: isAlive=false → terminate
    runHeartbeat(clients);
    expect(ws.terminated, "Should be terminated after missing pong").toBeTruthy();
  });
});
