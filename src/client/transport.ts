import type { ClientMessage } from '../shared/protocol';

/** The small transport boundary shared by the connection hook and its tests. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
}

/**
 * Returns whether the message reached an open socket. It deliberately does
 * not queue messages: gameplay intent is phase-sensitive and stale intent
 * must never be replayed after reconnecting.
 */
export function sendRaw(socket: SocketLike | null, message: ClientMessage, openState: number): boolean {
  if (!socket || socket.readyState !== openState) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export function canSendGameplay(status: 'connected' | string, socketOpen: boolean): boolean {
  return status === 'connected' && socketOpen;
}
