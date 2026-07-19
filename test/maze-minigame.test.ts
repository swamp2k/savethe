import { describe, expect, it } from 'vitest';
import { blindMazeGame, generateMaze, mazeSizeForDifficulty, type MazeCell } from '../src/server/minigames/maze';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'm', supportIds: ['s'] };
const ctx = (now: number, random = 0): MinigameContext => ({ now, random: () => random });
const fresh = (nextConfig = config) => blindMazeGame.onStart(blindMazeGame.createInitialState(nextConfig, ctx(0)), ctx(0));
type Direction = 'up' | 'down' | 'left' | 'right';
const directions: Array<{ direction: Direction; x: number; y: number }> = [{ direction: 'up', x: 0, y: -1 }, { direction: 'down', x: 0, y: 1 }, { direction: 'left', x: -1, y: 0 }, { direction: 'right', x: 1, y: 0 }];
interface State { grid: MazeCell[][]; position: { x: number; y: number }; goal: { x: number; y: number }; maxBumps: number; }

function pathToGoal(state: unknown): Direction[] {
  const s = state as State;
  const queue = [{ ...s.position, path: [] as Direction[] }];
  const seen = new Set([`${s.position.x},${s.position.y}`]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.x === s.goal.x && current.y === s.goal.y) return current.path;
    for (const step of directions) {
      const next = { x: current.x + step.x, y: current.y + step.y };
      const key = `${next.x},${next.y}`;
      if (s.grid[next.y]?.[next.x] === 1 && !seen.has(key)) { seen.add(key); queue.push({ ...next, path: [...current.path, step.direction] }); }
    }
  }
  throw new Error('maze goal was unreachable');
}

function wallFromStart(state: unknown): Direction {
  const s = state as State;
  const wall = directions.find((step) => s.grid[s.position.y + step.y]?.[s.position.x + step.x] !== 1);
  if (!wall) throw new Error('start had no adjacent wall');
  return wall.direction;
}

describe('Blind Maze', () => {
  it('keeps a 26-second floor at high difficulty', () => {
    const hard = blindMazeGame.createInitialState({ ...config, difficulty: 99 }, ctx(0)) as { timeBudgetMs: number };
    expect(hard.timeBudgetMs).toBe(26_000);
  });

  it('creates deterministic, odd, solvable mazes with open start and goal', () => {
    expect([mazeSizeForDifficulty(1), mazeSizeForDifficulty(3), mazeSizeForDifficulty(5)]).toEqual([7, 9, 11]);
    const first = generateMaze(9, () => 0.3);
    expect(first).toEqual(generateMaze(9, () => 0.3));
    expect(first).toHaveLength(9);
    expect(first[0]).toHaveLength(9);
    expect(first[1]![1]).toBe(1);
    expect(first[7]![7]).toBe(1);
    expect(pathToGoal(fresh({ ...config, difficulty: 3 }))).not.toHaveLength(0);
  });

  it('moves through open paths, bumps against walls, and fails on the third bump', () => {
    const state = fresh();
    const path = pathToGoal(state);
    const moved = blindMazeGame.handleMpcAction(state, { kind: 'move', direction: path[0] }, ctx(1));
    expect((moved as State).position).not.toEqual((state as State).position);
    const wall = wallFromStart(state);
    let bumped: unknown = state;
    for (let index = 0; index < 3; index += 1) bumped = blindMazeGame.handleMpcAction(bumped, { kind: 'move', direction: wall }, ctx(index + 1));
    expect((bumped as State).position).toEqual((state as State).position);
    expect(blindMazeGame.evaluate(bumped, ctx(0))).toMatchObject({ success: false });
  });

  it('reaches the goal through MPC actions, times out, and ignores support actions', () => {
    let state = fresh();
    for (const direction of pathToGoal(state)) state = blindMazeGame.handleMpcAction(state, { kind: 'move', direction }, ctx(1));
    expect(blindMazeGame.evaluate(state, ctx(0))).toMatchObject({ success: true });
    const untouched = fresh();
    expect(blindMazeGame.handleSupportAction(untouched, 's', { kind: 'move', direction: 'right' }, ctx(1))).toBe(untouched);
    expect(blindMazeGame.evaluate(blindMazeGame.onDeadline(untouched, ctx(36000)), ctx(36000))).toMatchObject({ success: false });
  });

  it('preserves asymmetric projections and a fixed fuse, including no-support rounds', () => {
    const state = fresh();
    const mpc = blindMazeGame.getStateForPlayer(state, 'm') as Record<string, unknown>;
    const support = blindMazeGame.getStateForPlayer(state, 's') as Record<string, unknown>;
    const spectator = blindMazeGame.getStateForPlayer(state, 'ghost') as Record<string, unknown>;
    expect((mpc.localGrid as unknown[][])).toHaveLength(3);
    expect((mpc.localGrid as unknown[][])[0]).toHaveLength(3);
    expect(mpc.grid).toBeUndefined();
    expect(support.grid).toBeDefined();
    expect(spectator.grid).toBeUndefined();
    expect(blindMazeGame.getFuse!(state)).toEqual({ deadlineAt: 36000, totalMs: 36000 });
    const solo = fresh({ ...config, supportIds: [] });
    expect(pathToGoal(solo)).not.toHaveLength(0);
  });
});
