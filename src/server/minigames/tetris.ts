import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

/**
 * Tetris-like. A small grid; one piece at a time, moved/rotated with
 * discrete actions and locked in with a hard drop — there's no falling-
 * gravity ticker, deliberately: every other action in this codebase is a
 * single discrete message-in, state-out step, and giving pieces their own
 * autonomous downward motion would mean introducing a new "the engine wakes
 * itself up to move something" pattern for one minigame. A hard drop keeps
 * Tetris-like exactly as message-driven as everything else, at the cost of
 * being a placement puzzle rather than a real-time descent — still
 * recognizably Tetris (rotate, move, drop, clear lines), just paced by the
 * player instead of a clock.
 *
 * Support gets a tiny, always-visible 1-wide "chute" (no expiry, no
 * deadline — same "support is never itself deadline-bound" rule Aim
 * Trainer/Memory's support already follow) that fills on each `assist` and
 * clears itself, lowering the MPC's line target (floored), the same
 * support-lowers-the-bar shape used everywhere else in this roster.
 */

const PIECE_TYPES = ['O', 'I', 'L', 'T'] as const;
type PieceType = (typeof PIECE_TYPES)[number];

/** Each piece type's rotation states, as [row, col] offsets from its anchor.
 *  Hardcoded rather than computed by a rotation matrix — fewer states, no
 *  wall-kick system, but far less to get subtly wrong. */
const PIECE_SHAPES: Record<PieceType, number[][][]> = {
  O: [
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
  ],
  I: [
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ],
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ],
  ],
  L: [
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
    ],
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
    ],
  ],
  T: [
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 1],
    ],
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [1, 1],
    ],
  ],
};

interface ActivePiece {
  type: PieceType;
  rotation: number;
  anchorRow: number;
  anchorCol: number;
}

interface SupportChute {
  filled: number;
  height: number;
}

interface TetrisState {
  mpcId: string;
  supportIds: string[];
  cols: number;
  rows: number;
  grid: boolean[][];
  activePiece: ActivePiece;
  linesCleared: number;
  /** The bar support can lower; never below `requiredLinesFloor(initialRequiredLines)`. */
  requiredLines: number;
  initialRequiredLines: number;
  timeBudgetMs: number;
  startedAt: number;
  deadlineForChallenge: number;
  supportChute: Record<string, SupportChute>;
  supportAssists: number;
  outcome: 'pending' | 'mpc_success' | 'topped_out' | 'timeout';
}

const actionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), dir: z.enum(['left', 'right']) }),
  z.object({ kind: z.literal('rotate') }),
  z.object({ kind: z.literal('drop') }),
  z.object({ kind: z.literal('assist') }),
]);
type TetrisAction = z.infer<typeof actionSchema>;

const COLS = 6;
const ROWS = 8;

const BASE_REQUIRED_LINES = 2;
const REQUIRED_LINES_STEP = 1;
const MAX_REQUIRED_LINES = 6;

/** Fixed rather than difficulty-scaled: requiredLines alone carries the
 *  difficulty curve, and clearing more lines already takes longer. */
const TIME_BUDGET_MS = 40_000;

const SUPPORT_CHUTE_HEIGHT = 4;
const SUPPORT_REDUCTION_PER_CHUTE = 1;
const REQUIRED_LINES_FLOOR_RATIO = 0.4;
const REQUIRED_LINES_FLOOR_MIN = 1;

function makeEmptyGrid(rows: number, cols: number): boolean[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(false));
}

function canPlace(grid: boolean[][], shape: number[][], anchorRow: number, anchorCol: number, rows: number, cols: number): boolean {
  for (const [dr, dc] of shape) {
    const r = anchorRow + dr;
    const c = anchorCol + dc;
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
    if (grid[r][c]) return false;
  }
  return true;
}

function lockPiece(grid: boolean[][], shape: number[][], anchorRow: number, anchorCol: number): boolean[][] {
  const next = grid.map((row) => [...row]);
  for (const [dr, dc] of shape) next[anchorRow + dr][anchorCol + dc] = true;
  return next;
}

function clearFullRows(grid: boolean[][], cols: number): { grid: boolean[][]; linesCleared: number } {
  const remaining = grid.filter((row) => !row.every(Boolean));
  const cleared = grid.length - remaining.length;
  const empties = Array.from({ length: cleared }, () => Array(cols).fill(false));
  return { grid: [...empties, ...remaining], linesCleared: cleared };
}

function spawnCol(shape: number[][], cols: number): number {
  const width = Math.max(...shape.map(([, c]) => c)) + 1;
  return Math.floor((cols - width) / 2);
}

function randomPieceType(random: () => number): PieceType {
  return PIECE_TYPES[Math.floor(random() * PIECE_TYPES.length)];
}

function spawnPiece(random: () => number, cols: number): ActivePiece {
  const type = randomPieceType(random);
  const shape = PIECE_SHAPES[type][0];
  return { type, rotation: 0, anchorRow: 0, anchorCol: spawnCol(shape, cols) };
}

function requiredLinesFloor(initialRequiredLines: number): number {
  return Math.max(REQUIRED_LINES_FLOOR_MIN, Math.ceil(initialRequiredLines * REQUIRED_LINES_FLOOR_RATIO));
}

function asState(state: unknown): TetrisState {
  return state as TetrisState;
}

export const tetrisGame: Minigame = {
  id: 'tetris',
  title: 'Block Fit',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): TetrisState {
    const requiredLines = Math.min(
      MAX_REQUIRED_LINES,
      BASE_REQUIRED_LINES + (config.difficulty - 1) * REQUIRED_LINES_STEP,
    );

    const supportChute: Record<string, SupportChute> = {};
    for (const id of config.supportIds) supportChute[id] = { filled: 0, height: SUPPORT_CHUTE_HEIGHT };

    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      cols: COLS,
      rows: ROWS,
      grid: makeEmptyGrid(ROWS, COLS),
      activePiece: spawnPiece(ctx.random, COLS),
      linesCleared: 0,
      requiredLines,
      initialRequiredLines: requiredLines,
      timeBudgetMs: TIME_BUDGET_MS,
      startedAt: 0,
      deadlineForChallenge: 0,
      supportChute,
      supportAssists: 0,
      outcome: 'pending',
    };
  },

  onStart(state: unknown, ctx: MinigameContext): TetrisState {
    const s = asState(state);
    return { ...s, startedAt: ctx.now, deadlineForChallenge: ctx.now + s.timeBudgetMs };
  },

  handleMpcAction(state: unknown, action: unknown, ctx: MinigameContext): TetrisState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const a = action as TetrisAction;
    const shape = PIECE_SHAPES[s.activePiece.type][s.activePiece.rotation];

    if (a.kind === 'move') {
      const anchorCol = s.activePiece.anchorCol + (a.dir === 'left' ? -1 : 1);
      if (!canPlace(s.grid, shape, s.activePiece.anchorRow, anchorCol, s.rows, s.cols)) return s;
      return { ...s, activePiece: { ...s.activePiece, anchorCol } };
    }

    if (a.kind === 'rotate') {
      const states = PIECE_SHAPES[s.activePiece.type];
      const rotation = (s.activePiece.rotation + 1) % states.length;
      if (!canPlace(s.grid, states[rotation], s.activePiece.anchorRow, s.activePiece.anchorCol, s.rows, s.cols)) return s;
      return { ...s, activePiece: { ...s.activePiece, rotation } };
    }

    if (a.kind === 'drop') {
      let anchorRow = s.activePiece.anchorRow;
      while (canPlace(s.grid, shape, anchorRow + 1, s.activePiece.anchorCol, s.rows, s.cols)) anchorRow++;
      const locked = lockPiece(s.grid, shape, anchorRow, s.activePiece.anchorCol);
      const { grid, linesCleared: clearedThisDrop } = clearFullRows(locked, s.cols);
      const linesCleared = s.linesCleared + clearedThisDrop;

      if (linesCleared >= s.requiredLines) {
        return { ...s, grid, linesCleared, outcome: 'mpc_success' };
      }

      const activePiece = spawnPiece(ctx.random, s.cols);
      const nextShape = PIECE_SHAPES[activePiece.type][activePiece.rotation];
      if (!canPlace(grid, nextShape, activePiece.anchorRow, activePiece.anchorCol, s.rows, s.cols)) {
        return { ...s, grid, linesCleared, activePiece, outcome: 'topped_out' };
      }
      return { ...s, grid, linesCleared, activePiece };
    }

    return s; // 'assist' doesn't apply to the MPC
  },

  handleSupportAction(state: unknown, playerId: string, action: unknown): TetrisState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const chute = s.supportChute[playerId];
    if (!chute) return s; // not a support player this round
    const a = action as TetrisAction;
    if (a.kind !== 'assist') return s;

    const filled = chute.filled + 1;
    if (filled < chute.height) {
      return { ...s, supportChute: { ...s.supportChute, [playerId]: { ...chute, filled } } };
    }

    // Chute full: clear it, lower the MPC's bar.
    const requiredLines = Math.max(
      requiredLinesFloor(s.initialRequiredLines),
      s.requiredLines - SUPPORT_REDUCTION_PER_CHUTE,
    );
    const next: TetrisState = {
      ...s,
      supportChute: { ...s.supportChute, [playerId]: { filled: 0, height: chute.height } },
      requiredLines,
      supportAssists: s.supportAssists + 1,
    };
    return next.linesCleared >= requiredLines ? { ...next, outcome: 'mpc_success' } : next;
  },

  onDeadline(state: unknown, ctx: MinigameContext): TetrisState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    if (ctx.now >= s.deadlineForChallenge) return { ...s, outcome: 'timeout' };
    return s;
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    switch (s.outcome) {
      case 'mpc_success': {
        const assist = s.supportAssists > 0 ? ` (${s.supportAssists} team assist${s.supportAssists === 1 ? '' : 's'})` : '';
        return { status: 'resolved', success: true, headline: `Cleared ${s.linesCleared}/${s.requiredLines} lines${assist}!` };
      }
      case 'topped_out':
        return { status: 'resolved', success: false, headline: `Stacked too high — ${s.linesCleared}/${s.requiredLines} lines cleared.` };
      case 'timeout':
        return { status: 'resolved', success: false, headline: `Out of time — ${s.linesCleared}/${s.requiredLines} lines cleared.` };
      case 'pending':
        return { status: 'active' };
    }
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.outcome === 'pending' ? s.deadlineForChallenge : null;
  },

  getFuse(state: unknown): { deadlineAt: number; totalMs: number } | null {
    const s = asState(state);
    return s.outcome === 'pending' ? { deadlineAt: s.deadlineForChallenge, totalMs: s.timeBudgetMs } : null;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const base = {
      role,
      linesCleared: s.linesCleared,
      requiredLines: s.requiredLines,
      supportAssists: s.supportAssists,
    };
    if (role === 'mpc') {
      const shape = PIECE_SHAPES[s.activePiece.type][s.activePiece.rotation];
      const pieceCells = shape.map(([dr, dc]) => [s.activePiece.anchorRow + dr, s.activePiece.anchorCol + dc]);
      return { ...base, grid: s.grid, cols: s.cols, rows: s.rows, pieceCells };
    }
    if (role === 'support') {
      const chute = s.supportChute[viewerId];
      return { ...base, myChuteFilled: chute?.filled ?? 0, myChuteHeight: chute?.height ?? SUPPORT_CHUTE_HEIGHT };
    }
    return base;
  },
};
