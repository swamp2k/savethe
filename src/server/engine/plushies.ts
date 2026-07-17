import type { Plushie } from '../../shared/game';

interface Species {
  species: string;
  emoji: string;
}

const SPECIES: Species[] = [
  { species: 'bear', emoji: '🐻' },
  { species: 'bunny', emoji: '🐰' },
  { species: 'penguin', emoji: '🐧' },
  { species: 'frog', emoji: '🐸' },
  { species: 'turtle', emoji: '🐢' },
  { species: 'cat', emoji: '🐱' },
  { species: 'octopus', emoji: '🐙' },
  { species: 'capybara', emoji: '🦫' },
  { species: 'unicorn', emoji: '🦄' },
  { species: 'duck', emoji: '🐤' },
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
export function makePlushie(id: string, random: () => number): Plushie {
  const species = SPECIES[Math.floor(random() * SPECIES.length)];
  const name = NAMES[Math.floor(random() * NAMES.length)];
  return { id, species: species.species, emoji: species.emoji, name };
}
