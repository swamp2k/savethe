import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

type Stage = 'study' | 'recall';
interface Prompt { id: number; options: string[]; correctIndex: number; }
interface State { mpcId: string; supportIds: string[]; targetWord: string; stage: Stage; revealed: boolean[]; studyMs: number; recallMs: number; deadlineAt: number; supportPrompts: Record<string, Prompt>; nextPromptId: number; submittedWord: string | null; supportReveals: number; outcome: 'pending' | 'success' | 'misspelled' | 'timeout'; }
const EASY = ['banana', 'blanket', 'penguin', 'balloon', 'rescue', 'turtle', 'monster', 'pillow'];
const MEDIUM = ['definitely', 'separate', 'calendar', 'necessary', 'scissors', 'surprise', 'tomorrow', 'business'];
const HARD = ['embarrass', 'privilege', 'accommodate', 'questionnaire', 'rhythm', 'conscientious', 'miscellaneous', 'maintenance'];
const PROMPTS = [{ correct: 'receive', wrong: ['recieve', 'receeve'] }, { correct: 'weird', wrong: ['wierd', 'weerd'] }, { correct: 'friend', wrong: ['freind', 'frend'] }, { correct: 'because', wrong: ['becuase', 'becouse'] }, { correct: 'piece', wrong: ['peice', 'peece'] }];
const actionSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('submit'), word: z.string().trim().min(1).max(40) }), z.object({ kind: z.literal('support_answer'), promptId: z.number().int().nonnegative(), optionIndex: z.number().int().min(0).max(2) })]);
type Action = z.infer<typeof actionSchema>;
const asState = (state: unknown) => state as State;
const pool = (difficulty: number) => difficulty <= 2 ? EASY : difficulty <= 4 ? MEDIUM : HARD;
const shuffle = <T,>(items: T[], random: () => number) => { const result = [...items]; for (let i = result.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; } return result; };
function prompt(id: number, random: () => number): Prompt { const choice = PROMPTS[Math.floor(random() * PROMPTS.length)] ?? PROMPTS[0]; const options = shuffle([choice.correct, ...choice.wrong], random); return { id, options, correctIndex: options.indexOf(choice.correct) }; }
function prompts(ids: string[], nextPromptId: number, random: () => number): Record<string, Prompt> { return Object.fromEntries(ids.map((id, index) => [id, prompt(nextPromptId + index, random)])); }

export const spellingGame: Minigame = {
  id: 'spelling', title: 'Spelling Panic', actionSchema,
  createInitialState(config: MinigameConfig, ctx: MinigameContext): State {
    const targetWord = pool(config.difficulty)[Math.floor(ctx.random() * pool(config.difficulty).length)] ?? EASY[0];
    const studyMs = Math.max(1500, 3000 - (config.difficulty - 1) * 250);
    const recallMs = Math.max(7000, 12000 - (config.difficulty - 1) * 750);
    return { mpcId: config.mpcId, supportIds: config.supportIds, targetWord, stage: 'study', revealed: targetWord.split('').map((_, i) => i === 0 || i === targetWord.length - 1), studyMs, recallMs, deadlineAt: 0, supportPrompts: prompts(config.supportIds, 1, ctx.random), nextPromptId: config.supportIds.length + 1, submittedWord: null, supportReveals: 0, outcome: 'pending' };
  },
  onStart(state: unknown, ctx: MinigameContext): State { const s = asState(state); return { ...s, deadlineAt: ctx.now + s.studyMs }; },
  handleMpcAction(state: unknown, action: unknown): State { const s = asState(state); if (s.outcome !== 'pending' || s.stage !== 'recall') return s; const a = action as Action; if (a.kind !== 'submit') return s; const correct = a.word.trim().toLowerCase() === s.targetWord.toLowerCase(); return { ...s, submittedWord: a.word, outcome: correct ? 'success' : 'misspelled' }; },
  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): State {
    const s = asState(state); const a = action as Action; const current = s.supportPrompts[playerId];
    if (s.outcome !== 'pending' || s.stage !== 'recall' || a.kind !== 'support_answer' || !current || a.promptId !== current.id) return s;
    const correct = a.optionIndex === current.correctIndex;
    const hidden = s.revealed.map((shown, index) => shown ? -1 : index).filter((index) => index >= 0);
    const reveal = correct && hidden.length > 0 ? hidden[Math.floor(ctx.random() * hidden.length)] : undefined;
    const revealed = reveal === undefined ? s.revealed : s.revealed.map((shown, index) => index === reveal || shown);
    const next = prompt(s.nextPromptId, ctx.random);
    return { ...s, revealed, supportReveals: s.supportReveals + (reveal === undefined ? 0 : 1), nextPromptId: s.nextPromptId + 1, supportPrompts: { ...s.supportPrompts, [playerId]: next } };
  },
  onDeadline(state: unknown, ctx: MinigameContext): State { const s = asState(state); if (s.outcome !== 'pending' || ctx.now < s.deadlineAt) return s; return s.stage === 'study' ? { ...s, stage: 'recall', deadlineAt: ctx.now + s.recallMs } : { ...s, outcome: 'timeout' }; },
  evaluate(state: unknown): MinigameOutcome { const s = asState(state); if (s.outcome === 'success') return { status: 'resolved', success: true, headline: `Perfect spelling! ${s.supportReveals} letter reveal${s.supportReveals === 1 ? '' : 's'}.` }; if (s.outcome === 'misspelled') return { status: 'resolved', success: false, headline: 'That spelling was not accepted.' }; if (s.outcome === 'timeout') return { status: 'resolved', success: false, headline: 'Out of time. The word vanished.' }; return { status: 'active' }; },
  getNextDeadline(state: unknown): number | null { const s = asState(state); return s.outcome === 'pending' ? s.deadlineAt : null; },
  getFuse(state: unknown): { deadlineAt: number; totalMs: number } | null { const s = asState(state); return s.outcome === 'pending' && s.stage === 'recall' ? { deadlineAt: s.deadlineAt, totalMs: s.recallMs } : null; },
  getStateForPlayer(state: unknown, viewerId: string): unknown { const s = asState(state); const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator'; if (role === 'mpc') return s.stage === 'study' ? { role, stage: s.stage, studyWord: s.targetWord } : { role, stage: s.stage, mask: s.targetWord.split('').map((letter, i) => s.revealed[i] ? letter : '_'), wordLength: s.targetWord.length, supportReveals: s.supportReveals }; if (role === 'support') return s.stage === 'study' ? { role, stage: s.stage } : { role, stage: s.stage, prompt: s.supportPrompts[viewerId] ? { id: s.supportPrompts[viewerId].id, options: s.supportPrompts[viewerId].options } : null }; return { role, stage: s.stage }; },
};
