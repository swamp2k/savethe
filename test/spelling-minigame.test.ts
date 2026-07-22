import { describe, expect, it } from 'vitest';
import { spellingGame } from '../src/server/minigames/spelling';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';
const ctx = (now: number, random = 0): MinigameContext => ({ now, random: () => random });
const config: MinigameConfig = { difficulty: 1, mpcId: 'm', supportIds: ['s'] };
function fresh() { return spellingGame.onStart(spellingGame.createInitialState(config, ctx(0)), ctx(0)); }
function recall(state: unknown) {
  const deadline = spellingGame.getNextDeadline(state)!;
  return spellingGame.onDeadline(state, ctx(deadline));
}
describe('Spelling Panic', () => {
  it('keeps the study and recall floors generous at high difficulty', () => { const hard = spellingGame.createInitialState({ ...config, difficulty: 99 }, ctx(0)) as { studyMs: number; recallMs: number }; expect(hard).toMatchObject({ studyMs: 2500, recallMs: 17000 }); });

  it('shows the study word only to the MPC, then a first-and-last mask', () => { const study = fresh(); expect(JSON.stringify(spellingGame.getStateForPlayer(study, 's'))).not.toContain('banana'); const state = recall(study); expect(spellingGame.getStateForPlayer(state, 'm')).toMatchObject({ stage: 'recall', mask: ['b', '_', '_', '_', '_', 'a'] }); });
  it('accepts capitalization-insensitive correct submissions and ends wrong ones', () => { const state = recall(fresh()); expect(spellingGame.evaluate(spellingGame.handleMpcAction(state, { kind: 'submit', word: 'BANANA' }, ctx(3001)), ctx(3001))).toMatchObject({ status: 'resolved', success: true }); expect(spellingGame.evaluate(spellingGame.handleMpcAction(state, { kind: 'submit', word: 'bananna' }, ctx(3001)), ctx(3001))).toMatchObject({ status: 'resolved', success: false }); });
  it('rotates support prompts and only reveals letters for correct answers', () => { const state = recall(fresh()); const prompt = (spellingGame.getStateForPlayer(state, 's') as { prompt: { id: number; options: string[] } }).prompt; const correct = prompt.options.indexOf('receive'); const after = spellingGame.handleSupportAction(state, 's', { kind: 'support_answer', promptId: prompt.id, optionIndex: correct }, ctx(3001)); expect((spellingGame.getStateForPlayer(after, 'm') as { supportReveals: number }).supportReveals).toBe(1); expect((spellingGame.getStateForPlayer(after, 's') as { prompt: { id: number } }).prompt.id).not.toBe(prompt.id); });
  it('lets excellent support play complete and save the word outright', () => {
    let state = recall(fresh());
    const goal = (spellingGame.getStateForPlayer(state, 's') as { supportGoal: number }).supportGoal;
    for (let index = 0; index < goal; index++) {
      const prompt = (spellingGame.getStateForPlayer(state, 's') as { prompt: { id: number; options: string[] } }).prompt;
      state = spellingGame.handleSupportAction(state, 's', { kind: 'support_answer', promptId: prompt.id, optionIndex: prompt.options.indexOf('receive') }, ctx(3_001 + index));
    }
    expect(spellingGame.evaluate(state, ctx(4_000))).toMatchObject({ status: 'resolved', success: true, savedBy: 's' });
    expect(spellingGame.evaluate(state, ctx(4_000))).toMatchObject({ headline: expect.stringContaining('Support recovered all') });
  });
  it('times out during recall and only exposes a recall fuse', () => { const study = fresh(); expect(spellingGame.getFuse!(study)).toBeNull(); const state = recall(study); expect(spellingGame.getFuse!(state)).toEqual({ deadlineAt: 26500, totalMs: 22000 }); expect(spellingGame.evaluate(spellingGame.onDeadline(state, ctx(26500)), ctx(26500))).toMatchObject({ status: 'resolved', success: false }); });
});
