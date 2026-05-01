/**
 * useWebSocket — WebSocket connection manager for RangerAI.
 * 
 * v2: Enhanced with reconnecting state, max reconnect limit,
 *     pong latency tracking, and visibility-aware reconnection.
 * 
 * Handles: connection, reconnection, heartbeat, and event dispatching.
 * Does NOT handle chat state — that's useChatStore's job.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from "../lib/logger";
import type { WsEvent, WsEventType } from '../lib/types';
import { getAuthToken } from '../lib/api';

/** Connection state exposed to consumers */
export type WsConnectionState = 'connected' | 'disconnected' | 'reconnecting';

interface UseWebSocketOptions {
  /** Called for every incoming WS event */
  onEvent: (event: WsEvent) => void;
  /** Called when connection state changes (connected boolean for backward compat) */
  onConnectionChange?: (connected: boolean) => void;
  /** Called when detailed connection state changes */
  onStateChange?: (state: WsConnectionState) => void;
  /** Auto-connect on mount? Default: true */
  autoConnect?: boolean;
  /** Max reconnect attempts before giving up. Default: 20 */
  maxReconnectAttempts?: number;
}

interface UseWebSocketReturn {
  /** Whether the WebSocket is connected */
  connected: boolean;
  /** Detailed connection state: connected | disconnected | reconnecting */
  connectionState: WsConnectionState;
  /** Current reconnect attempt number (0 when connected) */
  reconnectAttempt: number;
  /** Iter-AG: true when never-connected give-up triggered (show error banner) */
  neverConnectedFailed: boolean;
  /** Send a JSON message to the server */
  send: (data: Record<string, unknown>) => void;
  /** Bind this WS connection to a specific chat */
  bindChat: (chatId: string) => void;
  /** Manually connect */
  connect: () => void;
  /** Manually disconnect */
  disconnect: () => void;
}

const MAX_RECONNECT_ATTEMPTS_DEFAULT = 20;
const HEARTBEAT_INTERVAL = 25000;   // 25s — well within Cloudflare's 100s timeout
const PONG_TIMEOUT = 8000;          // 8s — if no pong within this, connection is suspect
const STALE_CONNECTION_LATENCY = 5000; // 5s — pong latency above this is considered stale

function getWsUrl(): string {
  if (import.meta.env.VITE_WS_URL) {
    return import.meta.env.VITE_WS_URL;
  }
  // Default: same origin, ws/wss based on protocol
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const base = `${protocol}//${window.location.host}/ws`;
  // Attach JWT auth token for WebSocket authentication
  const token = getAuthToken();
  if (token) {
    return `${base}?token=${encodeURIComponent(token)}`;
  }
  return base;
}

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    onEvent,
    onConnectionChange,
    onStateChange,
    autoConnect = true,
    maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS_DEFAULT,
  } = options;

  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<WsConnectionState>('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [neverConnectedFailed, setNeverConnectedFailed] = useState(false); // Iter-AG
  
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pongTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const intentionalCloseRef = useRef(false);
  const hadConnectionRef = useRef(false); // Track if we ever connected
  const boundChatRef = useRef<string | null>(null); // Track bound chat for auto-rebind
  const pongLatencyRef = useRef<number[]>([]); // Track recent pong latencies
  const lastPingTsRef = useRef<number>(0); // Timestamp of last ping sent
  const onEventRef = useRef(onEvent);
  const onConnectionChangeRef = useRef(onConnectionChange);
  const onStateChangeRef = useRef(onStateChange);
  
  // Keep refs updated
  onEventRef.current = onEvent;
  onConnectionChangeRef.current = onConnectionChange;
  onStateChangeRef.current = onStateChange;

  const updateState = useCallback((newState: WsConnectionState) => {
    const isConnected = newState === 'connected';
    setConnected(isConnected);
    setConnectionState(newState);
    setReconnectAttempt(newState === 'reconnecting' ? reconnectAttemptRef.current : 0);
    onConnectionChangeRef.current?.(isConnected);
    onStateChangeRef.current?.(newState);
  }, []);

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (pongTimeoutRef.current) {
      clearTimeout(pongTimeoutRef.current);
      pongTimeoutRef.current = null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    
    heartbeatTimerRef.current = setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        lastPingTsRef.current = Date.now();
        wsRef.current.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        
        // Set pong timeout — if no pong within PONG_TIMEOUT, connection may be dead
        if (pongTimeoutRef.current) clearTimeout(pongTimeoutRef.current);
        pongTimeoutRef.current = setTimeout(() => {
          logger.warn('[WS] Pong timeout — connection may be dead, forcing reconnect');
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.close(4000, 'Pong timeout');
          }
        }, PONG_TIMEOUT);
      }
    }, HEARTBEAT_INTERVAL);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (intentionalCloseRef.current) return;
    if (reconnectTimerRef.current) return; // Already scheduled
    
    const attempt = reconnectAttemptRef.current;
    
    // v14.4: After max attempts, switch to low-frequency retry (30s) instead of giving up
    const isLowFreqMode = attempt >= maxReconnectAttempts;
    if (isLowFreqMode && !hadConnectionRef.current) {
      // Never connected at all — truly give up, show error banner (Iter-AG)
      logger.error(`[WS] Never connected and max attempts (${maxReconnectAttempts}) reached. Giving up.`);
      updateState('disconnected');
      setNeverConnectedFailed(true);
      window.dispatchEvent(new CustomEvent('ws:connection-failed', {
        detail: { attempts: maxReconnectAttempts }
      }));
      return;
    }
    
    // Only show "reconnecting" if we previously had a connection
    if (hadConnectionRef.current) {
      updateState('reconnecting');
    }
    
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s, with 20% jitter
    // After max attempts: fixed 30s low-frequency retry
    let baseDelay: number;
    if (isLowFreqMode) {
      baseDelay = 30000; // Fixed 30s for low-frequency mode
      logger.debug(`[WS] Max attempts reached, switching to low-frequency retry (30s). Attempt ${attempt + 1}`);
    } else {
      baseDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
    }
    const jitter = Math.random() * baseDelay * 0.2;
    const delay = Math.round(baseDelay + jitter);
    
    logger.debug(`[WS] Reconnecting in ${delay}ms (attempt ${attempt + 1}${isLowFreqMode ? ' [low-freq]' : `/${maxReconnectAttempts}`})`);
    
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      reconnectAttemptRef.current++;
      setReconnectAttempt(reconnectAttemptRef.current);
      connect();
    }, delay);
  }, [maxReconnectAttempts, updateState]);

  const connect = useCallback(() => {
    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      if (wsRef.current.readyState === WebSocket.OPEN || 
          wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
    }
    clearTimers();
    intentionalCloseRef.current = false;

    const url = getWsUrl();
    logger.debug(`[WS] Connecting to ${url.replace(/token=[^&]+/, 'token=***')}`);
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        logger.debug('[WS] Connected');
        reconnectAttemptRef.current = 0;
        hadConnectionRef.current = true;
        updateState('connected');
        startHeartbeat();
        // Auto-rebind chat on reconnect
        if (boundChatRef.current) {
          logger.debug(`[WS] Auto-rebinding chat: ${boundChatRef.current}`);
          ws.send(JSON.stringify({ type: 'bind_chat', chatId: boundChatRef.current }));
        }
      };

      ws.onclose = (event) => {
        const isNormalClose = event.code === 1000 || event.code === 1001;
        const isServerRestart = event.code === 1012 || event.code === 1013;
        logger.debug(`[WS] Closed: code=${event.code} reason=${event.reason} normal=${isNormalClose}`);
        clearTimers();
        
        // R60-FIX: On server restart (1012), dispatch synthetic stream_end so frontend
        // properly exits streaming state even if the real stream_end was lost
        if (isServerRestart) {
          logger.debug('[WS] Server restart detected — dispatching synthetic stream_end');
          try {
            onEventRef.current({
              type: 'stream_end' as WsEventType,
              content: '',
              model: 'RangerAI Agent (Reconnecting)',
              provider: 'rangerai',
              _synthetic: true,
              _reason: 'server_restart'
            });
            onEventRef.current({
              type: 'status' as WsEventType,
              status: 'idle',
              _synthetic: true
            });
          } catch (e) {
            logger.error('[WS] Failed to dispatch synthetic stream_end:', e);
          }
        }
        
        if (!intentionalCloseRef.current) {
          // Server restart — reconnect faster
          if (isServerRestart) {
            reconnectAttemptRef.current = 0; // Reset attempts for server-initiated restart
          }
          scheduleReconnect();
        } else {
          updateState('disconnected');
        }
      };

      ws.onerror = (error) => {
        logger.error('[WS] Error:', error);
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as WsEvent;
          
          // Handle pong — clear pong timeout and track latency
          if (data.type === 'pong' || data.type === 'server_ping') {
            if (pongTimeoutRef.current) {
              clearTimeout(pongTimeoutRef.current);
              pongTimeoutRef.current = null;
            }
            // Track pong latency
            if (lastPingTsRef.current > 0) {
              const latency = Date.now() - lastPingTsRef.current;
              pongLatencyRef.current.push(latency);
              if (pongLatencyRef.current.length > 10) pongLatencyRef.current.shift();
              // Warn if latency is consistently high
              if (latency > STALE_CONNECTION_LATENCY) {
                logger.warn(`[WS] High pong latency: ${latency}ms — connection may be stale`);
              }
            }
            return;
          }
          
          if (data.type === 'supervisor_progress' || data.type === ('supervisor_mode' as string)) {
            logger.debug('[WS-RAW] Supervisor event received:', data.type, JSON.stringify(data).slice(0, 200));
          }
          onEventRef.current(data);
        } catch (e) {
          logger.error('[WS] Failed to parse message:', e);
        }
      };
    } catch (e) {
      logger.error('[WS] Failed to create WebSocket:', e);
      scheduleReconnect();
    }
  }, [clearTimers, startHeartbeat, updateState, scheduleReconnect]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearTimers();
    if (wsRef.current) {
      wsRef.current.close(1000, 'Client disconnect');
      wsRef.current = null;
    }
    updateState('disconnected');
  }, [clearTimers, updateState]);

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    } else {
      logger.warn('[WS] Cannot send — not connected');
    }
  }, []);

  const bindChat = useCallback((chatId: string) => {
    boundChatRef.current = chatId; // Track for auto-rebind on reconnect
    send({ type: 'bind_chat', chatId });
  }, [send]);

  // Visibility-aware reconnection: when tab becomes visible, force reconnect if disconnected
  // Debounced: wait 1s after tab becomes visible to avoid rapid reconnect on quick tab switches
  useEffect(() => {
    let visibilityTimer: ReturnType<typeof setTimeout> | null = null;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !intentionalCloseRef.current) {
        // Debounce: wait 1s to confirm user actually returned to tab
        if (visibilityTimer) clearTimeout(visibilityTimer);
        visibilityTimer = setTimeout(() => {
          visibilityTimer = null;
          if (wsRef.current?.readyState !== WebSocket.OPEN) {
            logger.debug('[WS] Tab became visible (debounced), forcing reconnect');
            reconnectAttemptRef.current = 0;
            if (reconnectTimerRef.current) {
              clearTimeout(reconnectTimerRef.current);
              reconnectTimerRef.current = null;
            }
            connect();
          }
        }, 1000);
      } else if (document.visibilityState === 'hidden') {
        // Tab hidden — cancel pending reconnect trigger
        if (visibilityTimer) {
          clearTimeout(visibilityTimer);
          visibilityTimer = null;
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (visibilityTimer) clearTimeout(visibilityTimer);
    };
  }, [connect]);

  // Network online/offline event listeners for immediate reconnect
  useEffect(() => {
    const handleOnline = () => {
      logger.debug('[WS] Network came online, forcing reconnect');
      if (!intentionalCloseRef.current && wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnectAttemptRef.current = 0;
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        connect();
      }
    };
    const handleOffline = () => {
      logger.debug('[WS] Network went offline');
      // Don't close — let the heartbeat/pong timeout handle it naturally
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [connect]);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    return () => {
      disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, connectionState, reconnectAttempt, neverConnectedFailed, send, bindChat, connect, disconnect };
}
