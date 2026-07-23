import { z } from 'zod';
import type { Minigame, MinigameConfig, MinigameContext, MinigameOutcome } from './contract';

interface State { mpcId: string; supportIds: string[]; target: number; bad: number; hits: number; required: number; boosts: number; deadline: number; outcome: 'pending' | 'success' | 'bad' | 'timeout'; }
const actionSchema = z.object({ kind: z.enum(['hit', 'shield']), cell: z.number().int().min(0).max(8) });
function asState(value: unknown): State { return value as State; }

/** A server-authoritative, non-latency-sensitive target grid. Support shields
 * hazards; each shield reduces the MPC's remaining target count. */
export const targetPanicGame: Minigame = {
  id: 'target_panic', title: 'Target Panic', actionSchema,
  createInitialState(config: MinigameConfig, ctx: MinigameContext): State {
    const target = Math.floor(ctx.random() * 9);
    let bad = Math.floor(ctx.random() * 9); if (bad === target) bad = (bad + 1) % 9;
    return { mpcId: config.mpcId, supportIds: config.supportIds, target, bad, hits: 0, required: Math.min(8, 4 + config.difficulty), boosts: 0, deadline: 0, outcome: 'pending' };
  },
  onStart(value, ctx) { const s = asState(value); return { ...s, deadline: ctx.now + 24_000 }; },
  handleMpcAction(value, action, ctx) { const s = asState(value); const a = action as z.infer<typeof actionSchema>; if (s.outcome !== 'pending' || a.kind !== 'hit') return s; if (a.cell === s.bad) return { ...s, outcome: 'bad' }; if (a.cell !== s.target) return s; const hits = s.hits + 1; if (hits >= s.required) return { ...s, hits, outcome: 'success' }; const target = Math.floor(ctx.random() * 9); let bad = Math.floor(ctx.random() * 9); if (bad === target) bad = (bad + 1) % 9; return { ...s, hits, target, bad }; },
  handleSupportAction(value, playerId, action) { const s = asState(value); const a = action as z.infer<typeof actionSchema>; if (s.outcome !== 'pending' || !s.supportIds.includes(playerId) || a.kind !== 'shield' || a.cell !== s.bad) return s; const required = Math.max(1, s.required - 1); return required <= s.hits ? { ...s, required, boosts: s.boosts + 1, outcome: 'success' } : { ...s, required, boosts: s.boosts + 1 }; },
  onDeadline(value, ctx) { const s = asState(value); return s.outcome === 'pending' && ctx.now >= s.deadline ? { ...s, outcome: 'timeout' } : s; },
  evaluate(value): MinigameOutcome { const s = asState(value); return s.outcome === 'success' ? { status: 'resolved', success: true, headline: `Target panic cleared with ${s.boosts} shield boost(s)!` } : s.outcome === 'bad' ? { status: 'resolved', success: false, headline: 'You hit a hazard!' } : s.outcome === 'timeout' ? { status: 'resolved', success: false, headline: 'Targets vanished before the rescue.' } : { status: 'active' }; },
  getNextDeadline(value) { const s = asState(value); return s.outcome === 'pending' ? s.deadline : null; },
  getFuse(value) { const s = asState(value); return s.outcome === 'pending' ? { deadlineAt: s.deadline, totalMs: 24_000 } : null; },
  getStateForPlayer(value, viewerId) { const s = asState(value); const role = viewerId === s.mpcId ? 'mpc' : s.supportIds.includes(viewerId) ? 'support' : 'spectator'; return { role, target: role === 'mpc' ? s.target : null, hazard: role === 'support' ? s.bad : null, hits: s.hits, required: s.required, boosts: s.boosts }; },
};
