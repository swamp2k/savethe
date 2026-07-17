import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './constants';

/** Generate a room code like `PW7`. `random` is injectable for deterministic
 *  tests (architecture rule: no bare Math.random in testable logic). */
export function generateRoomCode(random: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** Normalize user-entered codes: uppercase, strip whitespace/punctuation. */
export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  return [...code].every((c) => ROOM_CODE_ALPHABET.includes(c));
}
