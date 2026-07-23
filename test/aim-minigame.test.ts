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
    supportReduction: number;
    supportHitsPerReduction: number;
    maxSupportReduction: number;
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
    // difficulty 1 -> hitThresholdMs 1500; 1700ms is plausible but over threshold.
    const clicked = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 1700 }, ctx(1700));
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
    expect(easy.requiredHits).toBe(8);
    expect(easy.hitThresholdMs).toBe(1500);
    expect(hard.requiredHits).toBe(14); // capped
    expect(hard.hitThresholdMs).toBe(850); // floored
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
  function supportHit(s: unknown, playerId: 's1' | 's2', now: number) {
    const v = view(s, playerId);
    return aimGame.handleSupportAction(
      s,
      playerId,
      { kind: 'hit', targetId: v.targetId, elapsedMs: 200 },
      ctx(now),
    );
  }

  it('accumulates support hits and spawns a fresh target without one-for-one reduction', () => {
    let s = fresh();
    const firstTarget = view(s, 's1').targetId;
    s = supportHit(s, 's1', 200);
    const after = view(s, 'mpc');
    expect(after.requiredHits).toBe(8);
    expect(after.supportHits).toBe(1);
    expect(after.supportReduction).toBe(0);
    expect(view(s, 's1').targetId).not.toBe(firstTarget);
  });

  it('lowers the MPC requirement only after every four successful support hits', () => {
    let s = fresh();
    for (let i = 1; i <= 3; i++) {
      s = supportHit(s, i % 2 === 0 ? 's2' : 's1', i * 200);
      expect(view(s, 'mpc').requiredHits).toBe(8);
    }
    s = supportHit(s, 's2', 800);
    expect(view(s, 'mpc')).toMatchObject({
      supportHits: 4,
      supportReduction: 1,
      supportHitsPerReduction: 4,
      requiredHits: 7,
    });
  });

  it("support targets don't expire on their own — the MPC target's own expiry leaves them untouched", () => {
    const s = fresh();
    const v = view(s, 's1');
    const deadline = aimGame.getNextDeadline(s)!; // the MPC target's expiry
    const afterExpiry = aimGame.onDeadline(s, ctx(deadline));
    expect(view(afterExpiry, 's1').targetId).toBe(v.targetId);
  });

  it('a support milestone can win immediately when its lowered bar meets the MPC\'s existing hits', () => {
    let s = fresh();
    const required = view(s, 'mpc').requiredHits;
    for (let i = 0; i < required - 1; i++) {
      const v = view(s, 'mpc');
      s = aimGame.handleMpcAction(s, { kind: 'hit', targetId: v.targetId, elapsedMs: 200 }, ctx(200 * (i + 1)));
    }
    expect(view(s, 'mpc').hits).toBe(required - 1);

    for (let i = 1; i <= 3; i++) {
      s = supportHit(s, 's1', 10_000 + i * 200);
      expect(aimGame.evaluate(s, ctx(0))).toEqual({ status: 'active' });
    }
    s = supportHit(s, 's1', 10_800);
    expect(view(s, 'mpc')).toMatchObject({ hits: 7, requiredHits: 7, supportReduction: 1 });
    expect(aimGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('caps support reduction at two targets', () => {
    let s = fresh();
    for (let i = 1; i <= 12; i++) {
      s = supportHit(s, 's1', i * 200);
    }
    expect(view(s, 'mpc')).toMatchObject({
      supportHits: 12,
      supportReduction: 2,
      maxSupportReduction: 2,
      requiredHits: 6,
    });
  });

  it('support cannot trivialize the challenge even after many successful hits', () => {
    let s = fresh();
    for (let i = 1; i <= 40; i++) {
      s = supportHit(s, i % 2 === 0 ? 's2' : 's1', i * 200);
    }
    expect(view(s, 'mpc')).toMatchObject({ hits: 0, requiredHits: 6, supportReduction: 2 });
    expect(aimGame.evaluate(s, ctx(0))).toEqual({ status: 'active' });
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
