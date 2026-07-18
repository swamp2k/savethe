import type { Plushie } from '../../shared/game';

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
