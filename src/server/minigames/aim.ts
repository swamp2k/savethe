import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

/**
 * Aim Trainer. A target appears at a random spot and disappears after a
 * short, difficulty-scaled window; the MPC needs `requiredHits` successful
 * clicks within an overall time budget. Support players get their own
 * concurrent target — one that never expires, since support isn't meant to
 * be reaction-tested, just kept engaged — and every support hit lowers the
 * MPC's bar (floored so support can't trivialize it, and able to win the
 * round outright if it drops the bar to the MPC's current hit count).
 *
 * Deliberately reuses two already-proven mechanics instead of inventing a
 * third: the MPC side is Reaction Test's client-measured-elapsed-time +
 * server-plausibility-check model (PLAN.md decision 3), and the support side
 * is Typing Challenge's concurrent-support-lowers-the-bar model. Target
 * position (`x`/`y`, normalized 0-1) is purely cosmetic — never validated —
 * the server only ever needs to know *which* target id was clicked and how
 * fast, the same trust model every other button click in this codebase uses.
 */

interface SupportTarget {
  id: number;
  x: number;
  y: number;
  spawnAt: number;
}

interface AimState {
  mpcId: string;
  supportIds: string[];
  /** The bar support can lower; never below `requiredHitsFloor(initialRequiredHits)`. */
  requiredHits: number;
  initialRequiredHits: number;
  hitThresholdMs: number;
  hits: number;
  misses: number;
  nextTargetId: number;
  targetId: number;
  targetX: number;
  targetY: number;
  targetSpawnAt: number;
  /** Only the MPC's current target ever expires; support targets don't (they're
   *  a steady contribution channel, not a reaction test — see module doc). */
  targetExpiresAt: number;
  timeBudgetMs: number;
  startedAt: number;
  deadlineForChallenge: number;
  supportTarget: Record<string, SupportTarget>;
  supportHits: number;
  outcome: 'pending' | 'mpc_success' | 'total_failure';
}

const actionSchema = z.object({
  kind: z.literal('hit'),
  targetId: z.number().int().nonnegative(),
  elapsedMs: z.number().int().min(0).max(10_000),
});
type AimAction = z.infer<typeof actionSchema>;

const BASE_REQUIRED_HITS = 6;
const REQUIRED_HITS_STEP = 1;
const MAX_REQUIRED_HITS = 12;

const BASE_TARGET_LIFETIME_MS = 1200;
const TARGET_LIFETIME_STEP_MS = 60;
/** Long enough for a real click-on-a-visible-target action, unlike Reaction
 *  Test's much tighter pure-reflex floor. Tuned for the full-width desktop
 *  arena, where cursor travel between targets is real distance. */
const TARGET_LIFETIME_FLOOR_MS = 650;

/** Fixed rather than difficulty-scaled: the two knobs above already carry
 *  the difficulty curve. Tight enough that the fuse visibly burns — 6 hits
 *  at ~1.2s target lifetimes fits comfortably, but there's no idle slack. */
const TIME_BUDGET_MS = 12_000;

const SUPPORT_REDUCTION_PER_HIT = 1;
const REQUIRED_HITS_FLOOR_RATIO = 0.4;
const REQUIRED_HITS_FLOOR_MIN = 3;

/** Below this, a claimed elapsed time is physiologically implausible. */
const MIN_PLAUSIBLE_MS = 120;
/** A claimed elapsed time can never exceed how long the round trip actually
 *  took (target spawn -> client -> hit message -> server), plus jitter slack. */
const LATENCY_TOLERANCE_MS = 150;

/** Keeps a spawned target's box fully on-screen. */
const POSITION_MARGIN = 0.12;

function randomPos(random: () => number): { x: number; y: number } {
  return {
    x: POSITION_MARGIN + random() * (1 - 2 * POSITION_MARGIN),
    y: POSITION_MARGIN + random() * (1 - 2 * POSITION_MARGIN),
  };
}

function isPlausible(elapsedMs: number, spawnAt: number, now: number): boolean {
  if (elapsedMs < MIN_PLAUSIBLE_MS) return false;
  const arrivalDelta = now - spawnAt;
  return elapsedMs <= arrivalDelta + LATENCY_TOLERANCE_MS;
}

function requiredHitsFloor(initialRequiredHits: number): number {
  return Math.max(REQUIRED_HITS_FLOOR_MIN, Math.ceil(initialRequiredHits * REQUIRED_HITS_FLOOR_RATIO));
}

function asState(state: unknown): AimState {
  return state as AimState;
}

function spawnMpcTarget(s: AimState, ctx: MinigameContext): AimState {
  const pos = randomPos(ctx.random);
  return {
    ...s,
    nextTargetId: s.nextTargetId + 1,
    targetId: s.nextTargetId,
    targetX: pos.x,
    targetY: pos.y,
    targetSpawnAt: ctx.now,
    targetExpiresAt: ctx.now + s.hitThresholdMs,
  };
}

function spawnSupportTarget(s: AimState, playerId: string, ctx: MinigameContext): AimState {
  const pos = randomPos(ctx.random);
  return {
    ...s,
    nextTargetId: s.nextTargetId + 1,
    supportTarget: {
      ...s.supportTarget,
      [playerId]: { id: s.nextTargetId, x: pos.x, y: pos.y, spawnAt: ctx.now },
    },
  };
}

export const aimGame: Minigame = {
  id: 'aim',
  title: 'Aim Trainer',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): AimState {
    const requiredHits = Math.min(
      MAX_REQUIRED_HITS,
      BASE_REQUIRED_HITS + (config.difficulty - 1) * REQUIRED_HITS_STEP,
    );
    const hitThresholdMs = Math.max(
      TARGET_LIFETIME_FLOOR_MS,
      BASE_TARGET_LIFETIME_MS - (config.difficulty - 1) * TARGET_LIFETIME_STEP_MS,
    );

    let nextTargetId = 1;
    const supportTarget: Record<string, SupportTarget> = {};
    for (const id of config.supportIds) {
      const pos = randomPos(ctx.random);
      supportTarget[id] = { id: nextTargetId++, x: pos.x, y: pos.y, spawnAt: 0 };
    }
    const pos = randomPos(ctx.random);
    const targetId = nextTargetId++;

    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      requiredHits,
      initialRequiredHits: requiredHits,
      hitThresholdMs,
      hits: 0,
      misses: 0,
      nextTargetId,
      targetId,
      targetX: pos.x,
      targetY: pos.y,
      targetSpawnAt: 0,
      targetExpiresAt: 0,
      timeBudgetMs: TIME_BUDGET_MS,
      startedAt: 0,
      deadlineForChallenge: 0,
      supportTarget,
      supportHits: 0,
      outcome: 'pending',
    };
  },

  onStart(state: unknown, ctx: MinigameContext): AimState {
    const s = asState(state);
    const supportTarget: Record<string, SupportTarget> = {};
    for (const [id, t] of Object.entries(s.supportTarget)) {
      supportTarget[id] = { ...t, spawnAt: ctx.now };
    }
    return {
      ...s,
      startedAt: ctx.now,
      deadlineForChallenge: ctx.now + s.timeBudgetMs,
      targetSpawnAt: ctx.now,
      targetExpiresAt: ctx.now + s.hitThresholdMs,
      supportTarget,
    };
  },

  handleMpcAction(state: unknown, action: unknown, ctx: MinigameContext): AimState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const a = action as AimAction;
    if (a.targetId !== s.targetId) return s; // stale or wrong target
    if (!isPlausible(a.elapsedMs, s.targetSpawnAt, ctx.now)) return s; // implausible claim, ignore

    if (a.elapsedMs > s.hitThresholdMs) {
      // Valid claim, but too slow — the same as letting it expire.
      return spawnMpcTarget({ ...s, misses: s.misses + 1 }, ctx);
    }
    const hits = s.hits + 1;
    if (hits >= s.requiredHits) return { ...s, hits, outcome: 'mpc_success' };
    return spawnMpcTarget({ ...s, hits }, ctx);
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): AimState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const target = s.supportTarget[playerId];
    if (!target) return s; // not a support player this round
    const a = action as AimAction;
    if (a.targetId !== target.id) return s;
    if (!isPlausible(a.elapsedMs, target.spawnAt, ctx.now)) return s;

    const supportHits = s.supportHits + 1;
    const requiredHits = Math.max(requiredHitsFloor(s.initialRequiredHits), s.requiredHits - SUPPORT_REDUCTION_PER_HIT);
    const spawned = spawnSupportTarget({ ...s, supportHits, requiredHits }, playerId, ctx);
    // The lowered bar may already be met by the MPC's existing hit count —
    // a support hit can win the round outright, same as Typing Challenge.
    return spawned.hits >= requiredHits ? { ...spawned, outcome: 'mpc_success' } : spawned;
  },

  onDeadline(state: unknown, ctx: MinigameContext): AimState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    if (ctx.now >= s.deadlineForChallenge) return { ...s, outcome: 'total_failure' };
    if (ctx.now >= s.targetExpiresAt) return spawnMpcTarget({ ...s, misses: s.misses + 1 }, ctx);
    return s;
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    switch (s.outcome) {
      case 'mpc_success': {
        const assist = s.supportHits > 0 ? ` (${s.supportHits} team assist${s.supportHits === 1 ? '' : 's'})` : '';
        return { status: 'resolved', success: true, headline: `Bullseye! ${s.hits}/${s.requiredHits} hits${assist}.` };
      }
      case 'total_failure':
        return {
          status: 'resolved',
          success: false,
          headline: `Out of time — ${s.hits}/${s.requiredHits} hits (${s.misses} missed).`,
        };
      case 'pending':
        return { status: 'active' };
    }
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.outcome === 'pending' ? Math.min(s.targetExpiresAt, s.deadlineForChallenge) : null;
  },

  isDeadlineHidden(): boolean {
    // A short-lived target respawning constantly would otherwise make the
    // generic countdown jitter every ~1s; the UI shows hit/miss progress
    // instead (same reasoning Reaction Test uses).
    return true;
  },

  getFuse(state: unknown): { deadlineAt: number; totalMs: number } | null {
    // The per-target expiry is hidden (see above), but the overall 20s
    // budget is stable and fair game for pressure.
    const s = asState(state);
    return s.outcome === 'pending' ? { deadlineAt: s.deadlineForChallenge, totalMs: s.timeBudgetMs } : null;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const base = {
      role,
      hits: s.hits,
      requiredHits: s.requiredHits,
      misses: s.misses,
      supportHits: s.supportHits,
      hitThresholdMs: s.hitThresholdMs,
    };
    if (role === 'mpc') {
      return { ...base, targetId: s.targetId, targetX: s.targetX, targetY: s.targetY };
    }
    if (role === 'support') {
      const t = s.supportTarget[viewerId];
      return { ...base, targetId: t?.id ?? 0, targetX: t?.x ?? 0.5, targetY: t?.y ?? 0.5 };
    }
    return base;
  },
};
