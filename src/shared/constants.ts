/** Player-count bounds for a room. MIN is enforced at game start (M2); the lobby
 *  itself may hold a single waiting player. MAX is enforced at join time. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

/** How long a disconnected player is kept in the roster before being dropped,
 *  giving them time to reconnect (refresh, tab switch, flaky wifi). */
export const GRACE_MS = 60_000;

export const MAX_NICKNAME = 20;

/** Room code shape: 3 characters from an unambiguous alphabet (no I/L/O/0/1),
 *  e.g. "PW7". Short enough to read aloud across a room. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 3;
