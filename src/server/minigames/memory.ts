import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

/**
 * Memory. The MPC studies a sequence of symbols (revealed once, in full, at
 * the start of the challenge), then must click them back in order once the
 * study window closes. A wrong click ends the round immediately — no soft
 * miss-and-retry here, unlike Aim Trainer; the tension is "remember it
 * right or it's over."
 *
 * No fairness-driven secret exists (unlike Reaction Test's hidden signal),
 * so the generic countdown is shown normally through both the study and
 * recall windows — `isDeadlineHidden` is simply omitted.
 *
 * Support gets their own, always-visible mini-sequence (no study/hide step,
 * no deadline of its own — same "support is never itself deadline-bound"
 * rule Aim Trainer's support target follows) and every completion lowers
 * how many symbols the MPC actually needs to land, floored, reusing Typing
 * Challenge's and Aim Trainer's proven support-lowers-the-bar shape for a
 * third time.
 */

const SYMBOLS = ['🔴', '🟡', '🟢', '🔵', '🟣', '⚪'] as const;

interface SupportSequence {
  sequence: string[];
  index: number;
}

interface MemoryState {
  mpcId: string;
  supportIds: string[];
  sequence: string[];
  sequenceLength: number;
  msPerSymbol: number;
  /** The bar support can lower; never below `requiredCorrectFloor(initialRequiredCorrect)`. */
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

/** Recall-phase budget, fixed rather than difficulty-scaled — sequence
 *  length and study speed above already carry the difficulty curve. */
const TIME_BUDGET_MS = 15_000;

const SUPPORT_SEQUENCE_LENGTH = 3;
const SUPPORT_REDUCTION_PER_COMPLETION = 1;
const REQUIRED_CORRECT_FLOOR_RATIO = 0.4;
const REQUIRED_CORRECT_FLOOR_MIN = 2;

function randomSymbols(random: () => number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(SYMBOLS[Math.floor(random() * SYMBOLS.length)]);
  return out;
}

function requiredCorrectFloor(initialRequiredCorrect: number): number {
  return Math.max(REQUIRED_CORRECT_FLOOR_MIN, Math.ceil(initialRequiredCorrect * REQUIRED_CORRECT_FLOOR_RATIO));
}

function asState(state: unknown): MemoryState {
  return state as MemoryState;
}

export const memoryGame: Minigame = {
  id: 'memory',
  title: 'Memory',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): MemoryState {
    const sequenceLength = Math.min(
      MAX_SEQUENCE_LENGTH,
      BASE_SEQUENCE_LENGTH + (config.difficulty - 1) * SEQUENCE_LENGTH_STEP,
    );
    const msPerSymbol = Math.max(MIN_MS_PER_SYMBOL, BASE_MS_PER_SYMBOL - (config.difficulty - 1) * MS_PER_SYMBOL_STEP);
    const sequence = randomSymbols(ctx.random, sequenceLength);

    const supportSequence: Record<string, SupportSequence> = {};
    for (const id of config.supportIds) {
      supportSequence[id] = { sequence: randomSymbols(ctx.random, SUPPORT_SEQUENCE_LENGTH), index: 0 };
    }

    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      sequence,
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
    return {
      ...s,
      startedAt: ctx.now,
      studyDeadlineAt: ctx.now + studyDurationMs,
      deadlineForChallenge: ctx.now + studyDurationMs + s.timeBudgetMs,
    };
  },

  handleMpcAction(state: unknown, action: unknown): MemoryState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    if (s.stage !== 'recall') return s; // still studying; ignore an eager early click
    const a = action as MemoryAction;

    if (a.symbol !== s.sequence[s.recallIndex]) {
      return { ...s, outcome: 'wrong_guess' };
    }
    const recallIndex = s.recallIndex + 1;
    if (recallIndex >= s.requiredCorrect) return { ...s, recallIndex, outcome: 'mpc_success' };
    return { ...s, recallIndex };
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): MemoryState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const support = s.supportSequence[playerId];
    if (!support) return s; // not a support player this round
    const a = action as MemoryAction;

    if (a.symbol !== support.sequence[support.index]) {
      // Wrong: reset just this player's own progress, no team-wide penalty.
      return { ...s, supportSequence: { ...s.supportSequence, [playerId]: { ...support, index: 0 } } };
    }
    const index = support.index + 1;
    if (index < support.sequence.length) {
      return { ...s, supportSequence: { ...s.supportSequence, [playerId]: { ...support, index } } };
    }

    // Completed their sequence: lower the MPC's bar, hand out a fresh one.
    const requiredCorrect = Math.max(
      requiredCorrectFloor(s.initialRequiredCorrect),
      s.requiredCorrect - SUPPORT_REDUCTION_PER_COMPLETION,
    );
    const next: MemoryState = {
      ...s,
      supportSequence: {
        ...s.supportSequence,
        [playerId]: { sequence: randomSymbols(ctx.random, SUPPORT_SEQUENCE_LENGTH), index: 0 },
      },
      requiredCorrect,
      supportCompletions: s.supportCompletions + 1,
    };
    // The lowered bar may already be met by the MPC's existing progress.
    return next.recallIndex >= requiredCorrect ? { ...next, outcome: 'mpc_success' } : next;
  },

  onDeadline(state: unknown, ctx: MinigameContext): MemoryState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    if (s.stage === 'study' && ctx.now >= s.studyDeadlineAt) {
      return { ...s, stage: 'recall' };
    }
    if (s.stage === 'recall' && ctx.now >= s.deadlineForChallenge) {
      return { ...s, outcome: 'timeout' };
    }
    return s;
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    switch (s.outcome) {
      case 'mpc_success': {
        const assist =
          s.supportCompletions > 0 ? ` (${s.supportCompletions} team assist${s.supportCompletions === 1 ? '' : 's'})` : '';
        return { status: 'resolved', success: true, headline: `Remembered it! ${s.requiredCorrect}/${s.requiredCorrect} symbols${assist}.` };
      }
      case 'wrong_guess':
        return { status: 'resolved', success: false, headline: `Wrong! Got ${s.recallIndex}/${s.requiredCorrect} symbols right.` };
      case 'timeout':
        return { status: 'resolved', success: false, headline: `Out of time — ${s.recallIndex}/${s.requiredCorrect} symbols recalled.` };
      case 'pending':
        return { status: 'active' };
    }
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    if (s.outcome !== 'pending') return null;
    return s.stage === 'study' ? s.studyDeadlineAt : s.deadlineForChallenge;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const base = {
      role,
      stage: s.stage,
      recallIndex: s.recallIndex,
      requiredCorrect: s.requiredCorrect,
      supportCompletions: s.supportCompletions,
      alphabet: SYMBOLS,
    };
    if (role === 'mpc') {
      return { ...base, sequence: s.stage === 'study' ? s.sequence : undefined };
    }
    if (role === 'support') {
      const support = s.supportSequence[viewerId];
      return { ...base, mySequence: support?.sequence ?? [], myIndex: support?.index ?? 0 };
    }
    return base;
  },
};
