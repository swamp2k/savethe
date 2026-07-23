import { describe, expect, it } from 'vitest';
import { tetrisGame } from '../src/server/minigames/tetris';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] };
function ctx(now: number, random = 0): MinigameContext {
  return { now, random: () => random };
}

/** Fresh state, started at t=0. With random=0, every spawned piece
 *  (initial and every respawn) is deterministically an O-piece, spawning
 *  centered at column 2 on the 6-wide grid. */
function fresh(random = 0) {
  return tetrisGame.onStart(tetrisGame.createInitialState(config, ctx(0, random)), ctx(0, random));
}

function view(s: unknown, viewerId: string) {
  return tetrisGame.getStateForPlayer(s, viewerId) as {
    role: string;
    linesCleared: number;
    requiredLines: number;
    supportAssists: number;
    grid?: boolean[][];
    cols?: number;
    rows?: number;
    pieceCells?: [number, number][];
    myChuteFilled?: number;
    myChuteHeight?: number;
  };
}

describe('tetris: action schema', () => {
  it('accepts well-formed actions', () => {
    expect(tetrisGame.actionSchema.safeParse({ kind: 'move', dir: 'left' }).success).toBe(true);
    expect(tetrisGame.actionSchema.safeParse({ kind: 'move', dir: 'right' }).success).toBe(true);
    expect(tetrisGame.actionSchema.safeParse({ kind: 'rotate' }).success).toBe(true);
    expect(tetrisGame.actionSchema.safeParse({ kind: 'drop' }).success).toBe(true);
    expect(tetrisGame.actionSchema.safeParse({ kind: 'assist' }).success).toBe(true);
  });

  it('rejects malformed actions', () => {
    expect(tetrisGame.actionSchema.safeParse({ kind: 'move', dir: 'sideways' }).success).toBe(false);
    expect(tetrisGame.actionSchema.safeParse({ kind: 'explode' }).success).toBe(false);
    expect(tetrisGame.actionSchema.safeParse({}).success).toBe(false);
  });
});

describe('tetris: spawn and movement', () => {
  it('spawns the first piece centered at the top', () => {
    const s = fresh();
    const v = view(s, 'mpc');
    expect(v.pieceCells?.sort()).toEqual([
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
    ]);
  });

  it('moves the active piece left and right within bounds', () => {
    const s = fresh();
    const left = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'left' }, ctx(0));
    expect(view(left, 'mpc').pieceCells?.[0]).toEqual([0, 1]);
    const right = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'right' }, ctx(0));
    expect(right).not.toBe(s); // accepted, position changed
  });

  it('ignores a move that would leave the grid', () => {
    let s = fresh();
    for (let i = 0; i < 10; i++) s = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'left' }, ctx(0));
    const v = view(s, 'mpc');
    expect(v.pieceCells?.some(([, c]) => c < 0)).toBe(false);
    const before = s;
    s = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'left' }, ctx(0));
    expect(s).toBe(before); // already at the wall; no-op
  });
});

describe('tetris: hard drop, locking, and topping out', () => {
  it('hard-drops the O-piece to the floor and spawns a fresh one', () => {
    const s = fresh();
    const dropped = tetrisGame.handleMpcAction(s, { kind: 'drop' }, ctx(0));
    const v = view(dropped, 'mpc');
    // 8-row grid, 2-tall piece -> locks at rows 6-7.
    expect(v.grid?.[6][2]).toBe(true);
    expect(v.grid?.[6][3]).toBe(true);
    expect(v.grid?.[7][2]).toBe(true);
    expect(v.grid?.[7][3]).toBe(true);
    expect(v.linesCleared).toBe(0);
    expect(v.pieceCells?.some(([r]) => r === 0)).toBe(true); // a new piece spawned at the top
  });

  it('clearing full rows across three side-by-side O-pieces reaches the win condition', () => {
    let s = fresh();
    // Piece 1: default spawn (cols 2-3) -> drop.
    s = tetrisGame.handleMpcAction(s, { kind: 'drop' }, ctx(0));
    // Piece 2: move to cols 0-1 -> drop.
    s = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'left' }, ctx(0));
    s = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'left' }, ctx(0));
    s = tetrisGame.handleMpcAction(s, { kind: 'drop' }, ctx(0));
    // Piece 3: move to cols 4-5 -> drop. This fills rows 6 and 7 completely.
    s = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'right' }, ctx(0));
    s = tetrisGame.handleMpcAction(s, { kind: 'move', dir: 'right' }, ctx(0));
    s = tetrisGame.handleMpcAction(s, { kind: 'drop' }, ctx(0));

    // difficulty 1 -> requiredLines 2; both bottom rows cleared at once.
    expect(tetrisGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: true });
  });

  it('stacking straight up without ever clearing a row tops out and fails', () => {
    let s = fresh();
    // Each O-drop (no moves) fills a fresh 2-row band in the same columns;
    // 4 drops exactly fill an 8-row column, and the 5th piece can't spawn.
    for (let i = 0; i < 4; i++) {
      s = tetrisGame.handleMpcAction(s, { kind: 'drop' }, ctx(0));
    }
    expect(tetrisGame.evaluate(s, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('the overall time budget expiring fails the round', () => {
    const s = fresh();
    const failed = tetrisGame.onDeadline(s, ctx(1_000_000));
    expect(tetrisGame.evaluate(failed, ctx(0))).toMatchObject({ status: 'resolved', success: false });
  });

  it('uses a 40-second overall budget', () => {
    const state = tetrisGame.createInitialState(config, ctx(0)) as { timeBudgetMs: number };
    expect(state.timeBudgetMs).toBe(40_000);
  });

  it('scales requiredLines up with difficulty, bounded', () => {
    const easy = tetrisGame.createInitialState({ ...config, difficulty: 1 }, ctx(0)) as { requiredLines: number };
    const hard = tetrisGame.createInitialState({ ...config, difficulty: 20 }, ctx(0)) as { requiredLines: number };
    expect(easy.requiredLines).toBe(2);
    expect(hard.requiredLines).toBe(6); // capped
  });
});

describe('tetris: rotation', () => {
  it('rotates a multi-state piece into its other orientation', () => {
    // random=0.3 -> floor(0.3*4)=1 -> the I-piece (2 rotation states).
    const s = fresh(0.3);
    const before = view(s, 'mpc').pieceCells;
    const rotated = tetrisGame.handleMpcAction(s, { kind: 'rotate' }, ctx(0, 0.3));
    expect(view(rotated, 'mpc').pieceCells).not.toEqual(before);
  });

  it('cycles an L piece through all four valid orientations', () => {
    // random=0.5 -> floor(0.5*4)=2 -> L.
    let state = fresh(0.5);
    const rotations: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      rotations.push((state as { activePiece: { rotation: number } }).activePiece.rotation);
      state = tetrisGame.handleMpcAction(state, { kind: 'rotate' }, ctx(0, 0.5));
    }
    expect(rotations).toEqual([0, 1, 2, 3]);
    expect((state as { activePiece: { rotation: number } }).activePiece.rotation).toBe(0);
  });

  it("a single-rotation-state piece (O) is a harmless no-op", () => {
    const s = fresh(); // O-piece
    const before = view(s, 'mpc').pieceCells;
    const rotated = tetrisGame.handleMpcAction(s, { kind: 'rotate' }, ctx(0));
    expect(view(rotated, 'mpc').pieceCells).toEqual(before);
  });
});

describe('tetris: support', () => {
  it('filling the chute lowers requiredLines and resets the chute', () => {
    const s = fresh();
    const before = view(s, 'mpc').requiredLines;
    const height = view(s, 's1').myChuteHeight!;
    let sup = s;
    for (let i = 0; i < height; i++) {
      sup = tetrisGame.handleSupportAction(sup, 's1', { kind: 'assist' }, ctx(0));
    }
    expect(view(sup, 'mpc').requiredLines).toBe(before - 1);
    expect(view(sup, 's1').myChuteFilled).toBe(0);
    expect(view(sup, 'mpc').supportAssists).toBe(1);
  });

  it('never lowers requiredLines below the floor', () => {
    let s = fresh();
    const height = view(s, 's1').myChuteHeight!;
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < height; i++) s = tetrisGame.handleSupportAction(s, 's1', { kind: 'assist' }, ctx(0));
    }
    // difficulty 1 -> initial requiredLines 2; floor = max(1, ceil(2 * 0.4)) = 1.
    expect(view(s, 'mpc').requiredLines).toBe(1);
  });

  it('ignores a move/rotate/drop action sent as a support action', () => {
    const s = fresh();
    const clicked = tetrisGame.handleSupportAction(s, 's1', { kind: 'drop' }, ctx(0));
    expect(clicked).toBe(s);
  });

  it('ignores an action from a player who is not on the support roster this round', () => {
    const s = fresh();
    const clicked = tetrisGame.handleSupportAction(s, 'ghost', { kind: 'assist' }, ctx(0));
    expect(clicked).toBe(s);
  });
});

describe('tetris: per-player projection', () => {
  it('assigns roles correctly', () => {
    const s = fresh();
    expect(view(s, 'mpc').role).toBe('mpc');
    expect(view(s, 's1').role).toBe('support');
    expect(view(s, 'ghost').role).toBe('spectator');
  });

  it('does not expose internal timing fields to any viewer', () => {
    const s = fresh();
    const projected = tetrisGame.getStateForPlayer(s, 'mpc') as Record<string, unknown>;
    expect(projected.deadlineForChallenge).toBeUndefined();
    expect(projected.startedAt).toBeUndefined();
  });

  it("gives a spectator no grid or piece to act on", () => {
    const s = fresh();
    const v = view(s, 'ghost');
    expect(v.grid).toBeUndefined();
    expect(v.pieceCells).toBeUndefined();
  });
});
