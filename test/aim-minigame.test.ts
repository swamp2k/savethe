import { describe, expect, it } from 'vitest';
import { aimGame } from '../src/server/minigames/aim';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] };
function ctx(now: number, random = 0): MinigameContext {
  return { now, random: () => random };
}

/** Fresh state, started at t=0 (arms the first target for the MPC and every
 *  support player). */
function fresh() {
  return aimGame.onStart(aimGame.createInitialState(config, ctx(0)), ctx(0));
}

function view(s: unknown, viewerId: string) {
  return aimGame.getStateForPlayer(s, viewerId) as {
    role: string;
    hits: number;
    requiredHits: number;
    misses: number;
    supportHits: number;
    hitThresholdMs: number;
    targetId?: number;
    targetX?: number;
    targetY?: number;
  };
}

describe('aim trainer: action schema', () => {
  it('accepts a well-formed hit', () => {
    expect(aimGame.actionSchema.safeParse({ kind: 'hit', targetId: 1, elapsedMs: 300 }).success).toBe(true);
  });

  it('rejects malformed hits', () => {
    expect(aimGame.actionSchema.safeParse({ kind: 'hit', targetId: 1 }).success).toBe(false);
    expect(aimGame.actionSchema.safeParse({ kind: 'hit', targetId: -1, elapsedMs: 300 }).success).toBe(false);
    expect(aimGame.actionSchema.safeParse({ kind: 'hit', targetId: 1.5, elapsedMs: 300 }).success).toBe(false);
    expect(aimGame.actionSchema.safeParse({ kind: 'hit', targetId: 1, elapsedMs: -1 }).success).toBe(false);
    expect(aimGame.actionSchema.safeParse({ kind: 'hit', targetId: 1, elapsedMs: 999_999 }).success).toBe(false);
    expect(aimGame.actionSchema.safeParse({ kind: 'explode' }).success).toBe(false);
  });
});

describe('aim trainer: MPC hits', () => {
  it('a plausible, fast-enough click registers a hit and spawns a fresh target', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const hit = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 200 }, ctx(200));
    const hv = view(hit, 'mpc');
    expect(hv.hits).toBe(1);
    expect(hv.targetId).not.toBe(v.targetId);
  });

  it('reaching requiredHits resolves the round as a success', () => {
    let s = fresh();
    const required = view(s, 'mpc').requiredHits;
    for (let i = 0; i < required; i++) {
      const v = view(s, 'mpc');
      s = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 200 }, ctx(200 * (i + 1)));
    }
    expect(aimGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
    expect(view(s, 'mpc').hits).toBe(required);
  });

  it('ignores a click on the wrong (stale) target id', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const clicked = aimGame.handleMpcAction(
      s,
      { kind: 'hit', targetId: (v.targetId ?? 0) + 999, elapsedMs: 200 },
      ctx(200),
    );
    expect(clicked).toBe(s);
  });

  it('ignores an implausibly fast claimed hit (below the human floor)', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const clicked = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 50 }, ctx(50));
    expect(view(clicked, 'mpc').hits).toBe(0);
    expect(view(clicked, 'mpc').targetId).toBe(v.targetId); // unchanged; ignored
  });

  it('ignores a claim inconsistent with how quickly the message actually arrived', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    // Claims a 900ms elapsed, but the message arrived only 50ms after spawn.
    const clicked = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 900 }, ctx(50));
    expect(view(clicked, 'mpc').targetId).toBe(v.targetId); // unchanged; ignored
  });

  it('a plausible but too-slow click counts as a miss and still spawns a fresh target', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    // difficulty 1 -> hitThresholdMs 1000; 1200ms is plausible but over threshold.
    const clicked = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 1200 }, ctx(1200));
    const cv = view(clicked, 'mpc');
    expect(cv.hits).toBe(0);
    expect(cv.misses).toBe(1);
    expect(cv.targetId).not.toBe(v.targetId);
    expect(aimGame.evaluate(clicked, ctx(0))).toEqual({ status: 'active' });
  });

  it('scales requiredHits up and hitThresholdMs down with difficulty, both bounded', () => {
    const easy = aimGame.createInitialState({ ...config, difficulty: 1 }, ctx(0)) as {
      requiredHits: number;
      hitThresholdMs: number;
    };
    const hard = aimGame.createInitialState({ ...config, difficulty: 20 }, ctx(0)) as {
      requiredHits: number;
      hitThresholdMs: number;
    };
    expect(easy.requiredHits).toBe(6);
    expect(easy.hitThresholdMs).toBe(1000);
    expect(hard.requiredHits).toBe(12); // capped
    expect(hard.hitThresholdMs).toBe(550); // floored
  });
});

describe('aim trainer: expiry', () => {
  it('an unclicked target expiring counts as a miss and spawns a fresh one', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const deadline = aimGame.getNextDeadline(s)!;
    const expired = aimGame.onDeadline(s, ctx(deadline));
    const ev = view(expired, 'mpc');
    expect(ev.misses).toBe(1);
    expect(ev.hits).toBe(0);
    expect(ev.targetId).not.toBe(v.targetId);
    expect(aimGame.evaluate(expired, ctx(0))).toEqual({ status: 'active' });
  });

  it('the overall time budget expiring fails the round even if the current target has not', () => {
    const s = fresh();
    const failed = aimGame.onDeadline(s, ctx(1_000_000));
    expect(aimGame.evaluate(failed, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });
});

describe('aim trainer: support', () => {
  it('a support hit lowers requiredHits and spawns a fresh target for that player', () => {
    const s = fresh();
    const v = view(s, 's1');
    const before = view(s, 'mpc').requiredHits;
    const hit = aimGame.handleSupportAction(s, 's1', { kind: 'hit', targetId: v.targetId, elapsedMs: 200 }, ctx(200));
    const after = view(hit, 'mpc');
    expect(after.requiredHits).toBe(before - 1);
    expect(after.supportHits).toBe(1);
    expect(view(hit, 's1').targetId).not.toBe(v.targetId);
  });

  it("support targets don't expire on their own — the MPC target's own expiry leaves them untouched", () => {
    const s = fresh();
    const v = view(s, 's1');
    const deadline = aimGame.getNextDeadline(s)!; // the MPC target's expiry
    const afterExpiry = aimGame.onDeadline(s, ctx(deadline));
    expect(view(afterExpiry, 's1').targetId).toBe(v.targetId);
  });

  it('a support hit can win the round outright if the lowered bar meets the MPC\'s existing hits', () => {
    let s = fresh();
    const required = view(s, 'mpc').requiredHits;
    for (let i = 0; i < required - 1; i++) {
      const v = view(s, 'mpc');
      s = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 200 }, ctx(200 * (i + 1)));
    }
    expect(view(s, 'mpc').hits).toBe(required - 1);

    const sv = view(s, 's1');
    const rescued = aimGame.handleSupportAction(
      s,
      's1',
      { kind: 'hit', targetId: sv.targetId, elapsedMs: 200 },
      ctx(50_000),
    );
    expect(aimGame.evaluate(rescued, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('never lowers requiredHits below the floor', () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) {
      const v = view(s, 's1');
      s = aimGame.handleSupportAction(s, 's1', { kind: 'hit', targetId: v.targetId, elapsedMs: 200 }, ctx(200 * (i + 1)));
    }
    // difficulty 1 -> initial requiredHits 6; floor = max(3, ceil(6 * 0.4)) = 3.
    expect(view(s, 'mpc').requiredHits).toBe(3);
    expect(aimGame.evaluate(s, ctx(0))).toEqual({ status: 'active' }); // MPC still has 0 hits < 3
  });

  it('ignores an action from a player who is not on the support roster this round', () => {
    const s = fresh();
    const clicked = aimGame.handleSupportAction(s, 'ghost', { kind: 'hit', targetId: 1, elapsedMs: 200 }, ctx(200));
    expect(clicked).toBe(s);
  });
});

describe('aim trainer: per-player projection', () => {
  it('assigns roles correctly', () => {
    const s = fresh();
    expect(view(s, 'mpc').role).toBe('mpc');
    expect(view(s, 's1').role).toBe('support');
    expect(view(s, 'ghost').role).toBe('spectator');
  });

  it('gives a spectator no target to click', () => {
    const s = fresh();
    expect(view(s, 'ghost').targetId).toBeUndefined();
  });

  it('does not expose internal timing fields to any viewer', () => {
    const s = fresh();
    const projected = aimGame.getStateForPlayer(s, 'mpc') as Record<string, unknown>;
    expect(projected.targetSpawnAt).toBeUndefined();
    expect(projected.targetExpiresAt).toBeUndefined();
    expect(projected.deadlineForChallenge).toBeUndefined();
    expect(projected.startedAt).toBeUndefined();
  });
});

describe('aim trainer: hidden countdown', () => {
  it('always hides the generic countdown during the challenge', () => {
    const s = fresh();
    expect(aimGame.isDeadlineHidden!(s)).toBe(true);
  });
});
