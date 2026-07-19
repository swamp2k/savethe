import { describe, expect, it } from 'vitest';
import { createMinigameBag, getMinigame, minigameCount, selectableMinigameIds } from '../src/server/minigames/registry';

describe('minigame registry', () => {
  it('lists exactly the real (non-debug) minigames as selectable', () => {
    expect(minigameCount()).toBe(8);
  });

  it('resolves every registered id, including the excluded-from-selection debug game', () => {
    expect(getMinigame('debug')?.id).toBe('debug');
    expect(getMinigame('reaction')?.id).toBe('reaction');
    expect(getMinigame('typing')?.id).toBe('typing');
    expect(getMinigame('aim')?.id).toBe('aim');
    expect(getMinigame('memory')?.id).toBe('memory');
    expect(getMinigame('tetris')?.id).toBe('tetris');
    expect(getMinigame('platformer')?.id).toBe('platformer');
    expect(getMinigame('wire')?.id).toBe('wire');
    expect(getMinigame('spelling')?.id).toBe('spelling');
    expect(getMinigame('nonexistent')).toBeUndefined();
  });

  it('creates a bag containing every selectable game exactly once', () => {
    const bag = createMinigameBag(() => 0.42, null);
    expect(bag).toHaveLength(minigameCount());
    expect(new Set(bag)).toEqual(new Set(selectableMinigameIds()));
  });

  it('swaps the opening pair to avoid repeating a previous bag boundary', () => {
    const bag = createMinigameBag(() => 0.99, 'reaction');
    expect(bag[0]).not.toBe('reaction');
  });
});
