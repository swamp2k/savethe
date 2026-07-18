import type { GameState } from './engine';
import type { CrueltyKind, Plushie } from '../../shared/game';

export const CRUELTY_POOL: ReadonlyArray<{ kind: CrueltyKind; weight: number; eligible: (state: GameState) => boolean }> = [
  { kind: 'the_deal', weight: 1, eligible: (state) => state.unbanked.length >= 1 },
  { kind: 'nuts_or_teeth', weight: 1, eligible: () => true },
  { kind: 'the_sacrifice', weight: 1, eligible: (state) => state.unbanked.length >= 2 },
];

export function pickCruelty(state: GameState, random: () => number): CrueltyKind | null {
  const eligible = CRUELTY_POOL.filter((entry) => entry.eligible(state));
  if (eligible.length === 0) return null;
  const total = eligible.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = random() * total;
  for (const entry of eligible) {
    roll -= entry.weight;
    if (roll < 0) return entry.kind;
  }
  return eligible[eligible.length - 1].kind;
}

export function sacrificeCandidates(plushies: Plushie[]): [string, string] | null {
  const candidates = [...plushies]
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
    .slice(0, 2)
    .map((plushie) => plushie.id);
  return candidates.length === 2 ? [candidates[0], candidates[1]] : null;
}
