import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';
const keys = ['up', 'down', 'left', 'right'] as const;
type Key = (typeof keys)[number];
interface State { mpcId: string; supportIds: string[]; sequence: Key[]; progress: number; required: number; supportProgress: Record<string, number>; helps: number; deadline: number; outcome: 'pending' | 'success' | 'wrong' | 'timeout'; }
const actionSchema = z.object({ kind: z.literal('press'), key: z.enum(keys) }); const asState = (v: unknown) => v as State;
export const simonGame: Minigame = { id: 'simon', title: 'Simon Rescue', actionSchema,
  createInitialState(c: MinigameConfig, ctx: MinigameContext): State { const required = Math.min(8, 3 + c.difficulty); const sequence = Array.from({ length: required }, () => keys[Math.floor(ctx.random() * keys.length)]); return { mpcId: c.mpcId, supportIds: c.supportIds, sequence, progress: 0, required, supportProgress: Object.fromEntries(c.supportIds.map((id) => [id, 0])), helps: 0, deadline: 0, outcome: 'pending' }; },
  onStart(v, ctx) { const s = asState(v); return { ...s, deadline: ctx.now + 28_000 }; },
  handleMpcAction(v, a) { const s = asState(v); const x = a as z.infer<typeof actionSchema>; if (s.outcome !== 'pending') return s; if (x.key !== s.sequence[s.progress]) return { ...s, outcome: 'wrong' }; const progress = s.progress + 1; return progress >= s.required ? { ...s, progress, outcome: 'success' } : { ...s, progress }; },
  handleSupportAction(v, id, a) { const s = asState(v); const x = a as z.infer<typeof actionSchema>; const p = s.supportProgress[id]; if (s.outcome !== 'pending' || p === undefined || x.key !== s.sequence[p]) return s; const next = p + 1; if (next < 2) return { ...s, supportProgress: { ...s.supportProgress, [id]: next } }; const required = Math.max(1, s.required - 1); const n = { ...s, required, helps: s.helps + 1, supportProgress: { ...s.supportProgress, [id]: 0 } }; return s.progress >= required ? { ...n, outcome: 'success' } : n; },
  onDeadline(v, ctx) { const s = asState(v); return s.outcome === 'pending' && ctx.now >= s.deadline ? { ...s, outcome: 'timeout' } : s; },
  evaluate(v): MinigameOutcome { const s = asState(v); return s.outcome === 'success' ? { status: 'resolved', success: true, headline: `Sequence saved with ${s.helps} team hint(s)!` } : s.outcome === 'wrong' ? { status: 'resolved', success: false, headline: 'Wrong sequence step!' } : s.outcome === 'timeout' ? { status: 'resolved', success: false, headline: 'The sequence timed out.' } : { status: 'active' }; },
  getNextDeadline(v) { const s = asState(v); return s.outcome === 'pending' ? s.deadline : null; }, getFuse(v) { const s = asState(v); return s.outcome === 'pending' ? { deadlineAt: s.deadline, totalMs: 28_000 } : null; },
  getStateForPlayer(v, id) { const s = asState(v); const role = id === s.mpcId ? 'mpc' : s.supportIds.includes(id) ? 'support' : 'spectator'; return { role, sequence: role === 'mpc' ? s.sequence : s.sequence.slice(0, 2), progress: s.progress, required: s.required, helps: s.helps, supportProgress: role === 'support' ? s.supportProgress[id] : 0 }; },
};
