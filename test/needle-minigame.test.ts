import { describe, expect, it } from 'vitest';
import { needlePosition, stopTheNeedleGame } from '../src/server/minigames/needle';
import type { MinigameConfig, MinigameContext } from '../src/server/minigames/contract';

const config: MinigameConfig = { difficulty: 1, mpcId: 'm', supportIds: ['s'] };
const ctx = (now: number, random = 0): MinigameContext => ({ now, random: () => random });
const fresh = () => stopTheNeedleGame.onStart(stopTheNeedleGame.createInitialState(config, ctx(0)), ctx(0));
const view = (state: unknown, id: string) => stopTheNeedleGame.getStateForPlayer(state, id) as { hits: number; requiredHits: number; supportBoosts: number; attempt?: { attemptId: number; zoneWidth: number; periodMs: number } };

describe('Stop the Needle', () => {
  it('uses a triangular sweep', () => {
    expect(needlePosition(0, 1000)).toBe(0);
    expect(needlePosition(250, 1000)).toBe(0.5);
    expect(needlePosition(500, 1000)).toBe(1);
    expect(needlePosition(750, 1000)).toBe(0.5);
  });

  it('scales the required hits, period, zone, and budget within their floors', () => {
    const easy = stopTheNeedleGame.createInitialState(config, ctx(0)) as { requiredHits: number; mpcPeriodMs: number; baseZoneWidth: number; timeBudgetMs: number };
    const hard = stopTheNeedleGame.createInitialState({ ...config, difficulty: 30 }, ctx(0)) as typeof easy;
    expect(easy).toMatchObject({ requiredHits: 3, mpcPeriodMs: 1500, baseZoneWidth: 0.2, timeBudgetMs: 25000 });
    expect(hard).toMatchObject({ requiredHits: 6, mpcPeriodMs: 750, baseZoneWidth: 0.08, timeBudgetMs: 20000 });
  });

  it('increments a correct stop and regenerates the MPC attempt', () => {
    const state = fresh();
    const before = view(state, 'm').attempt!;
    const after = stopTheNeedleGame.handleMpcAction(state, { kind: 'stop', attemptId: before.attemptId, elapsedMs: 150 }, ctx(150));
    expect(view(after, 'm')).toMatchObject({ hits: 1 });
    expect(view(after, 'm').attempt!.attemptId).not.toBe(before.attemptId);
  });

  it('fails a miss, ignores stale and implausible stops, and succeeds after enough hits', () => {
    const state = fresh();
    const attempt = view(state, 'm').attempt!;
    expect(stopTheNeedleGame.handleMpcAction(state, { kind: 'stop', attemptId: attempt.attemptId + 1, elapsedMs: 150 }, ctx(150))).toBe(state);
    expect(stopTheNeedleGame.handleMpcAction(state, { kind: 'stop', attemptId: attempt.attemptId, elapsedMs: 30 }, ctx(30))).toBe(state);
    expect(stopTheNeedleGame.evaluate(stopTheNeedleGame.handleMpcAction(state, { kind: 'stop', attemptId: attempt.attemptId, elapsedMs: 750 }, ctx(750)), ctx(750))).toMatchObject({ success: false });
    let winning = fresh();
    for (let index = 0; index < 3; index += 1) {
      const next = view(winning, 'm').attempt!;
      winning = stopTheNeedleGame.handleMpcAction(winning, { kind: 'stop', attemptId: next.attemptId, elapsedMs: 150 }, ctx(150 + index * 200));
    }
    expect(stopTheNeedleGame.evaluate(winning, ctx(600))).toMatchObject({ success: true });
  });

  it('widens the MPC zone on a support hit and regenerates the support attempt after both outcomes', () => {
    const state = fresh();
    const mpcWidth = view(state, 'm').attempt!.zoneWidth;
    const support = view(state, 's').attempt!;
    const hit = stopTheNeedleGame.handleSupportAction(state, 's', { kind: 'stop', attemptId: support.attemptId, elapsedMs: 150 }, ctx(150));
    expect(view(hit, 'm').attempt!.zoneWidth).toBeGreaterThan(mpcWidth);
    expect(view(hit, 'm').supportBoosts).toBe(1);
    expect(view(hit, 's').attempt!.attemptId).not.toBe(support.attemptId);
    const next = view(hit, 's').attempt!;
    const miss = stopTheNeedleGame.handleSupportAction(hit, 's', { kind: 'stop', attemptId: next.attemptId, elapsedMs: 850 }, ctx(1000));
    expect(view(miss, 'm').supportBoosts).toBe(1);
    expect(view(miss, 's').attempt!.attemptId).not.toBe(next.attemptId);
  });

  it('times out with a fixed fuse and does not project server start times', () => {
    const state = fresh();
    expect(stopTheNeedleGame.getFuse!(state)).toEqual({ deadlineAt: 25000, totalMs: 25000 });
    expect(stopTheNeedleGame.getStateForPlayer(state, 'm')).not.toHaveProperty('attempt.startedAt');
    expect(stopTheNeedleGame.evaluate(stopTheNeedleGame.onDeadline(state, ctx(25000)), ctx(25000))).toMatchObject({ success: false });
  });
});
