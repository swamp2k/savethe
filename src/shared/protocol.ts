import { z } from 'zod';
import { MAX_NICKNAME } from './constants';

/**
 * The wire protocol shared by client and server.
 *
 * Client -> server messages are validated with zod at the network boundary
 * (architecture rule 7). Server -> client messages are produced only by the
 * trusted server, so they are typed but not re-validated on the client.
 *
 * Player identity is NEVER carried in gameplay payloads. It is established once
 * during the join/reconnect handshake and thereafter derived from the socket
 * (architecture rule 6).
 */

// eslint-disable-next-line no-control-regex -- intentionally matching control chars to reject them
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

const nickname = z
  .string()
  .trim()
  .min(1, 'Enter a nickname')
  .max(MAX_NICKNAME)
  // reject control characters that would break rendering / spoof whitespace
  .refine((s) => !CONTROL_CHARS.test(s), 'Invalid characters');

export const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('room.join'),
    mode: z.enum(['create', 'join']),
    nickname,
  }),
  z.object({
    type: z.literal('room.reconnect'),
    token: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type Phase = 'lobby';

export interface PlayerView {
  playerId: string;
  nickname: string;
  connected: boolean;
  seat: number;
}

export interface RoomState {
  code: string;
  phase: Phase;
  players: PlayerView[];
  maxPlayers: number;
}

export type ErrorCode =
  | 'bad_message'
  | 'not_joined'
  | 'already_joined'
  | 'no_such_room'
  | 'room_full'
  | 'code_taken'
  | 'unknown_session'
  | 'bad_nickname'
  | 'unexpected';

export type ServerMessage =
  | {
      type: 'room.joined';
      token: string;
      self: { playerId: string; nickname: string };
      state: RoomState;
    }
  | { type: 'room.state'; state: RoomState }
  | { type: 'pong' }
  | { type: 'error'; code: ErrorCode; message: string; fatal: boolean };

export type DecodeResult = { ok: true; value: ClientMessage } | { ok: false };

/** Parse and validate an inbound client message. Never throws. */
export function decodeClientMessage(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const result = ClientMessage.safeParse(parsed);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}
