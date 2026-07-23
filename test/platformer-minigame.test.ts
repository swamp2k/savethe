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
    myObstacleId?: number;
    myObstacleType?: 'jump' | 'duck';
    livesRemaining: number;
    startingLives: number;
  };
}

const RIGHT: 'jump' | 'duck' = 'jump'; // what random=0 always produces
const WRONG: 'jump' | 'duck' = 'duck';

function mpcReact(s: unknown, response: 'jump' | 'duck', elapsedMs: number, now: number) {
  return platformerGame.handleMpcAction(
    s,
    { kind: 'react', obstacleId: view(s, 'mpc').obstacleId, response, elapsedMs },
    ctx(now),
  );
}

function supportReact(s: unknown, playerId: 's1' | 's2', response: 'jump' | 'duck', now: number) {
  return platformerGame.handleSupportAction(
    s,
    playerId,
    { kind: 'react', obstacleId: view(s, playerId).myObstacleId, response, elapsedMs: 0 },
    ctx(now),
  );
}

describe('platformer: action schema', () => {
  it('accepts a well-formed react', () => {
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', obstacleId: 1, response: 'jump', elapsedMs: 300 }).success).toBe(true);
  });

  it('rejects malformed actions', () => {
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', obstacleId: 1, response: 'fly', elapsedMs: 300 }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', response: 'jump', elapsedMs: 300 }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', obstacleId: -1, response: 'jump', elapsedMs: 300 }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', obstacleId: 1, response: 'jump' }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'react', obstacleId: 1, response: 'jump', elapsedMs: -1 }).success).toBe(false);
    expect(platformerGame.actionSchema.safeParse({ kind: 'explode' }).success).toBe(false);
  });
});

describe('platformer: MPC reactions', () => {
  it('a plausible, correct, fast-enough response clears the obstacle and spawns a new one', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const cleared = mpcReact(s, RIGHT, 200, 200);
    const cv = view(cleared, 'mpc');
    expect(cv.obstaclesCleared).toBe(1);
    expect(cv.obstacleId).not.toBe(v.obstacleId);
  });

  it('ignores a stale previous obstacle id', () => {
    const s = fresh();
    const staleId = view(s, 'mpc').obstacleId;
    const cleared = mpcReact(s, RIGHT, 200, 200);
    const stale = platformerGame.handleMpcAction(
      cleared,
      { kind: 'react', obstacleId: staleId, response: WRONG, elapsedMs: 200 },
      ctx(400),
    );
    expect(stale).toBe(cleared);
  });

  it('ignores a duplicate response to an already-cleared obstacle', () => {
    const s = fresh();
    const clearedId = view(s, 'mpc').obstacleId;
    const cleared = mpcReact(s, RIGHT, 200, 200);
    const duplicate = platformerGame.handleMpcAction(
      cleared,
      { kind: 'react', obstacleId: clearedId, response: RIGHT, elapsedMs: 200 },
      ctx(400),
    );
    expect(duplicate).toBe(cleared);
    expect(view(duplicate, 'mpc').obstaclesCleared).toBe(1);
  });

  it('ignores a delayed old action after an opposite-type next obstacle has spawned', () => {
    const s = fresh();
    const previous = view(s, 'mpc');
    const cleared = platformerGame.handleMpcAction(
      s,
      { kind: 'react', obstacleId: previous.obstacleId, response: RIGHT, elapsedMs: 200 },
      ctx(200, 1),
    );
    expect(view(cleared, 'mpc').obstacleType).toBe('duck');

    const delayed = platformerGame.handleMpcAction(
      cleared,
      { kind: 'react', obstacleId: previous.obstacleId, response: RIGHT, elapsedMs: 200 },
      ctx(400),
    );
    expect(delayed).toBe(cleared);
    expect(view(delayed, 'mpc').livesRemaining).toBe(2);
  });

  it('reaching requiredObstacles resolves the round as a success', () => {
    let s = fresh();
    const required = view(s, 'mpc').requiredObstacles;
    for (let i = 0; i < required; i++) {
      s = mpcReact(s, RIGHT, 200, 200 * (i + 1));
    }
    expect(platformerGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('a wrong response to the current obstacle consumes one life and the second fails', () => {
    const s = fresh();
    const firstHit = mpcReact(s, WRONG, 200, 200);
    expect(view(firstHit, 'mpc').livesRemaining).toBe(1);
    expect(platformerGame.evaluate(firstHit, ctx(0))).toEqual({ status: 'active' });

    const secondHit = mpcReact(firstHit, WRONG, 200, 400);
    expect(view(secondHit, 'mpc').livesRemaining).toBe(0);
    expect(platformerGame.evaluate(secondHit, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('ignores an implausibly fast claimed response (below the human floor)', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const reacted = mpcReact(s, RIGHT, 50, 50);
    expect(view(reacted, 'mpc').obstaclesCleared).toBe(0);
    expect(view(reacted, 'mpc').obstacleId).toBe(v.obstacleId); // unchanged; ignored
  });

  it('ignores a claim inconsistent with how quickly the message actually arrived', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    const reacted = mpcReact(s, RIGHT, 900, 50);
    expect(view(reacted, 'mpc').obstacleId).toBe(v.obstacleId); // unchanged; ignored
  });

  it('a plausible but too-slow correct response consumes one life', () => {
    const s = fresh();
    // difficulty 1 -> obstacleWindowMs 1800; 2000ms is plausible but over the window.
    const hit = mpcReact(s, RIGHT, 2000, 2000);
    expect(view(hit, 'mpc').livesRemaining).toBe(1);
    expect(platformerGame.evaluate(hit, ctx(0))).toEqual({ status: 'active' });
  });

  it('gives the server deadline transit slack beyond the player-facing window', () => {
    // Regression: the deadline used to be exactly spawn + window, so network
    // transit ate the player's window and round one often timed out instantly.
    const s = fresh();
    const windowMs = view(s, 'mpc').obstacleWindowMs;
    expect(platformerGame.getNextDeadline(s)!).toBeGreaterThan(windowMs);
    // Just past the window itself must NOT time out yet…
    const early = platformerGame.onDeadline(s, ctx(windowMs + 1));
    expect(platformerGame.evaluate(early, ctx(0))).toEqual({ status: 'active' });
    // …and a correct in-window reaction arriving after transit delay still counts.
    const late = mpcReact(s, RIGHT, 1400, windowMs + 300);
    expect(view(late, 'mpc').obstaclesCleared).toBe(1);
  });

  it('the first obstacle timeout costs a life and the second ends the round', () => {
    const s = fresh();
    const deadline = platformerGame.getNextDeadline(s)!;
    const firstTimeout = platformerGame.onDeadline(s, ctx(deadline));
    expect(view(firstTimeout, 'mpc').livesRemaining).toBe(1);
    expect(platformerGame.evaluate(firstTimeout, ctx(0))).toEqual({ status: 'active' });
    const secondDeadline = platformerGame.getNextDeadline(firstTimeout)!;
    const secondTimeout = platformerGame.onDeadline(firstTimeout, ctx(secondDeadline));
    expect(view(secondTimeout, 'mpc').livesRemaining).toBe(0);
    expect(platformerGame.evaluate(secondTimeout, ctx(0))).toMatchObject({ status: 'resolved', success: false });
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
    expect(easy.obstacleWindowMs).toBe(1800);
    expect(hard.requiredObstacles).toBe(10); // capped
    expect(hard.obstacleWindowMs).toBe(1100); // floored
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
    const previousId = view(s, 's1').myObstacleId;
    const cleared = supportReact(s, 's1', RIGHT, 0);
    expect(view(cleared, 'mpc').requiredObstacles).toBe(before - 1);
    expect(view(cleared, 'mpc').supportClears).toBe(1);
    expect(view(cleared, 's1').myObstacleId).not.toBe(previousId);
    expect(view(cleared, 's1').myObstacleType).toBeDefined();
  });

  it('a wrong support response is ignored, free to retry', () => {
    const s = fresh();
    const clicked = supportReact(s, 's1', WRONG, 0);
    expect(clicked).toBe(s);
  });

  it('a support clear can win the round outright once the MPC is one obstacle away', () => {
    let s = fresh();
    const required = view(s, 'mpc').requiredObstacles;
    for (let i = 0; i < required - 1; i++) {
      s = mpcReact(s, RIGHT, 200, 200 * (i + 1));
    }
    expect(view(s, 'mpc').obstaclesCleared).toBe(required - 1);
    const rescued = supportReact(s, 's1', RIGHT, 50_000);
    expect(platformerGame.evaluate(rescued, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('never lowers requiredObstacles below the floor', () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) {
      s = supportReact(s, 's1', RIGHT, i);
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
      { kind: 'react', obstacleId: 1, response: RIGHT, elapsedMs: 0 },
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
