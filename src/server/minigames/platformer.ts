import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

/**
 * Platformer, reframed as a chain of quick-time obstacles: an obstacle
 * (something to jump over or duck under) approaches and the MPC must send
 * the matching response within a short window, repeated `requiredObstacles`
 * times. This is deliberately built as a sequence of Reaction Test's exact
 * mechanic — client-measured elapsed time, server-side plausibility check
 * (PLAN.md decision 3) — rather than any continuous position/velocity
 * model. A real running-and-jumping simulation would need the engine to
 * track continuous motion between messages, which nothing else in this
 * codebase does; a chain of discrete "the obstacle is here, react now" beats
 * stays exactly as message-driven as every other minigame while still
 * feeling like a platformer's core tension (reflexes + the right call).
 *
 * A wrong response OR a too-slow-but-valid one ends the round immediately —
 * you got hit. Only one deadline ever exists at a time (the current
 * obstacle's own window), which also doubles as the safety net: there's no
 * separate overall time budget, because running out the clock on any single
 * obstacle already ends the round.
 *
 * Support gets their own single, non-expiring obstacle (no plausibility
 * check either — same "support is never itself deadline-bound" rule Aim
 * Trainer/Memory/Tetris's support follows); a correct response immediately
 * lowers the MPC's requiredObstacles by one (floored), Aim Trainer's
 * "every hit counts" shape rather than Typing/Memory/Tetris's
 * "complete a small sequence first" shape — a wrong response is free to
 * retry, no penalty.
 */

type ObstacleType = 'jump' | 'duck';

interface PlatformerState {
  mpcId: string;
  supportIds: string[];
  /** The bar support can lower; never below `requiredObstaclesFloor(initialRequiredObstacles)`. */
  requiredObstacles: number;
  initialRequiredObstacles: number;
  obstacleWindowMs: number;
  obstaclesCleared: number;
  nextObstacleId: number;
  /** Consecutive obstacles can share the same type (jump twice in a row is
   *  valid), so the client needs a per-spawn id — not the type — to reliably
   *  detect "a new one arrived" and reset its elapsed-time clock. */
  obstacleId: number;
  obstacleType: ObstacleType;
  obstacleSpawnAt: number;
  obstacleDeadlineAt: number;
  supportObstacle: Record<string, ObstacleType>;
  supportClears: number;
  outcome: 'pending' | 'mpc_success' | 'hit_obstacle' | 'timeout';
}

const actionSchema = z.object({
  kind: z.literal('react'),
  response: z.enum(['jump', 'duck']),
  elapsedMs: z.number().int().min(0).max(10_000),
});
type PlatformerAction = z.infer<typeof actionSchema>;

const BASE_OBSTACLES = 5;
const OBSTACLES_STEP = 1;
const MAX_OBSTACLES = 10;

// Choice-reaction scale, not pure-reflex scale: the MPC has to read WHICH
// obstacle arrived (jump vs duck) and pick the matching button, which takes
// humans roughly 500-700ms before any device latency. The original 700ms
// base window made round one nearly unwinnable.
const BASE_WINDOW_MS = 1800;
const WINDOW_STEP_MS = 75;
const MIN_WINDOW_MS = 1100;

/** Extra server-side slack past the window before declaring a timeout. The
 *  pass/fail check is the client-measured `elapsedMs` vs the window (PLAN.md
 *  decision 3); this buffer only covers transit both ways (state broadcast to
 *  the client + the react message back) plus alarm jitter, so a laggy
 *  connection can't spend the player's window for them. Without it, the
 *  deadline used to fire `window` ms after the SERVER spawned the obstacle —
 *  often before the player had even seen it. */
const DEADLINE_TRANSIT_BUFFER_MS = 800;

const REQUIRED_OBSTACLES_FLOOR_RATIO = 0.4;
const REQUIRED_OBSTACLES_FLOOR_MIN = 3;

/** Below this, a claimed elapsed time is physiologically implausible. */
const MIN_PLAUSIBLE_MS = 120;
/** A claimed elapsed time can never exceed how long the round trip actually
 *  took (obstacle spawn -> client -> react message -> server), plus jitter slack. */
const LATENCY_TOLERANCE_MS = 150;

function randomObstacleType(random: () => number): ObstacleType {
  return random() < 0.5 ? 'jump' : 'duck';
}

function isPlausible(elapsedMs: number, spawnAt: number, now: number): boolean {
  if (elapsedMs < MIN_PLAUSIBLE_MS) return false;
  const arrivalDelta = now - spawnAt;
  return elapsedMs <= arrivalDelta + LATENCY_TOLERANCE_MS;
}

function requiredObstaclesFloor(initialRequiredObstacles: number): number {
  return Math.max(REQUIRED_OBSTACLES_FLOOR_MIN, Math.ceil(initialRequiredObstacles * REQUIRED_OBSTACLES_FLOOR_RATIO));
}

function asState(state: unknown): PlatformerState {
  return state as PlatformerState;
}

export const platformerGame: Minigame = {
  id: 'platformer',
  title: 'Obstacle Run',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): PlatformerState {
    const requiredObstacles = Math.min(
      MAX_OBSTACLES,
      BASE_OBSTACLES + (config.difficulty - 1) * OBSTACLES_STEP,
    );
    const obstacleWindowMs = Math.max(MIN_WINDOW_MS, BASE_WINDOW_MS - (config.difficulty - 1) * WINDOW_STEP_MS);

    const supportObstacle: Record<string, ObstacleType> = {};
    for (const id of config.supportIds) supportObstacle[id] = randomObstacleType(ctx.random);

    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      requiredObstacles,
      initialRequiredObstacles: requiredObstacles,
      obstacleWindowMs,
      obstaclesCleared: 0,
      nextObstacleId: 1,
      obstacleId: 0,
      obstacleType: randomObstacleType(ctx.random),
      obstacleSpawnAt: 0,
      obstacleDeadlineAt: 0,
      supportObstacle,
      supportClears: 0,
      outcome: 'pending',
    };
  },

  onStart(state: unknown, ctx: MinigameContext): PlatformerState {
    const s = asState(state);
    return {
      ...s,
      obstacleId: s.nextObstacleId,
      nextObstacleId: s.nextObstacleId + 1,
      obstacleSpawnAt: ctx.now,
      obstacleDeadlineAt: ctx.now + s.obstacleWindowMs + DEADLINE_TRANSIT_BUFFER_MS,
    };
  },

  handleMpcAction(state: unknown, action: unknown, ctx: MinigameContext): PlatformerState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const a = action as PlatformerAction;
    if (!isPlausible(a.elapsedMs, s.obstacleSpawnAt, ctx.now)) return s; // implausible claim, ignore

    if (a.response !== s.obstacleType) {
      return { ...s, outcome: 'hit_obstacle' }; // wrong call: jumped when you should've ducked, or vice versa
    }
    if (a.elapsedMs > s.obstacleWindowMs) {
      return { ...s, outcome: 'hit_obstacle' }; // right call, too slow
    }

    const obstaclesCleared = s.obstaclesCleared + 1;
    if (obstaclesCleared >= s.requiredObstacles) {
      return { ...s, obstaclesCleared, outcome: 'mpc_success' };
    }
    return {
      ...s,
      obstaclesCleared,
      obstacleId: s.nextObstacleId,
      nextObstacleId: s.nextObstacleId + 1,
      obstacleType: randomObstacleType(ctx.random),
      obstacleSpawnAt: ctx.now,
      obstacleDeadlineAt: ctx.now + s.obstacleWindowMs + DEADLINE_TRANSIT_BUFFER_MS,
    };
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): PlatformerState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const myType = s.supportObstacle[playerId];
    if (myType === undefined) return s; // not a support player this round
    const a = action as PlatformerAction;
    if (a.response !== myType) return s; // wrong call: free to try again, no penalty

    const requiredObstacles = Math.max(
      requiredObstaclesFloor(s.initialRequiredObstacles),
      s.requiredObstacles - 1,
    );
    const next: PlatformerState = {
      ...s,
      supportObstacle: { ...s.supportObstacle, [playerId]: randomObstacleType(ctx.random) },
      requiredObstacles,
      supportClears: s.supportClears + 1,
    };
    // The lowered bar may already be met by the MPC's existing progress.
    return next.obstaclesCleared >= requiredObstacles ? { ...next, outcome: 'mpc_success' } : next;
  },

  onDeadline(state: unknown, ctx: MinigameContext): PlatformerState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    if (ctx.now >= s.obstacleDeadlineAt) return { ...s, outcome: 'timeout' };
    return s;
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    switch (s.outcome) {
      case 'mpc_success': {
        const assist = s.supportClears > 0 ? ` (${s.supportClears} team assist${s.supportClears === 1 ? '' : 's'})` : '';
        return {
          status: 'resolved',
          success: true,
          headline: `Made it through! ${s.obstaclesCleared}/${s.requiredObstacles} obstacles${assist}.`,
        };
      }
      case 'hit_obstacle':
        return {
          status: 'resolved',
          success: false,
          headline: `Ouch! Hit an obstacle at ${s.obstaclesCleared}/${s.requiredObstacles}.`,
        };
      case 'timeout':
        return {
          status: 'resolved',
          success: false,
          headline: `Too slow — hit at ${s.obstaclesCleared}/${s.requiredObstacles}.`,
        };
      case 'pending':
        return { status: 'active' };
    }
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.outcome === 'pending' ? s.obstacleDeadlineAt : null;
  },

  isDeadlineHidden(): boolean {
    // A ~400-700ms obstacle window respawning repeatedly would make the
    // generic countdown jitter; the UI shows an obstacle-approach animation
    // instead (same reasoning Aim Trainer uses).
    return true;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const base = {
      role,
      obstaclesCleared: s.obstaclesCleared,
      requiredObstacles: s.requiredObstacles,
      obstacleWindowMs: s.obstacleWindowMs,
      supportClears: s.supportClears,
    };
    if (role === 'mpc') return { ...base, obstacleId: s.obstacleId, obstacleType: s.obstacleType };
    if (role === 'support') return { ...base, myObstacleType: s.supportObstacle[viewerId] };
    return base;
  },
};
