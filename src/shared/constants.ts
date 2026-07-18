/** Player-count bounds for a room. MIN is enforced at game start (M2); the lobby
 *  itself may hold a single waiting player. MAX is enforced at join time. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;

/** How long a disconnected player is kept in the roster before being dropped,
 *  giving them time to reconnect (refresh, tab switch, flaky wifi). */
export const GRACE_MS = 60_000;

export const MAX_NICKNAME = 20;

/** Hardening: realistic inbound payloads (a nickname, a typing keystroke, a
 *  click event) top out well under 300 bytes; this is a generous ceiling
 *  meant to catch abuse, not legitimate traffic. */
export const MAX_MESSAGE_BYTES = 2_000;

/** Hardening: per-connection message flood protection. 15 msg/s sustained is
 *  well above anything a human triggers (even fast typing-challenge
 *  keystrokes) but catches a scripted flood. */
export const RATE_LIMIT_WINDOW_MS = 2_000;
export const RATE_LIMIT_MAX_MESSAGES = 30;

/** Hardening backstop on total concurrent rooms, enforced via RoomRegistry.
 *  Generous headroom over realistic friend-group usage. */
export const MAX_ROOMS = 300;

/** Room code shape: 3 characters from an unambiguous alphabet (no I/L/O/0/1),
 *  e.g. "PW7". Short enough to read aloud across a room. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 3;
