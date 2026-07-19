import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

type WireColor = 'red' | 'blue' | 'green' | 'yellow';

interface WireState {
  mpcId: string;
  supportIds: string[];
  wires: WireColor[];
  correctWire: WireColor;
  cluesByPlayer: Record<string, string[]>;
  mpcFallbackClues: string[];
  timeBudgetMs: number;
  startedAt: number;
  deadlineAt: number;
  cutWire: WireColor | null;
  outcome: 'pending' | 'success' | 'wrong_wire' | 'timeout';
}

const COLORS = ['red', 'blue', 'green', 'yellow'] as const satisfies readonly WireColor[];
const BASE_TIME_MS = 22_000;
const TIME_STEP_MS = 750;
const MIN_TIME_MS = 17_000;

const actionSchema = z.object({ kind: z.literal('cut'), wire: z.enum(COLORS) });
type WireAction = z.infer<typeof actionSchema>;

function asState(state: unknown): WireState {
  return state as WireState;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function distributeClues(clues: string[], supportIds: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = Object.fromEntries(supportIds.map((id) => [id, []]));
  if (supportIds.length === 0) return result;
  clues.forEach((clue, index) => result[supportIds[index % supportIds.length]].push(clue));
  supportIds.forEach((id, index) => {
    if (result[id].length === 0) result[id].push(clues[index % clues.length]);
  });
  return result;
}

export const wireGame: Minigame = {
  id: 'wire',
  title: 'Wire Panic',
  actionSchema,

  createInitialState(config: MinigameConfig, ctx: MinigameContext): WireState {
    const correctWire = COLORS[Math.floor(ctx.random() * COLORS.length)] ?? COLORS[0];
    const clues = shuffle(COLORS.filter((color) => color !== correctWire).map((color) => `NOT ${color.toUpperCase()}.`), ctx.random);
    return {
      mpcId: config.mpcId,
      supportIds: config.supportIds,
      wires: shuffle(COLORS, ctx.random),
      correctWire,
      cluesByPlayer: distributeClues(clues, config.supportIds),
      mpcFallbackClues: clues,
      timeBudgetMs: Math.max(MIN_TIME_MS, BASE_TIME_MS - (config.difficulty - 1) * TIME_STEP_MS),
      startedAt: 0,
      deadlineAt: 0,
      cutWire: null,
      outcome: 'pending',
    };
  },

  onStart(state: unknown, ctx: MinigameContext): WireState {
    const s = asState(state);
    return { ...s, startedAt: ctx.now, deadlineAt: ctx.now + s.timeBudgetMs };
  },

  handleMpcAction(state: unknown, action: unknown): WireState {
    const s = asState(state);
    if (s.outcome !== 'pending') return s;
    const a = action as WireAction;
    return a.wire === s.correctWire
      ? { ...s, cutWire: a.wire, outcome: 'success' }
      : { ...s, cutWire: a.wire, outcome: 'wrong_wire' };
  },

  handleSupportAction(state: unknown): WireState {
    return asState(state);
  },

  onDeadline(state: unknown, ctx: MinigameContext): WireState {
    const s = asState(state);
    return s.outcome === 'pending' && ctx.now >= s.deadlineAt ? { ...s, outcome: 'timeout' } : s;
  },

  evaluate(state: unknown): MinigameOutcome {
    switch (asState(state).outcome) {
      case 'success': return { status: 'resolved', success: true, headline: 'WIRE CUT! The team talked you through it.' };
      case 'wrong_wire': return { status: 'resolved', success: false, headline: 'WRONG WIRE. That was unfortunate.' };
      case 'timeout': return { status: 'resolved', success: false, headline: 'Too late. Nobody cut anything.' };
      case 'pending': return { status: 'active' };
    }
  },

  getNextDeadline(state: unknown): number | null {
    const s = asState(state);
    return s.outcome === 'pending' ? s.deadlineAt : null;
  },

  getFuse(state: unknown): { deadlineAt: number; totalMs: number } | null {
    const s = asState(state);
    return s.outcome === 'pending' ? { deadlineAt: s.deadlineAt, totalMs: s.timeBudgetMs } : null;
  },

  getStateForPlayer(state: unknown, viewerId: string): unknown {
    const s = asState(state);
    const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator';
    return {
      role,
      wires: s.wires,
      clues: role === 'mpc' ? (s.supportIds.length === 0 ? s.mpcFallbackClues : []) : role === 'support' ? (s.cluesByPlayer[viewerId] ?? []) : [],
    };
  },
};
