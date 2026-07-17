import { describe, expect, it } from 'vitest';
import { debugGame } from '../src/server/minigames/debug';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'mpc', supportIds: ['s1', 's2'] };
function ctx(now: number): MinigameContext {
  return { now, random: () => 0 };
}

function fresh(now = 1000) {
  return debugGame.onStart(debugGame.createInitialState(config, ctx(now)), ctx(now));
}

describe('debug minigame', () => {
  it('validates action payloads', () => {
    expect(debugGame.actionSchema.safeParse({ kind: 'save' }).success).toBe(true);
    expect(debugGame.actionSchema.safeParse({ kind: 'explode' }).success).toBe(false);
    expect(debugGame.actionSchema.safeParse({}).success).toBe(false);
  });

  it('resolves to a clean success when the MPC saves', () => {
    const s = debugGame.handleMpcAction(fresh(), { kind: 'save' }, ctx(1500));
    const outcome = debugGame.evaluate(s, ctx(1500));
    expect(outcome).toMatchObject({ status: 'resolved', success: true });
  });

  it('locks the MPC choice after the first press', () => {
    let s = debugGame.handleMpcAction(fresh(), { kind: 'doom' }, ctx(1500));
    s = debugGame.handleMpcAction(s, { kind: 'save' }, ctx(1600)); // ignored
    // Still doom -> stays active until the deadline, then fails.
    expect(debugGame.evaluate(s, ctx(1600))).toEqual({ status: 'active' });
    const dl = debugGame.getNextDeadline(s)!;
    expect(debugGame.evaluate(s, ctx(dl + 1))).toMatchObject({ status: 'resolved', success: false });
  });

  it('lets a support player rescue after the MPC dooms', () => {
    let s = debugGame.handleMpcAction(fresh(), { kind: 'doom' }, ctx(1500));
    expect(debugGame.evaluate(s, ctx(1600))).toEqual({ status: 'active' });
    s = debugGame.handleSupportAction(s, 's2', { kind: 'rescue' }, ctx(1700));
    expect(debugGame.evaluate(s, ctx(1700))).toMatchObject({ status: 'resolved', success: true, savedBy: 's2' });
  });

  it('only credits the first rescuer', () => {
    let s = debugGame.handleSupportAction(fresh(), 's1', { kind: 'rescue' }, ctx(1500));
    s = debugGame.handleSupportAction(s, 's2', { kind: 'rescue' }, ctx(1600));
    expect(debugGame.evaluate(s, ctx(1600))).toMatchObject({ savedBy: 's1' });
  });

  it('projects roles and affordances per viewer', () => {
    const s = fresh();
    expect(debugGame.getStateForPlayer(s, 'mpc')).toMatchObject({ role: 'mpc', canAct: ['save', 'doom'] });
    expect(debugGame.getStateForPlayer(s, 's1')).toMatchObject({ role: 'support', canAct: ['rescue'] });
    expect(debugGame.getStateForPlayer(s, 'ghost')).toMatchObject({ role: 'spectator', canAct: [] });
  });

  it('scales its duration with difficulty', () => {
    const easy = debugGame.getNextDeadline(debugGame.onStart(debugGame.createInitialState({ ...config, difficulty: 1 }, ctx(0)), ctx(0)))!;
    const hard = debugGame.getNextDeadline(debugGame.onStart(debugGame.createInitialState({ ...config, difficulty: 5 }, ctx(0)), ctx(0)))!;
    expect(hard).toBeLessThan(easy);
  });
});
