/**
 * useConnectionStore — WebSocket & Gateway connection state (Zustand)
 * 
 * Manages: wsConnected, wsReconnecting, wsReconnectAttempt, gatewayConnected
 * Consumers: ChatPage, Sidebar, RecoveryBanner
 */
import { create } from 'zustand';
interface ConnectionState {
  wsConnected: boolean;
  wsReconnecting: boolean;
  wsReconnectAttempt: number;
  gatewayConnected: boolean;
  wsGaveUp: boolean;
  wsDisconnectedDuringTask: boolean;
  /** Iter-AG/AH: long_running_notify payload (null = not running long) */
  longRunningNotice: { elapsed: number; toolCount: number } | null;
  /** v2 Recovery progress: shown in RecoveryBanner after WS reconnects */
  recoveryPhase: 'idle' | 'reconnecting_ws' | 'recovering_task' | 'recovered' | 'failed';
  recoveryMessage: string;
}
interface ConnectionActions {
  setWsConnected: (connected: boolean) => void;
  setWsReconnecting: (reconnecting: boolean, attempt: number) => void;
  setGatewayConnected: (connected: boolean) => void;
  setWsGaveUp: (gaveUp: boolean) => void;
  setWsDisconnectedDuringTask: (disconnected: boolean) => void;
  setLongRunningNotice: (notice: { elapsed: number; toolCount: number } | null) => void;
  /** v2 Recovery progress setter */
  setRecoveryPhase: (phase: ConnectionState['recoveryPhase'], message?: string) => void;
}
export type ConnectionStore = ConnectionState & ConnectionActions;
export const useConnectionStore = create<ConnectionStore>((set) => ({
  wsConnected: false,
  wsReconnecting: false,
  wsReconnectAttempt: 0,
  gatewayConnected: false,
  wsGaveUp: false,
  wsDisconnectedDuringTask: false,
  longRunningNotice: null,
  recoveryPhase: 'idle',
  recoveryMessage: '',
  setWsConnected: (connected) =>
    set((s) => ({
      wsConnected: connected,
      wsReconnecting: connected ? false : s.wsReconnecting,
      wsReconnectAttempt: connected ? 0 : s.wsReconnectAttempt,
    })),
  setWsReconnecting: (reconnecting, attempt) =>
    set({ wsReconnecting: reconnecting, wsReconnectAttempt: attempt }),
  setGatewayConnected: (connected) =>
    set({ gatewayConnected: connected }),
  setWsGaveUp: (gaveUp) =>
    set({ wsGaveUp: gaveUp }),
  setWsDisconnectedDuringTask: (disconnected) =>
    set({ wsDisconnectedDuringTask: disconnected }),
  setLongRunningNotice: (notice) =>
    set({ longRunningNotice: notice }),
  setRecoveryPhase: (phase, message = '') =>
    set({ recoveryPhase: phase, recoveryMessage: message }),
}));
