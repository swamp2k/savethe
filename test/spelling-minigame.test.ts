import { describe, expect, it } from 'vitest';
import { spellingGame } from '../src/server/minigames/spelling';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';
const ctx = (now: number, random = 0): MinigameContext => ({ now, random: () => random });
const config: MinigameConfig = { difficulty: 1, mpcId: 'm', supportIds: ['s'] };
function fresh() { return spellingGame.onStart(spellingGame.createInitialState(config, ctx(0)), ctx(0)); }
function recall(state: unknown) { return spellingGame.onDeadline(state, ctx(3000)); }
describe('Spelling Panic', () => {
  it('shows the study word only to the MPC, then a first-and-last mask', () => { const study = fresh(); expect(JSON.stringify(spellingGame.getStateForPlayer(study, 's'))).not.toContain('banana'); const state = recall(study); expect(spellingGame.getStateForPlayer(state, 'm')).toMatchObject({ stage: 'recall', mask: ['b', '_', '_', '_', '_', 'a'] }); });
  it('accepts capitalization-insensitive correct submissions and ends wrong ones', () => { const state = recall(fresh()); expect(spellingGame.evaluate(spellingGame.handleMpcAction(state, { kind: 'submit', word: 'BANANA' }, ctx(3001)), ctx(3001))).toMatchObject({ status: 'resolved', success: true }); expect(spellingGame.evaluate(spellingGame.handleMpcAction(state, { kind: 'submit', word: 'bananna' }, ctx(3001)), ctx(3001))).toMatchObject({ status: 'resolved', success: false }); });
  it('rotates support prompts and only reveals letters for correct answers', () => { const state = recall(fresh()); const prompt = (spellingGame.getStateForPlayer(state, 's') as { prompt: { id: number; options: string[] } }).prompt; const correct = prompt.options.indexOf('receive'); const after = spellingGame.handleSupportAction(state, 's', { kind: 'support_answer', promptId: prompt.id, optionIndex: correct }, ctx(3001)); expect((spellingGame.getStateForPlayer(after, 'm') as { supportReveals: number }).supportReveals).toBe(1); expect((spellingGame.getStateForPlayer(after, 's') as { prompt: { id: number } }).prompt.id).not.toBe(prompt.id); });
  it('times out during recall and only exposes a recall fuse', () => { const study = fresh(); expect(spellingGame.getFuse!(study)).toBeNull(); const state = recall(study); expect(spellingGame.getFuse!(state)).toEqual({ deadlineAt: 15000, totalMs: 12000 }); expect(spellingGame.evaluate(spellingGame.onDeadline(state, ctx(15000)), ctx(15000))).toMatchObject({ status: 'resolved', success: false }); });
});
