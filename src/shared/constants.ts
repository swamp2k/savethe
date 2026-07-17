/** Player-count bounds for a room. MIN is enforced at game start (M2); the lobby
 *  itself may hold a single waiting player. MAX is enforced at join time. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

/** How long a disconnected player is kept in the roster before being dropped,
 *  giving them time to reconnect (refresh, tab switch, flaky wifi). */
export const GRACE_MS = 60_000;

export const MAX_NICKNAME = 20;

/** Room code shape: SAVE-XXXX using an unambiguous alphabet (no I/L/O/0/1). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_PREFIX = 'SAVE';
export const ROOM_CODE_BODY_LENGTH = 4;
