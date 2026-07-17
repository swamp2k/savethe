import type { Minigame } from './contract';
import { debugGame } from './debug';

/**
 * The minigame registry. Adding a minigame means adding it here and nowhere
 * else in the engine or GameRoom (architecture rule 3).
 */
const ALL: readonly Minigame[] = [debugGame];

const BY_ID = new Map<string, Minigame>(ALL.map((g) => [g.id, g]));

export function getMinigame(id: string): Minigame | undefined {
  return BY_ID.get(id);
}

/** Pick a minigame for the round. Weighted selection lands in M4; for now the
 *  registry has one entry and selection is uniform over `random`. */
export function pickMinigame(random: () => number): Minigame {
  return ALL[Math.floor(random() * ALL.length)] ?? ALL[0];
}

export function minigameCount(): number {
  return ALL.length;
}
