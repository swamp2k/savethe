import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

/**
 * The Typing Challenge. Design doc section 10's "shared workload" model: the
 * MPC types a themed passage toward a target word count; support players
 * work through their own repeating queue of short phrases, and every phrase
 * they complete lowers the MPC's remaining requirement (never below a floor,
 * so support can meaningfully help without trivializing the MPC's own task).
 *
 * This exists primarily to stress-test the minigame plugin abstraction
 * against a genuinely different shape of challenge than the Reaction Test:
 * continuous incremental progress instead of one shot, several players
 * typing simultaneously and independently instead of a single race, and a
 * composite save condition (word count AND an overall time budget) instead
 * of a single threshold.
 *
 * Server-authoritative typing: the client sends its *current full input
 * value* on every keystroke (not deltas), and the server recomputes the
 * correctly-typed word count fresh each time — this naturally and correctly
 * handles corrections (backspacing a typo) without any incremental state to
 * desync. A word only counts once it's "sealed" behind a trailing space, so
 * a still-in-progress word isn't credited early. Progress increments are
 * rate-limited against a maximum plausible typing speed so a client can't
 * just paste the answer in (PLAN.md M4: "validates progress increments for
 * plausibility, max human WPM bounds").
 */

interface SupportBurst {
  phraseWords: string[];
  completedCount: number;
}

interface TypingState {
  mpcId: string;
  supportIds: string[];
  passageWords: string[];
  mpcWordsCorrect: number;
  wordsRequired: number;
  timeBudgetMs: number;
  startedAt: number;
  deadlineForChallenge: number;
  supportBursts: Record<string, SupportBurst>;
  totalSupportCompletions: number;
  /** Last accepted (time, wordsCorrect) checkpoint per typist, for the WPM
   *  plausibility check. Keyed by 'mpc' or a support playerId. */
  rate: Record<string, { at: number; wordsCorrect: number }>;
  outcome: 'pending' | 'mpc_success' | 'total_failure';
}

const actionSchema = z.object({ kind: z.literal('type'), text: z.string().max(200) });
type TypingAction = z.infer<typeof actionSchema>;

const BASE_PASSAGE_WORDS = 7;
const PASSAGE_WORDS_STEP = 1;
const MAX_PASSAGE_WORDS = 14;

const BASE_TIME_BUDGET_MS = 25_000;
const TIME_BUDGET_STEP_MS = 1_000;
const MIN_TIME_BUDGET_MS = 16_000;

const SUPPORT_REDUCTION_PER_BURST = 2;
/** Support can lower the MPC's target, but never trivialize their task. */
const WORDS_REQUIRED_FLOOR_RATIO = 0.4;
const WORDS_REQUIRED_FLOOR_MIN = 4;

/** Generous ceiling — elite sustained typing tops out well below this, so
 *  only a paste-like burst should ever trip it. */
const MAX_TYPING_WPM = 200;

const WORD_BANK = [
  'save',
  'grab',
  'rescue',
  'hold',
  'pull',
  'catch',
  'protect',
  'carry',
  'lift',
  'guard',
  'bear',
  'frog',
  'penguin',
  'turtle',
  'fox',
  'unicorn',
  'robot',
  'ghost',
  'wizard',
  'kitten',
  'fluffy',
  'tiny',
  'brave',
  'sleepy',
  'grumpy',
  'silly',
  'shiny',
  'wobbly',
  'magic',
  'clumsy',
  'rope',
  'ladder',
  'basket',
  'blanket',
  'balloon',
  'bridge',
  'net',
  'pillow',
  'cape',
  'umbrella',
  'quick',
  'now',
  'please',
  'fast',
  'careful',
  'gently',
  'tightly',
  'forever',
  'together',
  'safely',
];

function randomWords(random: () => number, count: number): string[] {
  const words: string[] = [];
  for (let i = 0; i < count; i++) {
    words.push(WORD_BANK[Math.floor(random() * WORD_BANK.length)]);
  }
  return words;
}

function randomPhraseLength(random: () => number): number {
  return 2 + Math.floor(random() * 2); // 2 or 3 words
}

function asState(state: unknown): TypingState {
  return state as TypingState;
}

/** Correctly-typed leading word count. A word only counts once "sealed"
 *  behind a trailing space, so an in-progress word isn't credited early.
 *  Recomputed fresh from the full current text, so corrections (backspacing
 *  a typo) just work — there's no incremental state to fall out of sync. */
function countCorrectWords(target: string[], typed: string): number {
  const trimmed = typed.trim();
  if (trimmed.length === 0) return 0;
  const tokens = trimmed.split(/\s+/);
  // A trailing space seals a word — except the very last word of the whole
  // passage, which needs no "one more space I didn't actually need to type"
  // papercut: once there are as many tokens as the passage has words, the
  // final one is eligible too. (This never over-credits an earlier
  // still-in-progress word: whether it's classed as "sealed and wrong" or
  // "not yet sealed," an incomplete word is never counted correct either way.)
  const sealed = typed.endsWith(' ') || tokens.length >= target.length;
  const sealedCount = sealed ? tokens.length : tokens.length - 1;
  let correct = 0;
  for (let i = 0; i < sealedCount && i < target.length; i++) {
    if (tokens[i].toLowerCase() === target[i].toLowerCase()) correct++;
    else break; // words must match in order
  }
  return correct;
}

/** Only forward progress is rate-limited; a correction (typed text getting
 *  less "correct") is never suspicious and always accepted. */
function isRateOk(deltaWords: number, deltaMs: number): boolean {
  if (deltaWords <= 0) return true;
  const minutes = deltaMs / 60_000;
  return deltaWords / minutes <= MAX_TYPING_WPM;
}

function wordsRequiredFloor(passageLength: number): number {
  return Math.max(WORDS_REQUIRED_FLOOR_MIN, Math.ceil(passageLength * WORDS_REQUIRED_FLOOR_RATIO));
}

export const typingGame: Minigame = {
  id: 'typing',
  title: 'Typing Challenge',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): TypingState {
    const passageLength = Math.min(
      MAX_PASSAGE_WORDS,
      BASE_PASSAGE_WORDS + (config.difficulty - 1) * PASSAGE_WORDS_STEP,
    );
    const passageWords = randomWords(ctx.random, passageLength);
    const timeBudgetMs = Math.max(MIN_TIME_BUDGET_MS, BASE_TIME_BUDGET_MS - (config.difficulty - 1) * TIME_BUDGET_STEP_MS);

    const supportBursts: Record<string, SupportBurst> = {};
    for (const id of config.supportIds) {
      supportBursts[id] = { phraseWords: randomWords(ctx.random, randomPhraseLength(ctx.random)), completedCount: 0 };
    }

    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      passageWords,
      mpcWordsCorrect: 0,
      wordsRequired: passageWords.length,
      timeBudgetMs,
      startedAt: 0,
      deadlineForChallenge: 0,
      supportBursts,
      totalSupportCompletions: 0,
      rate: {},
      outcome: 'pending',
    };
  },

  onStart(state: unknown, ctx: MinigameContext): TypingState {
    const s = asState(state);
    return { ...s, startedAt: ctx.now, deadlineForChallenge: ctx.now + s.timeBudgetMs };
  },

  handleMpcAction(state: unknown, action: unknown, ctx: MinigameContext): TypingState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const a = action as TypingAction;

    const newCorrect = countCorrectWords(s.passageWords, a.text);
    const checkpoint = s.rate.mpc ?? { at: s.startedAt, wordsCorrect: 0 };
    if (!isRateOk(newCorrect - checkpoint.wordsCorrect, ctx.now - checkpoint.at)) return s; // implausible burst

    const next: TypingState = {
      ...s,
      mpcWordsCorrect: newCorrect,
      rate: { ...s.rate, mpc: { at: ctx.now, wordsCorrect: newCorrect } },
    };
    return newCorrect >= next.wordsRequired ? { ...next, outcome: 'mpc_success' } : next;
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): TypingState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const burst = s.supportBursts[playerId];
    if (!burst) return s; // not a support player this round
    const a = action as TypingAction;

    const newCorrect = countCorrectWords(burst.phraseWords, a.text);
    const checkpoint = s.rate[playerId] ?? { at: s.startedAt, wordsCorrect: 0 };
    if (!isRateOk(newCorrect - checkpoint.wordsCorrect, ctx.now - checkpoint.at)) return s; // implausible burst

    if (newCorrect < burst.phraseWords.length) {
      // Progress within the current phrase; nothing about the burst itself
      // (its assigned words, completion count) changes yet.
      return { ...s, rate: { ...s.rate, [playerId]: { at: ctx.now, wordsCorrect: newCorrect } } };
    }

    // Phrase completed: credit it, lower the MPC's bar, hand out a fresh
    // phrase so support stays engaged for the whole challenge rather than
    // going idle after one contribution.
    const wordsRequired = Math.max(
      wordsRequiredFloor(s.passageWords.length),
      s.wordsRequired - SUPPORT_REDUCTION_PER_BURST,
    );
    const next: TypingState = {
      ...s,
      supportBursts: {
        ...s.supportBursts,
        [playerId]: {
          phraseWords: randomWords(ctx.random, randomPhraseLength(ctx.random)),
          completedCount: burst.completedCount + 1,
        },
      },
      wordsRequired,
      totalSupportCompletions: s.totalSupportCompletions + 1,
      rate: { ...s.rate, [playerId]: { at: ctx.now, wordsCorrect: 0 } }, // fresh phrase, fresh checkpoint
    };
    // The lowered bar may already be met by the MPC's existing progress —
    // a support completion can win the round outright.
    return next.mpcWordsCorrect >= wordsRequired ? { ...next, outcome: 'mpc_success' } : next;
  },

  onDeadline(state: unknown, ctx: MinigameContext): TypingState {
    const s = asState(state);
    if (s.outcome === 'pending' && ctx.now >= s.deadlineForChallenge) {
      return { ...s, outcome: 'total_failure' };
    }
    return s;
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    switch (s.outcome) {
      case 'mpc_success': {
        const assist = s.totalSupportCompletions > 0 ? ` (${s.totalSupportCompletions} team assist${s.totalSupportCompletions === 1 ? '' : 's'})` : '';
        return { status: 'resolved', success: true, headline: `Typed it! ${s.wordsRequired} words${assist}.` };
      }
      case 'total_failure':
        return {
          status: 'resolved',
          success: false,
          headline: `Out of time — ${s.mpcWordsCorrect}/${s.wordsRequired} words typed.`,
        };
      case 'pending':
        return { status: 'active' };
    }
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.outcome === 'pending' ? s.deadlineForChallenge : null;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const base = {
      role,
      passageWords: s.passageWords,
      wordsCorrect: s.mpcWordsCorrect,
      wordsRequired: s.wordsRequired,
      totalSupportCompletions: s.totalSupportCompletions,
    };
    if (role === 'support') {
      const burst = s.supportBursts[viewerId];
      return { ...base, myPhraseWords: burst?.phraseWords ?? [], myCompletedCount: burst?.completedCount ?? 0 };
    }
    return base;
  },
};
