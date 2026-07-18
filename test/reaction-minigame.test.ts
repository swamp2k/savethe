import { describe, expect, it } from 'vitest';
import { reactionGame } from '../src/server/minigames/reaction';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] };
function ctx(now: number, random = 0): MinigameContext {
  return { now, random: () => random };
}

/** Fresh state, started at t=0 (arms the READY-gate deadline). */
function fresh() {
  return reactionGame.onStart(reactionGame.createInitialState(config, ctx(0)), ctx(0));
}

/** Advance from mpc_ready through 'ready' and the hidden pre-signal delay, up
 *  to the moment the go signal fires. Returns [state, signalAt]. */
function toMpcGo(random = 0): [unknown, number] {
  let s = reactionGame.handleMpcAction(fresh(), { kind: 'ready' }, ctx(100, random));
  const deadline = reactionGame.getNextDeadline(s)!;
  s = reactionGame.onDeadline(s, ctx(deadline, random));
  return [s, deadline];
}

function view(s: unknown, viewerId: string) {
  return reactionGame.getStateForPlayer(s, viewerId) as {
    role: string;
    stage: string;
    canReady: boolean;
    canClick: boolean;
    mpcThresholdMs: number;
    supportThresholdMs: number;
  };
}

describe('reaction test: action schema', () => {
  it('accepts ready and well-formed clicks', () => {
    expect(reactionGame.actionSchema.safeParse({ kind: 'ready' }).success).toBe(true);
    expect(reactionGame.actionSchema.safeParse({ kind: 'click', elapsedMs: 250 }).success).toBe(true);
  });

  it('rejects malformed clicks', () => {
    expect(reactionGame.actionSchema.safeParse({ kind: 'click' }).success).toBe(false);
    expect(reactionGame.actionSchema.safeParse({ kind: 'click', elapsedMs: -1 }).success).toBe(false);
    expect(reactionGame.actionSchema.safeParse({ kind: 'click', elapsedMs: 1.5 }).success).toBe(false);
    expect(reactionGame.actionSchema.safeParse({ kind: 'click', elapsedMs: 999_999 }).success).toBe(false);
    expect(reactionGame.actionSchema.safeParse({ kind: 'explode' }).success).toBe(false);
  });
});

describe('reaction test: arming and the go signal', () => {
  it('starts in mpc_ready, hidden deadline off (the ready-gate itself is not a secret)', () => {
    const s = fresh();
    expect(view(s, 'mpc').stage).toBe('mpc_ready');
    expect(view(s, 'mpc').canReady).toBe(true);
    expect(reactionGame.isDeadlineHidden!(s)).toBe(false);
  });

  it('hides the deadline while armed and waiting for the signal', () => {
    const s = reactionGame.handleMpcAction(fresh(), { kind: 'ready' }, ctx(100));
    expect(view(s, 'mpc').stage).toBe('mpc_waiting');
    expect(reactionGame.isDeadlineHidden!(s)).toBe(true);
  });

  it('flips to mpc_go (deadline visible again) once the hidden delay elapses', () => {
    const [s] = toMpcGo();
    expect(view(s, 'mpc').stage).toBe('mpc_go');
    expect(view(s, 'mpc').canClick).toBe(true);
    expect(reactionGame.isDeadlineHidden!(s)).toBe(false);
  });

  it('never arms without an explicit ready (ignores a stray ready in mpc_waiting)', () => {
    let s = reactionGame.handleMpcAction(fresh(), { kind: 'ready' }, ctx(100));
    const before = s;
    s = reactionGame.handleMpcAction(s, { kind: 'ready' }, ctx(150));
    expect(s).toBe(before);
  });
});

describe('reaction test: MPC outcomes', () => {
  it('clean success on a fast, plausible click', () => {
    const [s, signalAt] = toMpcGo();
    const clickAt = signalAt + 200; // arrivalDelta = 200, matches the claim exactly
    const clicked = reactionGame.handleMpcAction(s, { kind: 'click', elapsedMs: 200 }, ctx(clickAt));
    expect(reactionGame.evaluate(clicked, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('a false start (click before the signal) ends the MPC turn and opens the support window', () => {
    let s = reactionGame.handleMpcAction(fresh(), { kind: 'ready' }, ctx(100));
    s = reactionGame.handleMpcAction(s, { kind: 'click', elapsedMs: 9999 }, ctx(150));
    expect(view(s, 'mpc').stage).toBe('support_waiting');
    expect(reactionGame.evaluate(s, ctx(0))).toEqual({ status: 'active' });
  });

  it('clicking before even pressing ready is also a false start', () => {
    const s = reactionGame.handleMpcAction(fresh(), { kind: 'click', elapsedMs: 300 }, ctx(50));
    expect(view(s, 'mpc').stage).toBe('support_waiting');
  });

  it('a too-slow but valid click opens the support window instead of instant failure', () => {
    const [s, signalAt] = toMpcGo();
    const clicked = reactionGame.handleMpcAction(s, { kind: 'click', elapsedMs: 900 }, ctx(signalAt + 900));
    expect(view(clicked, 'mpc').stage).toBe('support_waiting');
    expect(reactionGame.evaluate(clicked, ctx(0))).toEqual({ status: 'active' });
  });

  it('never pressing ready eventually forfeits the MPC turn to the AFK timeout', () => {
    const s = fresh();
    const deadline = reactionGame.getNextDeadline(s)!;
    const timedOut = reactionGame.onDeadline(s, ctx(deadline));
    expect(view(timedOut, 'mpc').stage).toBe('support_waiting');
  });

  it('ignores an implausibly fast claimed reaction (below human floor)', () => {
    const [s, signalAt] = toMpcGo();
    const clicked = reactionGame.handleMpcAction(s, { kind: 'click', elapsedMs: 10 }, ctx(signalAt + 10));
    expect(view(clicked, 'mpc').stage).toBe('mpc_go'); // unchanged; click was ignored
  });

  it('ignores a claim inconsistent with how quickly the message actually arrived', () => {
    const [s, signalAt] = toMpcGo();
    // Claims a 900ms reaction, but the message arrived only 50ms after the signal.
    const clicked = reactionGame.handleMpcAction(s, { kind: 'click', elapsedMs: 900 }, ctx(signalAt + 50));
    expect(view(clicked, 'mpc').stage).toBe('mpc_go'); // unchanged; implausible
  });

  it('scales the MPC threshold down with difficulty, with a floor', () => {
    const easy = reactionGame.createInitialState({ ...config, difficulty: 1 }, ctx(0)) as { mpcThresholdMs: number };
    const hard = reactionGame.createInitialState({ ...config, difficulty: 10 }, ctx(0)) as { mpcThresholdMs: number };
    expect(easy.mpcThresholdMs).toBe(250);
    expect(hard.mpcThresholdMs).toBe(150); // floor
  });
});

describe('reaction test: support rescue', () => {
  function toSupportGo(): [unknown, number] {
    const [afterMpcFail] = toMpcGo();
    const failed = reactionGame.handleMpcAction(afterMpcFail, { kind: 'click', elapsedMs: 999 }, ctx(50_000));
    const deadline = reactionGame.getNextDeadline(failed)!;
    const gone = reactionGame.onDeadline(failed, ctx(deadline));
    return [gone, deadline];
  }

  it('a support player rescues within the fixed threshold', () => {
    const [s, signalAt] = toSupportGo();
    const rescued = reactionGame.handleSupportAction(s, 's1', { kind: 'click', elapsedMs: 200 }, ctx(signalAt + 200));
    expect(reactionGame.evaluate(rescued, ctx(0))).toMatchObject({ status: 'resolved', success: true, savedBy: 's1' });
  });

  it('first valid rescuer wins even if a second support player also beats the threshold', () => {
    const [s, signalAt] = toSupportGo();
    let next = reactionGame.handleSupportAction(s, 's1', { kind: 'click', elapsedMs: 200 }, ctx(signalAt + 200));
    next = reactionGame.handleSupportAction(next, 's2', { kind: 'click', elapsedMs: 150 }, ctx(signalAt + 250));
    expect(reactionGame.evaluate(next, ctx(0))).toMatchObject({ savedBy: 's1' });
  });

  it("a support false start only burns that player's own attempt", () => {
    const [afterMpcFail] = toMpcGo();
    const failed = reactionGame.handleMpcAction(afterMpcFail, { kind: 'click', elapsedMs: 999 }, ctx(50_000));
    // s1 jumps the gun while still in support_waiting.
    const burned = reactionGame.handleSupportAction(failed, 's1', { kind: 'click', elapsedMs: 10 }, ctx(50_100));
    const deadline = reactionGame.getNextDeadline(burned)!;
    const live = reactionGame.onDeadline(burned, ctx(deadline));
    // s1 already used their shot; s2 can still rescue.
    expect(view(live, 's1').canClick).toBe(false);
    expect(view(live, 's2').canClick).toBe(true);
    const rescued = reactionGame.handleSupportAction(live, 's2', { kind: 'click', elapsedMs: 200 }, ctx(deadline + 200));
    expect(reactionGame.evaluate(rescued, ctx(0))).toMatchObject({ success: true, savedBy: 's2' });
  });

  it('one shot per support player: a second attempt from the same player is ignored', () => {
    const [s, signalAt] = toSupportGo();
    let next = reactionGame.handleSupportAction(s, 's1', { kind: 'click', elapsedMs: 900 }, ctx(signalAt + 900)); // too slow
    const before = next;
    next = reactionGame.handleSupportAction(next, 's1', { kind: 'click', elapsedMs: 100 }, ctx(signalAt + 950));
    expect(next).toBe(before);
  });

  it('total failure when the support window times out with nobody under threshold', () => {
    const [s, signalAt] = toSupportGo();
    const missed = reactionGame.handleSupportAction(s, 's1', { kind: 'click', elapsedMs: 900 }, ctx(signalAt + 900));
    const deadline = reactionGame.getNextDeadline(missed)!;
    const done = reactionGame.onDeadline(missed, ctx(deadline));
    expect(reactionGame.evaluate(done, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });
});

describe('reaction test: per-player projection', () => {
  it('assigns roles correctly and never reveals a click affordance to spectators', () => {
    const s = fresh();
    expect(view(s, 'mpc').role).toBe('mpc');
    expect(view(s, 's1').role).toBe('support');
    expect(view(s, 'ghost').role).toBe('spectator');
    expect(view(s, 'ghost').canReady).toBe(false);
    expect(view(s, 'ghost').canClick).toBe(false);
  });

  it('does not offer support a click affordance during the MPC phase', () => {
    const s = fresh();
    expect(view(s, 's1').canClick).toBe(false);
  });

  it('does not expose signalAt or the internal deadline timestamp to any viewer', () => {
    const [s] = toMpcGo();
    const projected = reactionGame.getStateForPlayer(s, 'mpc') as Record<string, unknown>;
    expect(projected.signalAt).toBeUndefined();
    expect(projected.deadlineForStage).toBeUndefined();
  });
});
