export type PlushieAbility =
  | 'brave_heart'
  | 'guardian'
  | 'greedy_bastard'
  | 'lucky_charm';

export const ABILITIES = {
  brave_heart: {
    label: 'Brave Heart',
    emoji: '❤️‍🔥',
    description: 'Makes future challenges easier while this plushie is at risk.',
  },
  guardian: {
    label: 'Guardian',
    emoji: '🛡️',
    description: 'Reduces the chance of cruelty events while this plushie is at risk.',
  },
  greedy_bastard: {
    label: 'Greedy Bastard',
    emoji: '🤑',
    description: 'Makes future rescues worth more while this plushie is at risk.',
  },
  lucky_charm: {
    label: 'Lucky Charm',
    emoji: '🍀',
    description: 'Makes Last Chance more likely when a rescue fails.',
  },
} satisfies Record<PlushieAbility, { label: string; emoji: string; description: string }>;

export function abilityPowerForRarity(rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'): number {
  switch (rarity) {
    case 'common':
    case 'uncommon':
      return 1;
    case 'rare':
    case 'epic':
      return 2;
    case 'legendary':
      return 3;
  }
}
