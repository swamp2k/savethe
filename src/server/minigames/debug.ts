import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

/**
 * A deliberately trivial minigame used to build and prove the round engine
 * before any real skill challenge exists (M2). It still exercises the whole
 * contract and all three round outcomes:
 *   - MPC presses SAVE            -> clean victory
 *   - MPC presses DOOM, support presses RESCUE -> team rescue
 *   - nobody saves before time    -> total failure
 */

interface DebugState {
  mpcId: string;
  supportIds: string[];
  durationMs: number;
  endsAt: number;
  mpcChoice: 'none' | 'save' | 'doom';
  rescuedBy: string | null;
}

const actionSchema = z.object({ kind: z.enum(['save', 'doom', 'rescue']) });
type DebugAction = z.infer<typeof actionSchema>;

const BASE_DURATION_MS = 15_000;
const MIN_DURATION_MS = 6_000;

function asState(state: unknown): DebugState {
  return state as DebugState;
}

export const debugGame: Minigame = {
  id: 'debug',
  title: 'The Big Red Button',
  actionSchema,

  createInitialState(config: MinigameConfig): DebugState {
    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      durationMs: Math.max(MIN_DURATION_MS, BASE_DURATION_MS - (config.difficulty - 1) * 1_500),
      endsAt: 0,
      mpcChoice: 'none',
      rescuedBy: null,
    };
  },

  onStart(state: unknown, ctx: MinigameContext): DebugState {
    const s = asState(state);
    return { ...s, endsAt: ctx.now + s.durationMs };
  },

  handleMpcAction(state: unknown, action: unknown): DebugState {
    const s = asState(state);
    const a = action as DebugAction;
    if (s.mpcChoice !== 'none') return s; // locked after first press
    if (a.kind === 'save' || a.kind === 'doom') return { ...s, mpcChoice: a.kind };
    return s;
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown): DebugState {
    const s = asState(state);
    const a = action as DebugAction;
    if (a.kind === 'rescue' && s.rescuedBy === null) return { ...s, rescuedBy: playerId };
    return s;
  },

  onDeadline(state: unknown): DebugState {
    return asState(state);
  },

  evaluate(state: unknown, ctx: MinigameContext): MinigameOutcome {
    const s = asState(state);
    // A clean save resolves instantly. Otherwise the round stays live so a
    // support player can still rescue, right up until the deadline.
    if (s.mpcChoice === 'save') {
      return { status: 'resolved', success: true, headline: 'Clean save — the MPC hit the button!' };
    }
    if (s.rescuedBy !== null) {
      return { status: 'resolved', success: true, headline: 'Rescued at the last second!', savedBy: s.rescuedBy };
    }
    if (s.endsAt > 0 && ctx.now >= s.endsAt) {
      const headline =
        s.mpcChoice === 'doom'
          ? 'The MPC pressed DOOM and nobody caught it.'
          : 'Time ran out. The machine wins.';
      return { status: 'resolved', success: false, headline };
    }
    return { status: 'active' };
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.endsAt > 0 ? s.endsAt : null;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const canAct =
      role === 'mpc' && s.mpcChoice === 'none'
        ? ['save', 'doom']
        : role === 'support' && s.rescuedBy === null
          ? ['rescue']
          : [];
    return {
      role,
      canAct,
      mpcChoice: s.mpcChoice,
      rescuedBy: s.rescuedBy,
      endsAt: s.endsAt,
    };
  },
};
