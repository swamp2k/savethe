import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, ServerMessage } from '../shared/protocol';
import type { GameView } from '../shared/game';
import { generateRoomCode, normalizeRoomCode } from '../shared/room-code';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'closed';

export interface Self {
  playerId: string;
  nickname: string;
}

export interface Connection {
  status: ConnectionStatus;
  view: GameView | null;
  self: Self | null;
  error: string | null;
  createRoom: (nickname: string) => void;
  joinRoom: (code: string, nickname: string) => void;
  leave: () => void;
  startGame: () => void;
  voteMpc: (candidateId: string) => void;
  voteRisk: (choice: 'bank' | 'risk') => void;
  minigameAction: (payload: unknown) => void;
}

interface Session {
  code: string;
  token: string;
}

/** How we should introduce ourselves once the socket opens. */
type Intent =
  | { kind: 'create'; code: string; nickname: string }
  | { kind: 'join'; code: string; nickname: string }
  | { kind: 'reconnect'; code: string; token: string };

const STORAGE_KEY = 'savethe.session';
const MAX_BACKOFF_MS = 15_000;
const PING_INTERVAL_MS = 25_000;

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed.code && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

function saveSession(session: Session): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable (private mode); reconnect just won't survive a refresh
  }
}

function clearSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function socketUrl(code: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/${encodeURIComponent(code)}`;
}

export function useGameConnection(): Connection {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [view, setView] = useState<GameView | null>(null);
  const [self, setSelf] = useState<Self | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const intentRef = useRef<Intent | null>(null);
  const attemptsRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const closingRef = useRef(false);

  const send = useCallback((message: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const clearTimers = useCallback(() => {
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    if (pingTimer.current) clearInterval(pingTimer.current);
    reconnectTimer.current = null;
    pingTimer.current = null;
  }, []);

  const connect = useCallback(() => {
    const intent = intentRef.current;
    if (!intent) return;

    clearTimers();
    closingRef.current = false;
    setStatus(attemptsRef.current === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(socketUrl(intent.code));
    wsRef.current = ws;

    ws.onopen = () => {
      if (intent.kind === 'reconnect') {
        send({ type: 'room.reconnect', token: intent.token });
      } else {
        send({ type: 'room.join', mode: intent.kind, nickname: intent.nickname });
      }
      pingTimer.current = setInterval(() => send({ type: 'ping' }), PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }
      switch (message.type) {
        case 'room.joined': {
          attemptsRef.current = 0;
          saveSession({ code: message.view.code, token: message.token });
          intentRef.current = { kind: 'reconnect', code: message.view.code, token: message.token };
          setSelf(message.self);
          setView(message.view);
          setError(null);
          setStatus('connected');
          break;
        }
        case 'game.state':
          setView(message.view);
          setStatus('connected');
          break;
        case 'error':
          setError(message.message);
          if (message.fatal) {
            if (message.code === 'unknown_session' || message.code === 'no_such_room') {
              clearSession();
              intentRef.current = null;
            }
            setStatus('error');
          }
          break;
        case 'pong':
          break;
      }
    };

    ws.onclose = (event) => {
      if (pingTimer.current) clearInterval(pingTimer.current);
      pingTimer.current = null;
      if (closingRef.current) return;

      if (event.code === 4000) {
        setError('This room was opened in another window.');
        setStatus('closed');
        return;
      }
      if (event.code === 4001) {
        return; // fatal server rejection; error already delivered
      }
      if (!intentRef.current) {
        setStatus('closed');
        return;
      }
      const delay = Math.min(1000 * 2 ** attemptsRef.current, MAX_BACKOFF_MS);
      attemptsRef.current += 1;
      setStatus('reconnecting');
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose will follow and drive reconnect logic.
    };
  }, [clearTimers, send]);

  const createRoom = useCallback(
    (nickname: string) => {
      attemptsRef.current = 0;
      intentRef.current = { kind: 'create', code: generateRoomCode(), nickname };
      connect();
    },
    [connect],
  );

  const joinRoom = useCallback(
    (code: string, nickname: string) => {
      attemptsRef.current = 0;
      intentRef.current = { kind: 'join', code: normalizeRoomCode(code), nickname };
      connect();
    },
    [connect],
  );

  const leave = useCallback(() => {
    closingRef.current = true;
    clearTimers();
    clearSession();
    intentRef.current = null;
    attemptsRef.current = 0;
    wsRef.current?.close();
    wsRef.current = null;
    setView(null);
    setSelf(null);
    setError(null);
    setStatus('idle');
  }, [clearTimers]);

  const startGame = useCallback(() => send({ type: 'game.start' }), [send]);
  const voteMpc = useCallback((candidateId: string) => send({ type: 'mpc.vote', candidateId }), [send]);
  const voteRisk = useCallback((choice: 'bank' | 'risk') => send({ type: 'risk.vote', choice }), [send]);
  const minigameAction = useCallback((payload: unknown) => send({ type: 'minigame.action', payload }), [send]);

  // On mount, restore a prior session if one exists (refresh recovery).
  useEffect(() => {
    const session = loadSession();
    if (session) {
      intentRef.current = { kind: 'reconnect', code: session.code, token: session.token };
      connect();
    }
    return () => {
      closingRef.current = true;
      clearTimers();
      wsRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    view,
    self,
    error,
    createRoom,
    joinRoom,
    leave,
    startGame,
    voteMpc,
    voteRisk,
    minigameAction,
  };
}
