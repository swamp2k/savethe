import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

/**
 * The Reaction Test. Design doc section 9's flow, with the latency-fair timing
 * from PLAN.md decision 3: the client measures its own elapsed time from the
 * moment it renders the "go" signal to the moment it clicks, and reports that
 * elapsed value; the server validates plausibility rather than trusting or
 * re-deriving it from message-arrival time (which would penalize laggy players).
 *
 * Flow: MPC arms the test (`ready`) -> a random delay elapses, hidden from the
 * client (`isDeadlineHidden`) so nobody can fire a click on a known schedule ->
 * the signal goes live (`mpc_go`) -> MPC clicks. Too slow, false-started, or
 * never armed at all -> the whole support team gets one shared, simultaneous
 * shot at an emergency rescue (`support_go`) with a fixed, tighter threshold;
 * first valid click under that threshold wins. Every attempt (successful or
 * not) is recorded for the round-resolution stat reveal (decision 8).
 */

type Stage = 'mpc_ready' | 'mpc_waiting' | 'mpc_go' | 'support_waiting' | 'support_go';
type Outcome = 'pending' | 'mpc_success' | 'team_rescue' | 'total_failure';

interface Attempt {
  elapsedMs: number;
  falseStart: boolean;
}

interface ReactionState {
  mpcId: string;
  supportIds: string[];
  mpcThresholdMs: number;
  supportThresholdMs: number;
  stage: Stage;
  /** Server time the current stage's signal went live; null while waiting. */
  signalAt: number | null;
  /** When the current stage should time out if nothing valid happens. */
  deadlineForStage: number;
  mpc: Attempt | null;
  supportResults: Record<string, Attempt>;
  savedBy: string | null;
  outcome: Outcome;
}

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('click'), elapsedMs: z.number().int().min(0).max(10_000) }),
]);
type ReactionAction = z.infer<typeof actionSchema>;

const BASE_MPC_THRESHOLD_MS = 250;
const MPC_THRESHOLD_STEP_MS = 10;
// Must stay comfortably above MIN_PLAUSIBLE_MS below, or the hardest
// difficulty tiers would require a reaction the server itself would reject
// as physiologically impossible — unwinnable by design. Reaches the floor at
// difficulty 5: 250, 240, 230, 220, 210.
const MPC_THRESHOLD_FLOOR_MS = 210;
const SUPPORT_THRESHOLD_MS = 350;

const READY_TIMEOUT_MS = 12_000;
const MIN_GO_DELAY_MS = 1_200;
const MAX_GO_DELAY_MS = 3_500;
/** Extra time the server waits past a threshold for a message to arrive
 *  before giving up on ever hearing back — not part of the pass/fail check. */
const STAGE_TRANSIT_BUFFER_MS = 200;

/** Below this, a claimed reaction time is physiologically implausible for a
 *  human and is treated as a no-op rather than rewarded. */
const MIN_PLAUSIBLE_MS = 120;
/** A claimed elapsed time can never exceed how long the round trip actually
 *  took (signal -> client -> click message -> server), plus slack for jitter. */
const LATENCY_TOLERANCE_MS = 150;

/**
 * Flat compensation subtracted from every plausibility-checked claim before
 * it's compared to a threshold or stored/displayed. Browsers have real,
 * unavoidable display/compositor latency between "the code applied the new
 * pixels" and "photons actually left the screen" that a lighter-weight
 * native reaction tester may not carry — this credits players for that
 * gap rather than pretending it doesn't exist. Plausibility itself (the
 * checks above) is still validated against the raw, uncompensated claim.
 */
const REACTION_LATENCY_COMPENSATION_MS = 100;

function compensate(elapsedMs: number): number {
  return Math.max(0, elapsedMs - REACTION_LATENCY_COMPENSATION_MS);
}

function asState(state: unknown): ReactionState {
  return state as ReactionState;
}

function goDelay(random: () => number): number {
  return MIN_GO_DELAY_MS + random() * (MAX_GO_DELAY_MS - MIN_GO_DELAY_MS);
}

function isPlausible(elapsedMs: number, signalAt: number, now: number): boolean {
  if (elapsedMs < MIN_PLAUSIBLE_MS) return false;
  const arrivalDelta = now - signalAt;
  return elapsedMs <= arrivalDelta + LATENCY_TOLERANCE_MS;
}

function startSupportWindow(state: ReactionState, ctx: MinigameContext): ReactionState {
  return {
    ...state,
    stage: 'support_waiting',
    signalAt: null,
    deadlineForStage: ctx.now + goDelay(ctx.random),
  };
}

export const reactionGame: Minigame = {
  id: 'reaction',
  title: 'Reaction Test',
  actionSchema,

  createInitialState(config: MinigameConfig): ReactionState {
    const mpcThresholdMs = Math.max(
      MPC_THRESHOLD_FLOOR_MS,
      BASE_MPC_THRESHOLD_MS - (config.difficulty - 1) * MPC_THRESHOLD_STEP_MS,
    );
    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      mpcThresholdMs,
      supportThresholdMs: SUPPORT_THRESHOLD_MS,
      stage: 'mpc_ready',
      signalAt: null,
      deadlineForStage: 0,
      mpc: null,
      supportResults: {},
      savedBy: null,
      outcome: 'pending',
    };
  },

  onStart(state: unknown, ctx: MinigameContext): ReactionState {
    const s = asState(state);
    return { ...s, deadlineForStage: ctx.now + READY_TIMEOUT_MS };
  },

  handleMpcAction(state: unknown, action: unknown, ctx: MinigameContext): ReactionState {
    const s = asState(state);
    const a = action as ReactionAction;

    if (a.kind === 'ready') {
      if (s.stage !== 'mpc_ready') return s;
      return { ...s, stage: 'mpc_waiting', signalAt: null, deadlineForStage: ctx.now + goDelay(ctx.random) };
    }

    // a.kind === 'click'
    if (s.stage === 'mpc_ready' || s.stage === 'mpc_waiting') {
      // Jumped the gun: a false start ends the MPC's turn immediately.
      return startSupportWindow({ ...s, mpc: { elapsedMs: 0, falseStart: true } }, ctx);
    }
    if (s.stage !== 'mpc_go') return s; // MPC's turn is already over

    if (!isPlausible(a.elapsedMs, s.signalAt!, ctx.now)) return s; // ignore implausible claim

    const elapsedMs = compensate(a.elapsedMs);
    const mpc: Attempt = { elapsedMs, falseStart: false };
    if (elapsedMs <= s.mpcThresholdMs) {
      return { ...s, mpc, outcome: 'mpc_success' };
    }
    return startSupportWindow({ ...s, mpc }, ctx);
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): ReactionState {
    const s = asState(state);
    const a = action as ReactionAction;
    if (a.kind !== 'click') return s;
    if (s.stage !== 'support_waiting' && s.stage !== 'support_go') return s;
    if (playerId in s.supportResults) return s; // one shot each

    if (s.stage === 'support_waiting') {
      // Jumped the gun: this player's shot is burned, but the race continues
      // for everyone else.
      return { ...s, supportResults: { ...s.supportResults, [playerId]: { elapsedMs: 0, falseStart: true } } };
    }

    if (!isPlausible(a.elapsedMs, s.signalAt!, ctx.now)) return s; // ignore implausible claim

    const elapsedMs = compensate(a.elapsedMs);
    const attempt: Attempt = { elapsedMs, falseStart: false };
    const supportResults = { ...s.supportResults, [playerId]: attempt };
    if (s.savedBy === null && elapsedMs <= s.supportThresholdMs) {
      return { ...s, supportResults, savedBy: playerId, outcome: 'team_rescue' };
    }
    return { ...s, supportResults };
  },

  onDeadline(state: unknown, ctx: MinigameContext): ReactionState {
    const s = asState(state);
    switch (s.stage) {
      case 'mpc_ready':
        // The MPC never even armed the test; treat as a forfeited turn.
        return startSupportWindow(s, ctx);
      case 'mpc_waiting':
        return { ...s, stage: 'mpc_go', signalAt: ctx.now, deadlineForStage: ctx.now + s.mpcThresholdMs + STAGE_TRANSIT_BUFFER_MS };
      case 'mpc_go':
        // Timed out waiting for a (valid) click: too slow.
        return startSupportWindow(s, ctx);
      case 'support_waiting':
        return {
          ...s,
          stage: 'support_go',
          signalAt: ctx.now,
          deadlineForStage: ctx.now + s.supportThresholdMs + STAGE_TRANSIT_BUFFER_MS,
        };
      case 'support_go':
        return s.outcome === 'pending' ? { ...s, outcome: 'total_failure' } : s;
    }
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    switch (s.outcome) {
      case 'mpc_success':
        return { status: 'resolved', success: true, headline: `Clean save! Reacted in ${s.mpc!.elapsedMs}ms.` };
      case 'team_rescue': {
        const rescue = s.supportResults[s.savedBy!];
        return {
          status: 'resolved',
          success: true,
          savedBy: s.savedBy!,
          headline: `Rescued with a ${rescue.elapsedMs}ms reaction!`,
        };
      }
      case 'total_failure': {
        const headline = s.mpc?.falseStart
          ? 'FALSE START — and nobody could save it in time.'
          : s.mpc === null
            ? 'Nobody even reacted in time.'
            : 'Too slow — the machine won.';
        return { status: 'resolved', success: false, headline };
      }
      case 'pending':
        return { status: 'active' };
    }
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.outcome === 'pending' ? s.deadlineForStage : null;
  },

  isDeadlineHidden(): boolean {
    // Every stage hides the generic numeric countdown, not just the two
    // secret-timing ones: a ticking number on the ready-gate (an AFK
    // safety net, unrelated to the actual random signal delay that follows
    // it) reads as "counting down to the test," which is misleading. The
    // client replaces it entirely with a state-driven visual signal instead.
    return true;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const canReady = role === 'mpc' && s.stage === 'mpc_ready';
    const canClick =
      (role === 'mpc' && (s.stage === 'mpc_waiting' || s.stage === 'mpc_go')) ||
      (role === 'support' &&
        (s.stage === 'support_waiting' || s.stage === 'support_go') &&
        !(viewerId in s.supportResults));
    return {
      role,
      stage: s.stage,
      canReady,
      canClick,
      mpcThresholdMs: s.mpcThresholdMs,
      supportThresholdMs: s.supportThresholdMs,
      mpc: s.mpc,
      supportResults: s.supportResults,
      savedBy: s.savedBy,
    };
  },
};
