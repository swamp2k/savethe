import type { Minigame } from './contract';
import { debugGame } from './debug';
import { reactionGame } from './reaction';

/**
 * The minigame registry. Adding a minigame means adding it here and nowhere
 * else in the engine or GameRoom (architecture rule 3).
 *
 * `debugGame` was M2's scaffold, used to prove the round engine before any
 * real skill challenge existed. It stays registered (lookups by id still
 * resolve it, and its own unit tests still exercise it directly) but is
 * excluded from `SELECTABLE` so a real run never randomly hands players a
 * placeholder "press a button" challenge.
 */
const SELECTABLE: readonly Minigame[] = [reactionGame];
const ALL: readonly Minigame[] = [debugGame, ...SELECTABLE];

const BY_ID = new Map<string, Minigame>(ALL.map((g) => [g.id, g]));

export function getMinigame(id: string): Minigame | undefined {
  return BY_ID.get(id);
}

/** Pick a minigame for the round from the selectable pool. Weighted selection
 *  lands in M4; for now selection is uniform over `random`. */
export function pickMinigame(random: () => number): Minigame {
  return SELECTABLE[Math.floor(random() * SELECTABLE.length)] ?? SELECTABLE[0];
}

export function minigameCount(): number {
  return SELECTABLE.length;
}
