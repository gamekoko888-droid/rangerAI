/**
 * useGatewayHealth — Gateway health polling hook
 *
 * Extracted from useChatStore.tsx (Phase 4 refactor).
 * When WebSocket is disconnected, polls /api/health every 30s to detect
 * Gateway recovery. Updates useConnectionStore with gateway status.
 */

import { useEffect, useRef } from 'react';
import * as api from '../lib/api';
import { useConnectionStore } from '../stores/useConnectionStore';

interface UseGatewayHealthOptions {
  /** When false (WS disconnected), polling is active. When true, polling stops. */
  wsConnected: boolean;
  /** Polling interval in ms (default 30000) */
  intervalMs?: number;
}

export function useGatewayHealth({
  wsConnected,
  intervalMs = 30000,
}: UseGatewayHealthOptions) {
  const healthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!wsConnected) {
      const poll = async () => {
        try {
          const health = await api.fetchHealth();
          useConnectionStore.getState().setGatewayConnected(health.gatewayConnected);
          if (health.gatewayConnected && health.workerReady) {
            console.log('[useGatewayHealth] Health poll: Gateway recovered, WS should reconnect soon');
          }
        } catch {
          useConnectionStore.getState().setGatewayConnected(false);
        }
      };
      poll();
      healthPollRef.current = setInterval(poll, intervalMs);
      return () => {
        if (healthPollRef.current) clearInterval(healthPollRef.current);
      };
    } else {
      if (healthPollRef.current) {
        clearInterval(healthPollRef.current);
        healthPollRef.current = null;
      }
    }
  }, [wsConnected, intervalMs]);
}
