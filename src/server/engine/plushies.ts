import { RARITY_VALUES, type Plushie, type PlushieRarity } from '../../shared/game';

interface Species {
  species: string;
  emoji: string;
}

// The first block all have 3D trophy models (Kenney Cube Pets — see
// public/models/); the last few are emoji-only cuties kept for variety.
const SPECIES: Species[] = [
  { species: 'bear', emoji: '🐻' },
  { species: 'beaver', emoji: '🦫' },
  { species: 'bee', emoji: '🐝' },
  { species: 'bunny', emoji: '🐰' },
  { species: 'cat', emoji: '🐱' },
  { species: 'caterpillar', emoji: '🐛' },
  { species: 'cow', emoji: '🐮' },
  { species: 'crab', emoji: '🦀' },
  { species: 'deer', emoji: '🦌' },
  { species: 'dog', emoji: '🐶' },
  { species: 'duck', emoji: '🐤' },
  { species: 'elephant', emoji: '🐘' },
  { species: 'fish', emoji: '🐟' },
  { species: 'fox', emoji: '🦊' },
  { species: 'giraffe', emoji: '🦒' },
  { species: 'hog', emoji: '🐗' },
  { species: 'koala', emoji: '🐨' },
  { species: 'lion', emoji: '🦁' },
  { species: 'monkey', emoji: '🐵' },
  { species: 'panda', emoji: '🐼' },
  { species: 'parrot', emoji: '🦜' },
  { species: 'penguin', emoji: '🐧' },
  { species: 'pig', emoji: '🐷' },
  { species: 'tiger', emoji: '🐯' },
  { species: 'frog', emoji: '🐸' },
  { species: 'turtle', emoji: '🐢' },
  { species: 'octopus', emoji: '🐙' },
  { species: 'unicorn', emoji: '🦄' },
];

// Silly default names. In M3 the MPC gets to (re)name their rescue.
const NAMES = [
  'Barry',
  'Gerald',
  'Sir Waddles',
  'Timmy',
  'Mr. Whiskers',
  'Princess Sparkle',
  'Bubbles',
  'Sir Hops-a-lot',
  'Captain Floof',
  'Reginald',
  'Noodle',
  'Sergeant Snuggles',
  'Duchess',
  'Wobbles',
  'Professor Beans',
];

/** Deterministic when given a seeded `random` (architecture rule 2). */
export function rarityForRound(round: number): PlushieRarity {
  if (round <= 1) return 'common';
  if (round === 2) return 'uncommon';
  if (round === 3) return 'rare';
  if (round === 4) return 'epic';
  return 'legendary';
}

export function makePlushie(id: string, round: number, random: () => number): Plushie {
  const species = SPECIES[Math.floor(random() * SPECIES.length)];
  const name = NAMES[Math.floor(random() * NAMES.length)];
  const rarity = rarityForRound(round);
  return { id, species: species.species, emoji: species.emoji, name, rarity, value: RARITY_VALUES[rarity] };
}
