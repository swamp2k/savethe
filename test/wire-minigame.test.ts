import { describe, expect, it } from 'vitest';
import { wireGame } from '../src/server/minigames/wire';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

function ctx(now: number, random = 0): MinigameContext { return { now, random: () => random }; }
function fresh(config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] }, random = 0) {
  return wireGame.onStart(wireGame.createInitialState(config, ctx(0, random)), ctx(0, random));
}
function view(state: unknown, viewerId: string) { return wireGame.getStateForPlayer(state, viewerId) as { role: string; wires: string[]; clues: string[] }; }

describe('Wire Panic', () => {
  it('keeps a 17-second floor at high difficulty', () => {
    const hard = wireGame.createInitialState({ difficulty: 99, mpcId: 'mpc', supportIds: [] }, ctx(0)) as { timeBudgetMs: number };
    expect(hard.timeBudgetMs).toBe(17_000);
  });

  it('validates only cuts of known wires', () => {
    expect(wireGame.actionSchema.safeParse({ kind: 'cut', wire: 'red' }).success).toBe(true);
    expect(wireGame.actionSchema.safeParse({ kind: 'cut', wire: 'purple' }).success).toBe(false);
  });

  it('distributes all three exclusion clues without exposing the correct wire', () => {
    const state = fresh();
    const supportClues = [...view(state, 's1').clues, ...view(state, 's2').clues];
    expect(new Set(supportClues)).toEqual(new Set(['NOT BLUE.', 'NOT GREEN.', 'NOT YELLOW.']));
    expect(JSON.stringify(view(state, 's1'))).not.toContain('correctWire');
    expect(view(state, 'mpc').clues).toEqual([]);
  });

  it('gives every support player a clue and gives the MPC diagnostics with no support', () => {
    const four = fresh({ difficulty: 1, mpcId: 'mpc', supportIds: ['a', 'b', 'c', 'd'] });
    for (const id of ['a', 'b', 'c', 'd']) expect(view(four, id).clues.length).toBeGreaterThan(0);
    const alone = fresh({ difficulty: 1, mpcId: 'mpc', supportIds: [] });
    expect(new Set(view(alone, 'mpc').clues)).toEqual(new Set(['NOT BLUE.', 'NOT GREEN.', 'NOT YELLOW.']));
  });

  it('resolves correct and wrong cuts server-side while support actions cannot cut', () => {
    const state = fresh();
    const correct = wireGame.handleMpcAction(state, { kind: 'cut', wire: 'red' }, ctx(100));
    expect(wireGame.evaluate(correct, ctx(100))).toMatchObject({ status: 'resolved', success: true });
    const wrong = wireGame.handleMpcAction(state, { kind: 'cut', wire: 'blue' }, ctx(100));
    expect(wireGame.evaluate(wrong, ctx(100))).toMatchObject({ status: 'resolved', success: false });
    expect(wireGame.handleSupportAction(state, 's1', { kind: 'cut', wire: 'red' }, ctx(100))).toBe(state);
  });

  it('times out and exposes a fixed fuse', () => {
    const state = fresh();
    expect(wireGame.getFuse!(state)).toEqual({ deadlineAt: 22_000, totalMs: 22_000 });
    expect(wireGame.evaluate(wireGame.onDeadline(state, ctx(22_000)), ctx(22_000))).toMatchObject({ status: 'resolved', success: false });
  });
});
