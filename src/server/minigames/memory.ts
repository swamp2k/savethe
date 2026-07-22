import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

const SYMBOLS = ['🔴', '🟡', '🔵', '🟢', '⭐', '💜'] as const;

interface SupportSequence {
  sequence: string[];
  index: number;
  stage: 'study' | 'recall';
  studyDeadlineAt: number;
  wrongAttempts: number;
}

interface MemoryState {
  mpcId: string;
  supportIds: string[];
  sequence: string[];
  sequenceLength: number;
  msPerSymbol: number;
  /** Live target. Support completions lower this, never below the floor. */
  requiredCorrect: number;
  initialRequiredCorrect: number;
  stage: 'study' | 'recall';
  recallIndex: number;
  startedAt: number;
  studyDeadlineAt: number;
  deadlineForChallenge: number;
  timeBudgetMs: number;
  supportSequence: Record<string, SupportSequence>;
  supportCompletions: number;
  outcome: 'pending' | 'mpc_success' | 'wrong_guess' | 'timeout';
}

const actionSchema = z.object({ kind: z.literal('recall'), symbol: z.enum(SYMBOLS) });
type MemoryAction = z.infer<typeof actionSchema>;

const BASE_SEQUENCE_LENGTH = 4;
const SEQUENCE_LENGTH_STEP = 1;
const MAX_SEQUENCE_LENGTH = 8;
const BASE_MS_PER_SYMBOL = 700;
const MS_PER_SYMBOL_STEP = 30;
const MIN_MS_PER_SYMBOL = 400;
const TIME_BUDGET_MS = 25_000;
const SUPPORT_SEQUENCE_LENGTH = 3;
const SUPPORT_STUDY_MS = 1_800;
const SUPPORT_RESTUDY_MS = 1_200;
const SUPPORT_REDUCTION_PER_COMPLETION = 1;
const REQUIRED_CORRECT_FLOOR_RATIO = 0.4;
const REQUIRED_CORRECT_FLOOR_MIN = 2;

function randomSymbols(random: () => number, count: number): string[] {
  return Array.from({ length: count }, () => SYMBOLS[Math.floor(random() * SYMBOLS.length)]);
}

function requiredCorrectFloor(initialRequiredCorrect: number): number {
  return Math.max(REQUIRED_CORRECT_FLOOR_MIN, Math.ceil(initialRequiredCorrect * REQUIRED_CORRECT_FLOOR_RATIO));
}

function asState(state: unknown): MemoryState {
  return state as MemoryState;
}

function studyingSupport(sequence: string[], deadline: number, wrongAttempts = 0): SupportSequence {
  return { sequence, index: 0, stage: 'study', studyDeadlineAt: deadline, wrongAttempts };
}

export const memoryGame: Minigame = {
  id: 'memory',
  title: 'Memory',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): MemoryState {
    const sequenceLength = Math.min(MAX_SEQUENCE_LENGTH, BASE_SEQUENCE_LENGTH + (config.difficulty - 1) * SEQUENCE_LENGTH_STEP);
    const msPerSymbol = Math.max(MIN_MS_PER_SYMBOL, BASE_MS_PER_SYMBOL - (config.difficulty - 1) * MS_PER_SYMBOL_STEP);
    const supportSequence = Object.fromEntries(config.supportIds.map((id) => [
      id,
      studyingSupport(randomSymbols(ctx.random, SUPPORT_SEQUENCE_LENGTH), 0),
    ]));
    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      sequence: randomSymbols(ctx.random, sequenceLength),
      sequenceLength,
      msPerSymbol,
      requiredCorrect: sequenceLength,
      initialRequiredCorrect: sequenceLength,
      stage: 'study',
      recallIndex: 0,
      startedAt: 0,
      studyDeadlineAt: 0,
      deadlineForChallenge: 0,
      timeBudgetMs: TIME_BUDGET_MS,
      supportSequence,
      supportCompletions: 0,
      outcome: 'pending',
    };
  },

  onStart(state: unknown, ctx: MinigameContext): MemoryState {
    const s = asState(state);
    const studyDurationMs = s.sequenceLength * s.msPerSymbol;
    const supportSequence = Object.fromEntries(Object.entries(s.supportSequence).map(([id, support]) => [
      id,
      { ...support, studyDeadlineAt: ctx.now + SUPPORT_STUDY_MS },
    ]));
    return {
      ...s,
      startedAt: ctx.now,
      studyDeadlineAt: ctx.now + studyDurationMs,
      deadlineForChallenge: ctx.now + studyDurationMs + s.timeBudgetMs,
      supportSequence,
    };
  },

  handleMpcAction(state: unknown, action: unknown): MemoryState {
    const s = asState(state);
    if (s.outcome !== 'pending' || s.stage !== 'recall') return s;
    const a = action as MemoryAction;
    if (a.symbol !== s.sequence[s.recallIndex]) return { ...s, outcome: 'wrong_guess' };
    const recallIndex = s.recallIndex + 1;
    return recallIndex >= s.requiredCorrect ? { ...s, recallIndex, outcome: 'mpc_success' } : { ...s, recallIndex };
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): MemoryState {
    const s = asState(state);
    const support = s.supportSequence[playerId];
    if (s.outcome !== 'pending' || !support || support.stage !== 'recall') return s;
    const a = action as MemoryAction;

    if (a.symbol !== support.sequence[support.index]) {
      return {
        ...s,
        supportSequence: {
          ...s.supportSequence,
          [playerId]: studyingSupport(support.sequence, ctx.now + SUPPORT_RESTUDY_MS, support.wrongAttempts + 1),
        },
      };
    }

    const index = support.index + 1;
    if (index < support.sequence.length) {
      return { ...s, supportSequence: { ...s.supportSequence, [playerId]: { ...support, index } } };
    }

    const requiredCorrect = Math.max(requiredCorrectFloor(s.initialRequiredCorrect), s.requiredCorrect - SUPPORT_REDUCTION_PER_COMPLETION);
    const next: MemoryState = {
      ...s,
      supportSequence: {
        ...s.supportSequence,
        [playerId]: studyingSupport(randomSymbols(ctx.random, SUPPORT_SEQUENCE_LENGTH), ctx.now + SUPPORT_STUDY_MS, support.wrongAttempts),
      },
      requiredCorrect,
      supportCompletions: s.supportCompletions + 1,
    };
    return next.recallIndex >= requiredCorrect ? { ...next, outcome: 'mpc_success' } : next;
  },

  onDeadline(state: unknown, ctx: MinigameContext): MemoryState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const supportSequence = Object.fromEntries(Object.entries(s.supportSequence).map(([id, support]) => [
      id,
      support.stage === 'study' && ctx.now >= support.studyDeadlineAt ? { ...support, stage: 'recall' as const } : support,
    ]));
    const stage = s.stage === 'study' && ctx.now >= s.studyDeadlineAt ? 'recall' as const : s.stage;
    if (stage === 'recall' && ctx.now >= s.deadlineForChallenge) return { ...s, stage, supportSequence, outcome: 'timeout' };
    return { ...s, stage, supportSequence };
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    if (s.outcome === 'mpc_success') {
      const assist = s.supportCompletions > 0 ? ` (${s.supportCompletions} memory assist${s.supportCompletions === 1 ? '' : 's'})` : '';
      return { status: 'resolved', success: true, headline: `Remembered it! ${s.recallIndex}/${s.requiredCorrect} symbols${assist}.` };
    }
    if (s.outcome === 'wrong_guess') return { status: 'resolved', success: false, headline: `Wrong! Got ${s.recallIndex}/${s.requiredCorrect} symbols right.` };
    if (s.outcome === 'timeout') return { status: 'resolved', success: false, headline: `Out of time — ${s.recallIndex}/${s.requiredCorrect} symbols recalled.` };
    return { status: 'active' };
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    if (s.outcome !== 'pending') return null;
    const deadlines = [s.stage === 'study' ? s.studyDeadlineAt : s.deadlineForChallenge];
    for (const support of Object.values(s.supportSequence)) if (support.stage === 'study') deadlines.push(support.studyDeadlineAt);
    return Math.min(...deadlines);
  },

  getFuse(state: unknown): { deadlineAt: number; totalMs: number } | null {
    const s = asState(state);
    if (s.outcome !== 'pending') return null;
    return s.stage === 'study'
      ? { deadlineAt: s.studyDeadlineAt, totalMs: s.studyDeadlineAt - s.startedAt }
      : { deadlineAt: s.deadlineForChallenge, totalMs: s.timeBudgetMs };
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const base = { role, stage: s.stage, recallIndex: s.recallIndex, requiredCorrect: s.requiredCorrect, supportCompletions: s.supportCompletions, alphabet: SYMBOLS };
    if (role === 'mpc') return { ...base, sequence: s.stage === 'study' ? s.sequence : undefined };
    if (role === 'support') {
      const support = s.supportSequence[viewerId];
      return {
        ...base,
        myStage: support?.stage ?? 'recall',
        mySequence: support?.stage === 'study' ? support.sequence : undefined,
        myIndex: support?.index ?? 0,
        myLength: support?.sequence.length ?? SUPPORT_SEQUENCE_LENGTH,
        myWrongAttempts: support?.wrongAttempts ?? 0,
      };
    }
    return base;
  },
};
