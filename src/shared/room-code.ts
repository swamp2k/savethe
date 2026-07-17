import { ROOM_CODE_ALPHABET, ROOM_CODE_BODY_LENGTH, ROOM_CODE_PREFIX } from './constants';

/** Generate a room code like `SAVE-K7Q2`. `random` is injectable for deterministic
 *  tests (architecture rule: no bare Math.random in testable logic). */
export function generateRoomCode(random: () => number = Math.random): string {
  let body = '';
  for (let i = 0; i < ROOM_CODE_BODY_LENGTH; i++) {
    body += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return `${ROOM_CODE_PREFIX}-${body}`;
}

/** Normalize user-entered codes: uppercase, trim, tolerate a missing prefix. */
export function normalizeRoomCode(input: string): string {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z0-9]{4}$/.test(cleaned)) return `${ROOM_CODE_PREFIX}-${cleaned}`;
  return cleaned;
}

export function isValidRoomCode(code: string): boolean {
  const prefix = `${ROOM_CODE_PREFIX}-`;
  if (!code.startsWith(prefix)) return false;
  const body = code.slice(prefix.length);
  if (body.length !== ROOM_CODE_BODY_LENGTH) return false;
  return [...body].every((c) => ROOM_CODE_ALPHABET.includes(c));
}
