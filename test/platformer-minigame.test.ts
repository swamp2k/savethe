import { describe, expect, it } from 'vitest';
import { platformerGame } from '../src/server/minigames/platformer';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] };
function ctx(now: number, random = 0): MinigameContext {
  return { now, random: () => random };
}

/** Fresh state, started at t=0. With random=0, every obstacle (the MPC's
 *  and every support player's) is deterministically 'jump'. */
function fresh() {
  return platformerGame.onStart(platformerGame.createInitialState(config, ctx(0)), ctx(0));
}

function view(s: unknown, viewerId: string) {
  return platformerGame.getStateForPlayer(s, viewerId) as {
    role: string;
    obstaclesCleared: number;
    requiredObstacles: number;
    obstacleWindowMs: number;
    supportClears: number;
    obstacleId?: number;
    obstacleType?: 'jump' | 'duck';
    myObstacleType?: 'jump' | 'duck';
  };
}

const RIGHT: 'jump' | 'duck' = 'jump'; // what random=0 always produces
const WRONG: 'jump' | 'duck' = 'duck';

describe('platformer: action schema', () => {
  it('accepts a well-formed react', () => {
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', response: 'jump', elapsedMs: 300 }).success).toBe(true);
  });

  it('rejects malformed actions', () => {
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', response: 'fly', elapsedMs: 300 }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', response: 'jump' }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', response: 'jump', elapsedMs: -1 }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'explode' }).success).toBe(false);
  });
});

describe('platformer: MPC reactions', () => {
  it('a plausible, correct, fast-enough response clears the obstacle and spawns a new one', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const cleared = platformerGame.handleMpcAction(s, { kind: 'react', response: RIGHT, elapsedMs: 200 }, ctx(200));
    const cv = view(cleared, 'mpc');
    expect(cv.obstaclesCleared).toBe(1);
    expect(cv.obstacleId).not.toBe(v.obstacleId);
  });

  it('reaching requiredObstacles resolves the round as a success', () => {
    let s = fresh();
    const required = view(s, 'mpc').requiredObstacles;
    for (let i = 0; i < required; i++) {
      s = platformerGame.handleMpcAction(s, { kind: 'react', response: RIGHT, elapsedMs: 200 }, ctx(200 * (i + 1)));
    }
    expect(platformerGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('a wrong response fails the round immediately', () => {
    const s = fresh();
    const hit = platformerGame.handleMpcAction(s, { kind: 'react', response: WRONG, elapsedMs: 200 }, ctx(200));
    expect(platformerGame.evaluate(hit, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('ignores an implausibly fast claimed response (below the human floor)', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const reacted = platformerGame.handleMpcAction(s, { kind: 'react', response: RIGHT, elapsedMs: 50 }, ctx(50));
    expect(view(reacted, 'mpc').obstaclesCleared).toBe(0);
    expect(view(reacted, 'mpc').obstacleId).toBe(v.obstacleId); // unchanged; ignored
  });

  it('ignores a claim inconsistent with how quickly the message actually arrived', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const reacted = platformerGame.handleMpcAction(s, { kind: 'react', response: RIGHT, elapsedMs: 900 }, ctx(50));
    expect(view(reacted, 'mpc').obstacleId).toBe(v.obstacleId); // unchanged; ignored
  });

  it('a plausible but too-slow correct response still fails the round', () => {
    const s = fresh();
    // difficulty 1 -> obstacleWindowMs 700; 900ms is plausible but over the window.
    const hit = platformerGame.handleMpcAction(s, { kind: 'react', response: RIGHT, elapsedMs: 900 }, ctx(900));
    expect(platformerGame.evaluate(hit, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('the obstacle window expiring fails the round', () => {
    const s = fresh();
    const deadline = platformerGame.getNextDeadline(s)!;
    const timedOut = platformerGame.onDeadline(s, ctx(deadline));
    expect(platformerGame.evaluate(timedOut, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('scales requiredObstacles up and obstacleWindowMs down with difficulty, both bounded', () => {
    const easy = platformerGame.createInitialState({ ...config, difficulty: 1 }, ctx(0)) as {
      requiredObstacles: number;
      obstacleWindowMs: number;
    };
    const hard = platformerGame.createInitialState({ ...config, difficulty: 20 }, ctx(0)) as {
      requiredObstacles: number;
      obstacleWindowMs: number;
    };
    expect(easy.requiredObstacles).toBe(5);
    expect(easy.obstacleWindowMs).toBe(700);
    expect(hard.requiredObstacles).toBe(10); // capped
    expect(hard.obstacleWindowMs).toBe(400); // floored
  });

  it('always hides the generic countdown during the challenge', () => {
    const s = fresh();
    expect(platformerGame.isDeadlineHidden!(s)).toBe(true);
  });
});

describe('platformer: support', () => {
  it('a correct support response immediately lowers requiredObstacles and hands out a fresh one', () => {
    const s = fresh();
    const before = view(s, 'mpc').requiredObstacles;
    const cleared = platformerGame.handleSupportAction(s, 's1', { kind: 'react', response: RIGHT, elapsedMs: 0 }, ctx(0));
    expect(view(cleared, 'mpc').requiredObstacles).toBe(before - 1);
    expect(view(cleared, 'mpc').supportClears).toBe(1);
    expect(view(cleared, 's1').myObstacleType).toBeDefined();
  });

  it('a wrong support response is ignored, free to retry', () => {
    const s = fresh();
    const clicked = platformerGame.handleSupportAction(s, 's1', { kind: 'react', response: WRONG, elapsedMs: 0 }, ctx(0));
    expect(clicked).toBe(s);
  });

  it('a support clear can win the round outright once the MPC is one obstacle away', () => {
    let s = fresh();
    const required = view(s, 'mpc').requiredObstacles;
    for (let i = 0; i < required - 1; i++) {
      s = platformerGame.handleMpcAction(s, { kind: 'react', response: RIGHT, elapsedMs: 200 }, ctx(200 * (i + 1)));
    }
    expect(view(s, 'mpc').obstaclesCleared).toBe(required - 1);
    const rescued = platformerGame.handleSupportAction(
      s,
      's1',
      { kind: 'react', response: RIGHT, elapsedMs: 0 },
      ctx(50_000),
    );
    expect(platformerGame.evaluate(rescued, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('never lowers requiredObstacles below the floor', () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) {
      s = platformerGame.handleSupportAction(s, 's1', { kind: 'react', response: RIGHT, elapsedMs: 0 }, ctx(i));
    }
    // difficulty 1 -> initial requiredObstacles 5; floor = max(3, ceil(5 * 0.4)) = 3.
    expect(view(s, 'mpc').requiredObstacles).toBe(3);
    expect(platformerGame.evaluate(s, ctx(0))).toEqual({ status: 'active' }); // MPC still at 0 cleared
  });

  it('ignores an action from a player who is not on the support roster this round', () => {
    const s = fresh();
    const clicked = platformerGame.handleSupportAction(
      s,
      'ghost',
      { kind: 'react', response: RIGHT, elapsedMs: 0 },
      ctx(0),
    );
    expect(clicked).toBe(s);
  });
});

describe('platformer: per-player projection', () => {
  it('assigns roles correctly', () => {
    const s = fresh();
    expect(view(s, 'mpc').role).toBe('mpc');
    expect(view(s, 's1').role).toBe('support');
    expect(view(s, 'ghost').role).toBe('spectator');
  });

  it('does not expose internal timing fields to any viewer', () => {
    const s = fresh();
    const projected = platformerGame.getStateForPlayer(s, 'mpc') as Record<string, unknown>;
    expect(projected.obstacleSpawnAt).toBeUndefined();
    expect(projected.obstacleDeadlineAt).toBeUndefined();
  });

  it('gives a spectator no obstacle type to act on', () => {
    const s = fresh();
    const v = view(s, 'ghost');
    expect(v.obstacleType).toBeUndefined();
    expect(v.myObstacleType).toBeUndefined();
  });
});
