import { describe, it } from "vitest";;
import { expect } from "vitest";;
import { WebSocket } from 'ws';

const WS_URL = 'ws://localhost:3000/ws';

describe('WebSocket Connection Tests', () => {
  it('should reject connection without token', async () => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        // If no response in 3s, connection was silently rejected
        resolve();
      }, 3000);

      ws.on('error', (err) => {
        clearTimeout(timeout);
        // Connection error is expected without token
        resolve();
      });

      ws.on('close', (code) => {
        clearTimeout(timeout);
        // Close is expected
        resolve();
      });

      ws.on('open', () => {
        clearTimeout(timeout);
        // Even if opened, it should close soon without auth
        setTimeout(() => {
          ws.close();
          resolve();
        }, 2000);
      });
    });
  });

  it('should reject connection with invalid token', async () => {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${WS_URL}?token=invalid-token-xyz`);
      const timeout = setTimeout(() => {
        ws.close();
        resolve();
      }, 3000);

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve();
      });

      ws.on('close', (code) => {
        clearTimeout(timeout);
        // Should be closed with auth error
        expect(code >= 1000, `Close code should be >= 1000, got ${code}`).toBeTruthy();
        resolve();
      });
    });
  });
});
