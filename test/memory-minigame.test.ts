import { describe, expect, it } from 'vitest';
import { memoryGame } from '../src/server/minigames/memory';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] };
function ctx(now: number, random = 0): MinigameContext {
  return { now, random: () => random };
}

/** Fresh state, started at t=0. With random=0, every symbol in every
 *  sequence (MPC's and each support player's) is deterministically SYMBOLS[0]. */
function fresh() {
  return memoryGame.onStart(memoryGame.createInitialState(config, ctx(0)), ctx(0));
}

function view(s: unknown, viewerId: string) {
  return memoryGame.getStateForPlayer(s, viewerId) as {
    role: string;
    stage: string;
    recallIndex: number;
    requiredCorrect: number;
    supportCompletions: number;
    alphabet: string[];
    sequence?: string[];
    mySequence?: string[];
    myIndex?: number;
  };
}

const RIGHT = '🔴'; // SYMBOLS[0], what random=0 always produces
const WRONG = '🟡'; // SYMBOLS[1], never what random=0 produces

describe('memory: action schema', () => {
  it('accepts a well-formed recall', () => {
    expect(memoryGame.actionSchema.safeParse({ kind: 'recall', symbol: RIGHT }).success).toBe(true);
  });

  it('rejects an unknown symbol or malformed payload', () => {
    expect(memoryGame.actionSchema.safeParse({ kind: 'recall', symbol: '🍕' }).success).toBe(false);
    expect(memoryGame.actionSchema.safeParse({ kind: 'recall' }).success).toBe(false);
    expect(memoryGame.actionSchema.safeParse({ kind: 'explode' }).success).toBe(false);
  });
});

describe('memory: study -> recall', () => {
  it('shows the MPC the full sequence during study, hides it during recall', () => {
    const s = fresh();
    expect(view(s, 'mpc').stage).toBe('study');
    expect(view(s, 'mpc').sequence).toEqual([RIGHT, RIGHT, RIGHT, RIGHT]);

    const deadline = memoryGame.getNextDeadline(s)!;
    const recalling = memoryGame.onDeadline(s, ctx(deadline));
    expect(view(recalling, 'mpc').stage).toBe('recall');
    expect(view(recalling, 'mpc').sequence).toBeUndefined();
  });

  it('ignores an eager click during the study stage', () => {
    const s = fresh();
    const clicked = memoryGame.handleMpcAction(s, { kind: 'recall', symbol: RIGHT }, ctx(0));
    expect(view(clicked, 'mpc').recallIndex).toBe(0);
    expect(memoryGame.evaluate(clicked, ctx(0))).toEqual({ status: 'active' });
  });
});

describe('memory: MPC recall', () => {
  function toRecall(): unknown {
    const s = fresh();
    const deadline = memoryGame.getNextDeadline(s)!;
    return memoryGame.onDeadline(s, ctx(deadline));
  }

  it('recalling the full sequence in order succeeds', () => {
    let s = toRecall();
    const required = view(s, 'mpc').requiredCorrect;
    for (let i = 0; i < required; i++) {
      s = memoryGame.handleMpcAction(s, { kind: 'recall', symbol: RIGHT }, ctx(0));
    }
    expect(memoryGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('a wrong symbol fails the round immediately', () => {
    const s = toRecall();
    const wrong = memoryGame.handleMpcAction(s, { kind: 'recall', symbol: WRONG }, ctx(0));
    expect(memoryGame.evaluate(wrong, ctx(0))).toMatchObject({ status: 'resolved', success: false });
    expect(view(wrong, 'mpc').recallIndex).toBe(0);
  });

  it('the recall time budget expiring fails the round', () => {
    const s = toRecall();
    const deadline = memoryGame.getNextDeadline(s)!;
    const timedOut = memoryGame.onDeadline(s, ctx(deadline));
    expect(memoryGame.evaluate(timedOut, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('scales sequence length up and study speed down with difficulty, both bounded', () => {
    const easy = memoryGame.createInitialState({ ...config, difficulty: 1 }, ctx(0)) as {
      sequenceLength: number;
      msPerSymbol: number;
    };
    const hard = memoryGame.createInitialState({ ...config, difficulty: 20 }, ctx(0)) as {
      sequenceLength: number;
      msPerSymbol: number;
    };
    expect(easy.sequenceLength).toBe(4);
    expect(easy.msPerSymbol).toBe(700);
    expect(hard.sequenceLength).toBe(8); // capped
    expect(hard.msPerSymbol).toBe(400); // floored
  });
});

describe('memory: support', () => {
  it('completing the support sequence lowers requiredCorrect and hands out a fresh one', () => {
    const s = fresh();
    const before = view(s, 'mpc').requiredCorrect;
    const supLen = view(s, 's1').mySequence!.length;
    let sup = s;
    for (let i = 0; i < supLen; i++) {
      sup = memoryGame.handleSupportAction(sup, 's1', { kind: 'recall', symbol: RIGHT }, ctx(200 * (i + 1)));
    }
    expect(view(sup, 'mpc').requiredCorrect).toBe(before - 1);
    expect(view(sup, 'mpc').supportCompletions).toBe(1);
  });

  it("a wrong support click resets only that player's own progress", () => {
    const s = fresh();
    let sup = memoryGame.handleSupportAction(s, 's1', { kind: 'recall', symbol: RIGHT }, ctx(100));
    expect(view(sup, 's1').myIndex).toBe(1);
    sup = memoryGame.handleSupportAction(sup, 's1', { kind: 'recall', symbol: WRONG }, ctx(200));
    expect(view(sup, 's1').myIndex).toBe(0);
    expect(view(sup, 'mpc').requiredCorrect).toBe(view(s, 'mpc').requiredCorrect); // unaffected
  });

  it('a support completion can win the round outright once the MPC is one hit away', () => {
    let s = fresh();
    const deadline = memoryGame.getNextDeadline(s)!;
    s = memoryGame.onDeadline(s, ctx(deadline)); // -> recall
    const required = view(s, 'mpc').requiredCorrect;
    for (let i = 0; i < required - 1; i++) {
      s = memoryGame.handleMpcAction(s, { kind: 'recall', symbol: RIGHT }, ctx(0));
    }
    expect(view(s, 'mpc').recallIndex).toBe(required - 1);

    const supLen = view(s, 's1').mySequence!.length;
    for (let i = 0; i < supLen; i++) {
      s = memoryGame.handleSupportAction(s, 's1', { kind: 'recall', symbol: RIGHT }, ctx(50_000 + i));
    }
    expect(memoryGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('never lowers requiredCorrect below the floor', () => {
    let s = fresh();
    for (let round = 0; round < 5; round++) {
      const supLen = view(s, 's1').mySequence!.length;
      for (let i = 0; i < supLen; i++) {
        s = memoryGame.handleSupportAction(s, 's1', { kind: 'recall', symbol: RIGHT }, ctx(1000 * round + i));
      }
    }
    // difficulty 1 -> initial requiredCorrect 4; floor = max(2, ceil(4 * 0.4)) = 2.
    expect(view(s, 'mpc').requiredCorrect).toBe(2);
    expect(memoryGame.evaluate(s, ctx(0))).toEqual({ status: 'active' }); // MPC still hasn't recalled anything
  });

  it('ignores an action from a player who is not on the support roster this round', () => {
    const s = fresh();
    const clicked = memoryGame.handleSupportAction(s, 'ghost', { kind: 'recall', symbol: RIGHT }, ctx(100));
    expect(clicked).toBe(s);
  });
});

describe('memory: per-player projection', () => {
  it('assigns roles correctly', () => {
    const s = fresh();
    expect(view(s, 'mpc').role).toBe('mpc');
    expect(view(s, 's1').role).toBe('support');
    expect(view(s, 'ghost').role).toBe('spectator');
  });

  it('never shows the MPC target sequence to support or spectators', () => {
    const s = fresh();
    const supProjected = memoryGame.getStateForPlayer(s, 's1') as Record<string, unknown>;
    const specProjected = memoryGame.getStateForPlayer(s, 'ghost') as Record<string, unknown>;
    expect(supProjected.sequence).toBeUndefined();
    expect(specProjected.sequence).toBeUndefined();
  });

  it('does not expose internal timing fields to any viewer', () => {
    const s = fresh();
    const projected = memoryGame.getStateForPlayer(s, 'mpc') as Record<string, unknown>;
    expect(projected.studyDeadlineAt).toBeUndefined();
    expect(projected.deadlineForChallenge).toBeUndefined();
    expect(projected.startedAt).toBeUndefined();
  });
});
