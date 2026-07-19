import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

export type MazeCell = 0 | 1;
interface Point { x: number; y: number; }
interface MazeState {
  mpcId: string;
  supportIds: string[];
  grid: MazeCell[][];
  position: Point;
  goal: Point;
  moves: number;
  bumps: number;
  maxBumps: number;
  timeBudgetMs: number;
  deadlineAt: number;
  outcome: 'pending' | 'success' | 'too_many_bumps' | 'timeout';
}

const actionSchema = z.object({ kind: z.literal('move'), direction: z.enum(['up', 'down', 'left', 'right']) });
type MazeAction = z.infer<typeof actionSchema>;
type Direction = MazeAction['direction'];
const DELTAS: Record<Direction, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const BASE_TIME_MS = 26_000;
const TIME_STEP_MS = 1_500;
const MIN_TIME_MS = 16_000;
const MAX_BUMPS = 3;

function asState(state: unknown): MazeState { return state as MazeState; }

export function mazeSizeForDifficulty(difficulty: number): number {
  if (difficulty <= 2) return 7;
  if (difficulty <= 4) return 9;
  return 11;
}

export function generateMaze(size: number, random: () => number): MazeCell[][] {
  const grid: MazeCell[][] = Array.from({ length: size }, () => Array<MazeCell>(size).fill(0));
  const stack: Point[] = [{ x: 1, y: 1 }];
  grid[1]![1] = 1;
  const directions: Point[] = [{ x: 0, y: -2 }, { x: 2, y: 0 }, { x: 0, y: 2 }, { x: -2, y: 0 }];
  while (stack.length > 0) {
    const current = stack[stack.length - 1]!;
    const candidates = directions.map((direction) => ({ x: current.x + direction.x, y: current.y + direction.y })).filter((next) => next.x > 0 && next.y > 0 && next.x < size - 1 && next.y < size - 1 && grid[next.y]![next.x] === 0);
    if (candidates.length === 0) { stack.pop(); continue; }
    const next = candidates[Math.floor(random() * candidates.length)]!;
    grid[(current.y + next.y) / 2]![(current.x + next.x) / 2] = 1;
    grid[next.y]![next.x] = 1;
    stack.push(next);
  }
  return grid;
}

function localGrid(s: MazeState): Array<Array<'wall' | 'open' | 'player' | 'goal'>> {
  return [-1, 0, 1].map((offsetY) => [-1, 0, 1].map((offsetX) => {
    const point = { x: s.position.x + offsetX, y: s.position.y + offsetY };
    if (point.x === s.position.x && point.y === s.position.y) return 'player';
    if (point.x === s.goal.x && point.y === s.goal.y) return 'goal';
    return s.grid[point.y]?.[point.x] === 1 ? 'open' : 'wall';
  }));
}

export const blindMazeGame: Minigame = {
  id: 'maze',
  title: 'Blind Maze',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): MazeState {
    const size = mazeSizeForDifficulty(config.difficulty);
    return { mpcId: config.mpcId, supportIds: config.supportIds, grid: generateMaze(size, ctx.random), position: { x: 1, y: 1 }, goal: { x: size - 2, y: size - 2 }, moves: 0, bumps: 0, maxBumps: MAX_BUMPS, timeBudgetMs: Math.max(MIN_TIME_MS, BASE_TIME_MS - (config.difficulty - 1) * TIME_STEP_MS), deadlineAt: 0, outcome: 'pending' };
  },

  onStart(state: unknown, ctx: MinigameContext): MazeState {
    const s = asState(state);
    return { ...s, deadlineAt: ctx.now + s.timeBudgetMs };
  },

  handleMpcAction(state: unknown, action: unknown): MazeState {
    const s = asState(state);
    const a = action as MazeAction;
    if (s.outcome !== 'pending') return s;
    const delta = DELTAS[a.direction];
    const next = { x: s.position.x + delta.x, y: s.position.y + delta.y };
    if (s.grid[next.y]?.[next.x] !== 1) {
      const bumps = s.bumps + 1;
      return bumps >= s.maxBumps ? { ...s, bumps, outcome: 'too_many_bumps' } : { ...s, bumps };
    }
    const moves = s.moves + 1;
    return next.x === s.goal.x && next.y === s.goal.y ? { ...s, position: next, moves, outcome: 'success' } : { ...s, position: next, moves };
  },

  handleSupportAction(state: unknown): MazeState { return asState(state); },

  onDeadline(state: unknown, ctx: MinigameContext): MazeState {
    const s = asState(state);
    return s.outcome === 'pending' && ctx.now >= s.deadlineAt ? { ...s, outcome: 'timeout' } : s;
  },

  evaluate(state: unknown): MinigameOutcome {
    const s = asState(state);
    if (s.outcome === 'success') return { status: 'resolved', success: true, headline: `MAZE ESCAPED in ${s.moves} moves!` };
    if (s.outcome === 'too_many_bumps') return { status: 'resolved', success: false, headline: 'Too many bumps. The maze wins.' };
    if (s.outcome === 'timeout') return { status: 'resolved', success: false, headline: 'Lost in the maze.' };
    return { status: 'active' };
  },

  getNextDeadline(state: unknown): number | null { const s = asState(state); return s.outcome === 'pending' ? s.deadlineAt : null; },
  getFuse(state: unknown): { deadlineAt: number; totalMs: number } | null { const s = asState(state); return s.outcome === 'pending' ? { deadlineAt: s.deadlineAt, totalMs: s.timeBudgetMs } : null; },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    const progress = { role, bumps: s.bumps, maxBumps: s.maxBumps, moves: s.moves };
    if (role === 'mpc') return { ...progress, localGrid: localGrid(s), goalVisible: Math.abs(s.position.x - s.goal.x) + Math.abs(s.position.y - s.goal.y) <= 1 };
    if (role === 'support') return { ...progress, grid: s.grid, position: s.position, goal: s.goal };
    return progress;
  },
};
