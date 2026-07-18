import type { Minigame } from './contract';
import { aimGame } from './aim';
import { debugGame } from './debug';
import { reactionGame } from './reaction';
import { typingGame } from './typing';

/**
 * The minigame registry. Adding a minigame means adding it here and nowhere
 * else in the engine or GameRoom (architecture rule 3).
 *
 * `debugGame` was M2's scaffold, used to prove the round engine before any
 * real skill challenge existed. It stays registered (lookups by id still
 * resolve it, and its own unit tests still exercise it directly) but is
 * excluded from `SELECTABLE` so a real run never randomly hands players a
 * placeholder "press a button" challenge.
 *
 * `weight` is a registry-level curation knob (how often a minigame shows up
 * in the overall pool), not part of a plugin's own contract — a plugin
 * doesn't get to declare its own popularity. Equal weights today; nothing
 * stops a future minigame from being tuned rarer or more common.
 */
const SELECTABLE: readonly { game: Minigame; weight: number }[] = [
  { game: reactionGame, weight: 1 },
  { game: typingGame, weight: 1 },
  { game: aimGame, weight: 1 },
];
const ALL: readonly Minigame[] = [debugGame, ...SELECTABLE.map((s) => s.game)];

const BY_ID = new Map<string, Minigame>(ALL.map((g) => [g.id, g]));

export function getMinigame(id: string): Minigame | undefined {
  return BY_ID.get(id);
}

/** Pick a minigame for the round from the selectable pool, weighted. With
 *  `random() === 0` this always lands on the first entry regardless of
 *  weights (as long as it has positive weight) — several tests rely on that
 *  determinism to reach a specific minigame without mocking selection. */
export function pickMinigame(random: () => number): Minigame {
  const totalWeight = SELECTABLE.reduce((sum, s) => sum + s.weight, 0);
  let r = random() * totalWeight;
  for (const s of SELECTABLE) {
    r -= s.weight;
    if (r < 0) return s.game;
  }
  return SELECTABLE[SELECTABLE.length - 1].game; // floating-point fallback
}

export function minigameCount(): number {
  return SELECTABLE.length;
}
