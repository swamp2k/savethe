import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

interface NeedleAttempt {
  attemptId: number;
  startedAt: number;
  periodMs: number;
  zoneCenter: number;
  zoneWidth: number;
}

interface NeedleState {
  mpcId: string;
  supportIds: string[];
  requiredHits: number;
  hits: number;
  baseZoneWidth: number;
  mpcPeriodMs: number;
  mpcAttempt: NeedleAttempt;
  supportAttempts: Record<string, NeedleAttempt>;
  supportBoosts: number;
  timeBudgetMs: number;
  deadlineAt: number;
  nextAttemptId: number;
  outcome: 'pending' | 'success' | 'miss' | 'timeout';
}

const actionSchema = z.object({
  kind: z.literal('stop'),
  attemptId: z.number().int().nonnegative(),
  elapsedMs: z.number().int().min(0).max(30_000),
});
type NeedleAction = z.infer<typeof actionSchema>;

const BASE_REQUIRED_HITS = 3;
const MAX_REQUIRED_HITS = 6;
const BASE_PERIOD_MS = 1500;
const PERIOD_STEP_MS = 100;
const MIN_PERIOD_MS = 750;
const BASE_ZONE_WIDTH = 0.2;
const ZONE_STEP = 0.015;
const MIN_ZONE_WIDTH = 0.08;
const BASE_TIME_MS = 25_000;
const TIME_STEP_MS = 500;
const MIN_TIME_MS = 20_000;
const SUPPORT_PERIOD_MS = 1700;
const SUPPORT_ZONE_WIDTH = 0.3;
const SUPPORT_WIDTH_BONUS = 0.015;
const MAX_SUPPORT_BONUS = 0.08;
const MIN_PLAUSIBLE_MS = 80;
const LATENCY_TOLERANCE_MS = 150;

function asState(state: unknown): NeedleState {
  return state as NeedleState;
}

export function needlePosition(elapsedMs: number, periodMs: number): number {
  const phase = (elapsedMs % periodMs) / periodMs;
  return phase <= 0.5 ? phase * 2 : (1 - phase) * 2;
}

function randomZoneCenter(random: () => number): number {
  return 0.15 + random() * 0.7;
}

function isPlausible(elapsedMs: number, attemptStartedAt: number, now: number): boolean {
  return elapsedMs >= MIN_PLAUSIBLE_MS && elapsedMs <= now - attemptStartedAt + LATENCY_TOLERANCE_MS;
}

function currentMpcWidth(s: NeedleState): number {
  return Math.min(s.baseZoneWidth + MAX_SUPPORT_BONUS, s.baseZoneWidth + s.supportBoosts * SUPPORT_WIDTH_BONUS);
}

function createAttempt(id: number, startedAt: number, periodMs: number, zoneWidth: number, random: () => number): NeedleAttempt {
  return { attemptId: id, startedAt, periodMs, zoneCenter: randomZoneCenter(random), zoneWidth };
}

function freshMpcAttempt(s: NeedleState, ctx: MinigameContext): NeedleState {
  const mpcAttempt = createAttempt(s.nextAttemptId, ctx.now, s.mpcPeriodMs, currentMpcWidth(s), ctx.random);
  return { ...s, mpcAttempt, nextAttemptId: s.nextAttemptId + 1 };
}

function freshSupportAttempt(s: NeedleState, playerId: string, ctx: MinigameContext): NeedleState {
  const attempt = createAttempt(s.nextAttemptId, ctx.now, SUPPORT_PERIOD_MS, SUPPORT_ZONE_WIDTH, ctx.random);
  return { ...s, nextAttemptId: s.nextAttemptId + 1, supportAttempts: { ...s.supportAttempts, [playerId]: attempt } };
}

function hitsAttempt(attempt: NeedleAttempt, elapsedMs: number): boolean {
  const position = needlePosition(elapsedMs, attempt.periodMs);
  return position >= attempt.zoneCenter - attempt.zoneWidth / 2 && position <= attempt.zoneCenter + attempt.zoneWidth / 2;
}

export const stopTheNeedleGame: Minigame = {
  id: 'needle',
  title: 'Stop the Needle',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): NeedleState {
    const requiredHits = Math.min(MAX_REQUIRED_HITS, BASE_REQUIRED_HITS + Math.floor((config.difficulty - 1) / 2));
    const baseZoneWidth = Math.max(MIN_ZONE_WIDTH, BASE_ZONE_WIDTH - (config.difficulty - 1) * ZONE_STEP);
    const mpcPeriodMs = Math.max(MIN_PERIOD_MS, BASE_PERIOD_MS - (config.difficulty - 1) * PERIOD_STEP_MS);
    const timeBudgetMs = Math.max(MIN_TIME_MS, BASE_TIME_MS - (config.difficulty - 1) * TIME_STEP_MS);
    let nextAttemptId = 1;
    const mpcAttempt = createAttempt(nextAttemptId++, 0, mpcPeriodMs, baseZoneWidth, ctx.random);
    const supportAttempts: Record<string, NeedleAttempt> = {};
    for (const playerId of config.supportIds) supportAttempts[playerId] = createAttempt(nextAttemptId++, 0, SUPPORT_PERIOD_MS, SUPPORT_ZONE_WIDTH, ctx.random);
    return { mpcId: config.mpcId, supportIds: config.supportIds, requiredHits, hits: 0, baseZoneWidth, mpcPeriodMs, mpcAttempt, supportAttempts, supportBoosts: 0, timeBudgetMs, deadlineAt: 0, nextAttemptId, outcome: 'pending' };
  },

  onStart(state: unknown, ctx: MinigameContext): NeedleState {
    const s = asState(state);
    const supportAttempts = Object.fromEntries(Object.entries(s.supportAttempts).map(([id, attempt]) => [id, { ...attempt, startedAt: ctx.now }]));
    return { ...s, mpcAttempt: { ...s.mpcAttempt, startedAt: ctx.now }, supportAttempts, deadlineAt: ctx.now + s.timeBudgetMs };
  },

  handleMpcAction(state: unknown, action: unknown, ctx: MinigameContext): NeedleState {
    const s = asState(state);
    const a = action as NeedleAction;
    if (s.outcome !== 'pending' || a.attemptId !== s.mpcAttempt.attemptId || !isPlausible(a.elapsedMs, s.mpcAttempt.startedAt, ctx.now)) return s;
    if (!hitsAttempt(s.mpcAttempt, a.elapsedMs)) return { ...s, outcome: 'miss' };
    const hits = s.hits + 1;
    if (hits >= s.requiredHits) return { ...s, hits, outcome: 'success' };
    return freshMpcAttempt({ ...s, hits }, ctx);
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): NeedleState {
    const s = asState(state);
    const a = action as NeedleAction;
    const attempt = s.supportAttempts[playerId];
    if (s.outcome !== 'pending' || !attempt || a.attemptId !== attempt.attemptId || !isPlausible(a.elapsedMs, attempt.startedAt, ctx.now)) return s;
    if (!hitsAttempt(attempt, a.elapsedMs)) return freshSupportAttempt(s, playerId, ctx);
    const supportBoosts = s.supportBoosts + 1;
    const boosted = { ...s, supportBoosts, mpcAttempt: { ...s.mpcAttempt, zoneWidth: Math.min(s.baseZoneWidth + MAX_SUPPORT_BONUS, s.baseZoneWidth + supportBoosts * SUPPORT_WIDTH_BONUS) } };
    return freshSupportAttempt(boosted, playerId, ctx);
  },

  onDeadline(state: unknown, ctx: MinigameContext): NeedleState {
    const s = asState(state);
    return s.outcome === 'pending' && ctx.now >= s.deadlineAt ? { ...s, outcome: 'timeout' } : s;
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    if (s.outcome === 'success') return { status: 'resolved', success: true, headline: 'LOCKED! The needle stopped exactly in time.' };
    if (s.outcome === 'miss') return { status: 'resolved', success: false, headline: 'MISS. The needle slipped away.' };
    if (s.outcome === 'timeout') return { status: 'resolved', success: false, headline: 'Too late. The meter never locked.' };
    return { status: 'active' };
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.outcome === 'pending' ? s.deadlineAt : null;
  },

  getFuse(state: unknown): { deadlineAt: number; totalMs: number } | null {
    const s = asState(state);
    return s.outcome === 'pending' ? { deadlineAt: s.deadlineAt, totalMs: s.timeBudgetMs } : null;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const progress = { role, hits: s.hits, requiredHits: s.requiredHits, supportBoosts: s.supportBoosts };
    if (role === 'mpc') return { ...progress, attempt: pickAttempt(s.mpcAttempt) };
    if (role === 'support') return { ...progress, attempt: pickAttempt(s.supportAttempts[viewerId]!) };
    return progress;
  },
};

function pickAttempt(attempt: NeedleAttempt): Omit<NeedleAttempt, 'startedAt'> {
  return {
    attemptId: attempt.attemptId,
    periodMs: attempt.periodMs,
    zoneCenter: attempt.zoneCenter,
    zoneWidth: attempt.zoneWidth,
  };
}
