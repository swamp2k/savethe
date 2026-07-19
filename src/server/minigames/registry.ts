import type { Minigame } from './contract';
import { aimGame } from './aim';
import { debugGame } from './debug';
import { memoryGame } from './memory';
import { platformerGame } from './platformer';
import { reactionGame } from './reaction';
import { tetrisGame } from './tetris';
import { typingGame } from './typing';
import { wireGame } from './wire';
import { spellingGame } from './spelling';

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
const SELECTABLE: readonly Minigame[] = [
  reactionGame,
  typingGame,
  aimGame,
  memoryGame,
  tetrisGame,
  platformerGame,
  wireGame,
  spellingGame,
];
const ALL: readonly Minigame[] = [debugGame, ...SELECTABLE];

const BY_ID = new Map<string, Minigame>(ALL.map((g) => [g.id, g]));

export function getMinigame(id: string): Minigame | undefined {
  return BY_ID.get(id);
}

/** Pick a minigame for the round from the selectable pool, weighted. With
 *  `random() === 0` this always lands on the first entry regardless of
 *  weights (as long as it has positive weight) — several tests rely on that
 *  determinism to reach a specific minigame without mocking selection. */
export function selectableMinigameIds(): string[] {
  return SELECTABLE.map((game) => game.id);
}

export function createMinigameBag(random: () => number, lastMinigameId: string | null): string[] {
  const bag = selectableMinigameIds();
  for (let i = bag.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  if (bag.length > 1 && lastMinigameId !== null && bag[0] === lastMinigameId) {
    [bag[0], bag[1]] = [bag[1], bag[0]];
  }
  return bag;
}

export function minigameCount(): number {
  return SELECTABLE.length;
}
