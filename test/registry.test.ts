import { describe, expect, it } from 'vitest';
import { getMinigame, minigameCount, pickMinigame } from '../src/server/minigames/registry';

describe('minigame registry', () => {
  it('lists exactly the real (non-debug) minigames as selectable', () => {
    expect(minigameCount()).toBe(6);
  });

  it('resolves every registered id, including the excluded-from-selection debug game', () => {
    expect(getMinigame('debug')?.id).toBe('debug');
    expect(getMinigame('reaction')?.id).toBe('reaction');
    expect(getMinigame('typing')?.id).toBe('typing');
    expect(getMinigame('aim')?.id).toBe('aim');
    expect(getMinigame('memory')?.id).toBe('memory');
    expect(getMinigame('tetris')?.id).toBe('tetris');
    expect(getMinigame('platformer')?.id).toBe('platformer');
    expect(getMinigame('nonexistent')).toBeUndefined();
  });

  it('never selects the debug scaffold in real play', () => {
    for (let r = 0; r < 1; r += 0.05) {
      expect(pickMinigame(() => r).id).not.toBe('debug');
    }
  });

  it('random()=0 always lands on the first entry regardless of weights (tests rely on this)', () => {
    expect(pickMinigame(() => 0).id).toBe('reaction');
  });

  it('covers the full weighted range across the pool', () => {
    const seen = new Set<string>();
    for (let r = 0; r < 1; r += 0.01) seen.add(pickMinigame(() => r).id);
    expect(seen).toEqual(new Set(['reaction', 'typing', 'aim', 'memory', 'tetris', 'platformer']));
  });
});
