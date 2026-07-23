import { describe, expect, it } from 'vitest';
import { targetPanicGame } from '../src/server/minigames/target-panic';
import { simonGame } from '../src/server/minigames/simon';
import { plushCatchGame } from '../src/server/minigames/plush-catch';

const config = { difficulty: 1, mpcId: 'm', supportIds: ['s'] };
const ctx = (now = 0, random = () => 0) => ({ now, random });

describe('new cooperative minigames', () => {
  it('Target Panic lets support lower the MPC requirement and keeps hazards private by role', () => {
    const state = targetPanicGame.onStart(targetPanicGame.createInitialState(config, ctx()), ctx());
    const support = targetPanicGame.getStateForPlayer(state, 's') as { hazard: number };
    const after = targetPanicGame.handleSupportAction(state, 's', { kind: 'shield', cell: support.hazard }, ctx());
    expect((targetPanicGame.getStateForPlayer(after, 'm') as { required: number }).required).toBe(4);
    expect((targetPanicGame.getStateForPlayer(state, 'm') as { hazard: unknown }).hazard).toBeNull();
  });

  it('Simon support completion shortens the MPC sequence', () => {
    let state = simonGame.onStart(simonGame.createInitialState(config, ctx()), ctx());
    state = simonGame.handleSupportAction(state, 's', { kind: 'press', key: 'up' }, ctx());
    state = simonGame.handleSupportAction(state, 's', { kind: 'press', key: 'up' }, ctx());
    expect((simonGame.getStateForPlayer(state, 'm') as { required: number }).required).toBe(3);
  });

  it('Catch lets support shield a bad lane and the MPC catch the good lane', () => {
    let state = plushCatchGame.onStart(plushCatchGame.createInitialState(config, ctx()), ctx());
    const support = plushCatchGame.getStateForPlayer(state, 's') as { badLane: number };
    state = plushCatchGame.handleSupportAction(state, 's', { kind: 'shield', lane: support.badLane }, ctx());
    const mpc = plushCatchGame.getStateForPlayer(state, 'm') as { plushLane: number };
    state = plushCatchGame.handleMpcAction(state, { kind: 'move', lane: mpc.plushLane }, ctx());
    state = plushCatchGame.handleMpcAction(state, { kind: 'catch', lane: mpc.plushLane }, ctx());
    expect((plushCatchGame.getStateForPlayer(state, 'm') as { caught: number; shields: number })).toMatchObject({ caught: 1, shields: 1 });
  });
});
