import { describe, expect, it } from 'vitest';
import { abilityPowerForRarity } from '../src/shared/abilities';
import { decodeClientMessage } from '../src/shared/protocol';
import type { Plushie } from '../src/shared/game';
import { braveReduction, greedyBonus, guardianReduction, luckyCharmBonus } from '../src/server/engine/abilities';
import { pickCruelty, sacrificeCandidates } from '../src/server/engine/cruelty';
import { DURATIONS, initialGameState, projectFor, reduce, type EnginePlayer, type GameState } from '../src/server/engine/engine';
import type { MinigameContext } from '../src/server/minigames/contract';

const players: EnginePlayer[] = [
  { playerId: 'p1', nickname: 'Martin', connected: true, seat: 0 },
  { playerId: 'p2', nickname: 'Lisa', connected: true, seat: 1 },
];

function context(now: number, random = 0): MinigameContext { return { now, random: () => random }; }
function apply(state: GameState, action: Parameters<typeof reduce>[1], now: number, random = 0): GameState { return reduce(state, action, context(now, random)); }
function plushie(id: string, value: number, ability: Plushie['ability'] = 'brave_heart', abilityPower = 1): Plushie {
  return { id, species: 'bear', emoji: '🐻', name: id, rarity: 'common', value, ability, abilityPower };
}

describe('Phase 2 protocol boundary', () => {
  it('trims a valid plushie name and rejects blank, control, and overlong names', () => {
    const valid = decodeClientMessage(JSON.stringify({ type: 'plushie.name', name: '  Kevin  ' }));
    expect(valid.ok && valid.value).toEqual({ type: 'plushie.name', name: 'Kevin' });
    for (const name of ['   ', 'bad\u0000name', 'x'.repeat(25)]) expect(decodeClientMessage(JSON.stringify({ type: 'plushie.name', name })).ok).toBe(false);
  });

  it('validates Last Chance and Sacrifice messages', () => {
    expect(decodeClientMessage(JSON.stringify({ type: 'last_chance.hit', attemptId: 2, elapsedMs: 200 })).ok).toBe(true);
    expect(decodeClientMessage(JSON.stringify({ type: 'last_chance.hit', attemptId: -1, elapsedMs: 200 })).ok).toBe(false);
    expect(decodeClientMessage(JSON.stringify({ type: 'cruelty.sacrifice_vote', plushieId: 'p-1' })).ok).toBe(true);
  });
});

describe('attachment and abilities', () => {
  it('names the rescued plushie consistently and then enters Bank/Risk', () => {
    const target = plushie('kevin', 4);
    const state: GameState = { ...initialGameState(), phase: 'plushie_naming', players, mpcId: 'p1', namingPlayerId: 'p1', currentPlushie: target, unbanked: [target], outcome: { success: true, headline: 'Saved!', mpcId: 'p1', plushie: target }, deadline: 10_000 };
    expect(apply(state, { type: 'namePlushie', playerId: 'p2', name: 'Nope' }, 1_000)).toBe(state);
    const named = apply(state, { type: 'namePlushie', playerId: 'p1', name: 'Kevin' }, 1_000);
    expect(named.phase).toBe('risk_voting');
    expect(named.currentPlushie?.name).toBe('Kevin');
    expect(named.unbanked[0].name).toBe('Kevin');
    expect(named.outcome?.plushie.name).toBe('Kevin');
  });

  it('keeps the generated name when naming times out', () => {
    const target = plushie('generated', 1);
    const state: GameState = { ...initialGameState(), phase: 'plushie_naming', players, mpcId: 'p1', namingPlayerId: 'p1', currentPlushie: target, unbanked: [target], outcome: { success: true, headline: 'Saved!', mpcId: 'p1', plushie: target }, deadline: 1_000 };
    const next = apply(state, { type: 'tick' }, 1_001);
    expect(next.phase).toBe('risk_voting');
    expect(next.currentPlushie?.name).toBe('generated');
  });

  it('calculates active-only ability effects with their caps', () => {
    const active = [plushie('b', 1, 'brave_heart', 3), plushie('g', 1, 'guardian', 8), plushie('r', 1, 'greedy_bastard', 8), plushie('l', 1, 'lucky_charm', 8)];
    expect(braveReduction(active)).toBe(3);
    expect(guardianReduction(active)).toBe(0.25);
    expect(greedyBonus(active)).toBe(6);
    expect(luckyCharmBonus(active)).toBe(0.30);
    expect(braveReduction([])).toBe(0);
    expect(abilityPowerForRarity('common')).toBe(1);
    expect(abilityPowerForRarity('rare')).toBe(2);
    expect(abilityPowerForRarity('legendary')).toBe(3);
  });
});

describe('Last Chance', () => {
  function failedResolution(unbanked: Plushie[] = []): GameState {
    const target = plushie('kevin', 4);
    return { ...initialGameState(), phase: 'round_resolution', players, mpcId: 'p1', currentPlushie: target, unbanked, outcome: { success: false, headline: 'Doomed', mpcId: 'p1', plushie: target }, deadline: 1_000 };
  }

  it('enters once, selects a non-MPC hero, and projects no internal timestamp', () => {
    const entered = apply(failedResolution(), { type: 'tick' }, 1_001, 0.99);
    expect(entered.phase).toBe('last_chance');
    expect(entered.lastChanceUsed).toBe(true);
    expect(entered.lastChance?.playerId).toBe('p2');
    expect(projectFor(entered, 'p1').lastChance).toEqual({ playerId: 'p2', attemptId: 1, windowMs: 900 });
    expect(JSON.stringify(projectFor(entered, 'p1'))).not.toContain('startedAt');
  });

  it('ignores spoofed and implausible hits, accepts fast hits, and awards naming rights', () => {
    let state = apply(failedResolution(), { type: 'tick' }, 1_001, 0.99);
    state = apply(state, { type: 'lastChanceHit', playerId: 'p1', attemptId: 1, elapsedMs: 200 }, 1_201);
    expect(state.phase).toBe('last_chance');
    state = apply(state, { type: 'lastChanceHit', playerId: 'p2', attemptId: 9, elapsedMs: 200 }, 1_201);
    expect(state.phase).toBe('last_chance');
    state = apply(state, { type: 'lastChanceHit', playerId: 'p2', attemptId: 1, elapsedMs: 50 }, 1_201);
    expect(state.phase).toBe('last_chance');
    state = apply(state, { type: 'lastChanceHit', playerId: 'p2', attemptId: 1, elapsedMs: 200 }, 1_201);
    expect(state.phase).toBe('round_resolution');
    expect(state.outcome?.savedBy).toBe('p2');
    expect(state.unbanked).toHaveLength(1);
    state = apply(state, { type: 'tick' }, state.deadline! + 1);
    expect(state.namingPlayerId).toBe('p2');
  });

  it('fails on slow hit and timeout without recursively retriggering', () => {
    let state = apply(failedResolution(), { type: 'tick' }, 1_001, 0.99);
    state = apply(state, { type: 'lastChanceHit', playerId: 'p2', attemptId: 1, elapsedMs: 901 }, 1_902);
    expect(state.phase).toBe('run_failed');
    state = apply(failedResolution(), { type: 'tick' }, 1_001, 0.99);
    state = apply(state, { type: 'tick' }, state.deadline! + 1);
    expect(state.phase).toBe('run_failed');
  });

  it('reassigns the attempt when the selected hero disconnects', () => {
    let state = apply(failedResolution(), { type: 'tick' }, 1_001, 0.99);
    state = apply(state, { type: 'syncPlayers', players: [players[0], { ...players[1], connected: false }] }, 1_010, 0.99);
    expect(state.phase).toBe('last_chance');
    expect(state.lastChance?.playerId).toBe('p1');
    expect(state.lastChance?.attemptId).toBe(2);
  });
});

describe('The Sacrifice', () => {
  function sacrificeState(): GameState {
    const unbanked = [plushie('low', 2), plushie('same-b', 8), plushie('same-a', 8)];
    return { ...initialGameState(), phase: 'cruelty_event', players, unbanked, cruelty: { kind: 'the_sacrifice', stage: 'voting', candidateIds: ['same-a', 'same-b'], votes: {}, sacrificedPlushieId: null, sacrificedPlushie: null }, deadline: 10_000 };
  }

  it('selects the two highest values with stable ID ordering', () => {
    expect(sacrificeCandidates([plushie('b', 8), plushie('a', 8), plushie('low', 2)])).toEqual(['a', 'b']);
    expect(sacrificeCandidates([plushie('only', 1)])).toBeNull();
  });

  it('filters ineligible cruelty events before selection', () => {
    const empty = initialGameState();
    expect(pickCruelty(empty, () => 0)).toBe('nuts_or_teeth');
    expect(pickCruelty({ ...empty, unbanked: [plushie('one', 1)] }, () => 0)).toBe('the_deal');
    expect(pickCruelty({ ...empty, unbanked: [plushie('one', 1), plushie('two', 2)] }, () => 0.99)).toBe('the_sacrifice');
  });

  it('allows replacement votes, hides raw mappings, resolves early, and removes exactly one plushie', () => {
    let state = sacrificeState();
    state = apply(state, { type: 'sacrificeVote', voterId: 'p1', plushieId: 'same-a' }, 1_000);
    state = apply(state, { type: 'sacrificeVote', voterId: 'p1', plushieId: 'same-b' }, 1_001);
    const view = projectFor(state, 'p1');
    expect(view.cruelty?.kind).toBe('the_sacrifice');
    if (view.cruelty?.kind === 'the_sacrifice') {
      expect(view.cruelty.yourVote).toBe('same-b');
      expect(view.cruelty.voteTally).toEqual({ 'same-a': 0, 'same-b': 1 });
      expect(JSON.stringify(view.cruelty)).not.toContain('p1');
    }
    state = apply(state, { type: 'sacrificeVote', voterId: 'p2', plushieId: 'same-b' }, 1_002);
    expect(state.cruelty?.kind).toBe('the_sacrifice');
    if (state.cruelty?.kind === 'the_sacrifice') expect(state.cruelty.stage).toBe('resolved');
    expect(state.unbanked.map((item) => item.id)).toEqual(['low', 'same-a']);
    expect(state.deadline).toBe(1_002 + DURATIONS.sacrificeResolution);
  });

  it('uses injected randomness for a tied or zero-vote deadline', () => {
    let state = sacrificeState();
    state = apply(state, { type: 'tick' }, 10_001, 0.99);
    expect(state.unbanked.map((item) => item.id)).toEqual(['low', 'same-a']);
  });
});
