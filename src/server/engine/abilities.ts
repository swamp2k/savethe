import type { ActiveEffectsView, Plushie } from '../../shared/game';

export function activeAbilities(plushies: Plushie[]): Plushie[] {
  return plushies;
}

function totalPower(plushies: Plushie[], ability: Plushie['ability']): number {
  return activeAbilities(plushies)
    .filter((plushie) => plushie.ability === ability)
    .reduce((total, plushie) => total + plushie.abilityPower, 0);
}

export function braveReduction(plushies: Plushie[]): number {
  return Math.min(3, totalPower(plushies, 'brave_heart'));
}

export function guardianReduction(plushies: Plushie[]): number {
  return Math.min(0.25, totalPower(plushies, 'guardian') * 0.05);
}

export function greedyBonus(plushies: Plushie[]): number {
  return Math.min(6, totalPower(plushies, 'greedy_bastard'));
}

export function luckyCharmBonus(plushies: Plushie[]): number {
  return Math.min(0.30, totalPower(plushies, 'lucky_charm') * 0.10);
}

/** Projects the gameplay ability math for the Bank/Risk decision. */
export function activeEffectsView(
  plushies: Plushie[],
  nextRound: number,
  difficultyBonus: number,
  currentRound: number,
): ActiveEffectsView {
  const brave = braveReduction(plushies);
  const guardian = guardianReduction(plushies);
  const greedy = greedyBonus(plushies);
  const lucky = luckyCharmBonus(plushies);
  const baseDifficulty = nextRound + difficultyBonus;
  const baseChance = currentRound >= 4 ? 0.65 : 0.25 + currentRound * 0.1;
  const lastChanceBase = 0.35;

  return {
    brave: brave > 0 ? { reduction: brave, baseDifficulty, effectiveDifficulty: Math.max(1, baseDifficulty - brave) } : null,
    guardian: guardian > 0 ? { reduction: guardian, baseChance, effectiveChance: Math.max(0.10, baseChance - guardian) } : null,
    greedy: greedy > 0 ? { bonus: greedy } : null,
    lucky: lucky > 0 ? { bonus: lucky, baseChance: lastChanceBase, effectiveChance: Math.min(0.75, lastChanceBase + lucky) } : null,
  };
}
