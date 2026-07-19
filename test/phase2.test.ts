import { describe, expect, it } from 'vitest';
import { abilityPowerForRarity } from '../src/shared/abilities';
import { decodeClientMessage } from '../src/shared/protocol';
import type { Plushie } from '../src/shared/game';
import { braveReduction, greedyBonus, guardianReduction, luckyCharmBonus } from '../src/server/engine/abilities';
import { pickCruelty, sacrificeCandidates } from '../src/server/engine/cruelty';
import { DURATIONS, initialGameState, normalizeGameState, projectFor, reduce, type EnginePlayer, type GameState } from '../src/server/engine/engine';
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

  it('validates both The Deal choices at the protocol boundary', () => {
    expect(decodeClientMessage(JSON.stringify({ type: 'cruelty.choose', choice: 'sacrifice' })).ok).toBe(true);
    expect(decodeClientMessage(JSON.stringify({ type: 'cruelty.choose', choice: 'harder' })).ok).toBe(true);
    expect(decodeClientMessage(JSON.stringify({ type: 'cruelty.choose', choice: 'nuts' })).ok).toBe(true);
    expect(decodeClientMessage(JSON.stringify({ type: 'cruelty.choose', choice: 'teeth' })).ok).toBe(true);
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

  it('projects no active effects without unbanked abilities', () => {
    const view = projectFor({ ...initialGameState(), phase: 'risk_voting', players, round: 1 }, 'p1');
    expect(view.activeEffects).toEqual({ brave: null, guardian: null, greedy: null, lucky: null });
  });

  it('projects active effects from the gameplay ability helpers with their floors and caps', () => {
    const state: GameState = {
      ...initialGameState(),
      phase: 'risk_voting',
      players,
      round: 3,
      roundModifiers: { difficultyBonus: 0, forcedMpcId: null, disableSupport: false },
      unbanked: [
        plushie('brave', 1, 'brave_heart', 2),
        plushie('guardian', 1, 'guardian', 2),
        plushie('greedy', 1, 'greedy_bastard', 2),
        plushie('lucky', 1, 'lucky_charm', 2),
      ],
    };
    const effects = projectFor(state, 'p1').activeEffects;
    expect(effects.brave).toEqual({ reduction: 2, baseDifficulty: 4, effectiveDifficulty: 2 });
    expect(effects.guardian).toMatchObject({ reduction: 0.1, baseChance: 0.55 });
    expect(effects.guardian?.effectiveChance).toBeCloseTo(0.45);
    expect(effects.greedy).toEqual({ bonus: 2 });
    expect(effects.lucky).toEqual({ bonus: 0.2, baseChance: 0.35, effectiveChance: 0.55 });

    const roundTwoGuardian = projectFor({ ...state, round: 2 }, 'p1').activeEffects.guardian;
    expect(roundTwoGuardian).toMatchObject({ reduction: 0.1, baseChance: 0.45 });
    expect(roundTwoGuardian?.effectiveChance).toBeCloseTo(0.35);

    const capped = projectFor({
      ...state,
      round: 1,
      unbanked: [
        plushie('brave-cap', 1, 'brave_heart', 3),
        plushie('guardian-cap', 1, 'guardian', 8),
        plushie('greedy-cap', 1, 'greedy_bastard', 8),
        plushie('lucky-cap', 1, 'lucky_charm', 8),
      ],
    }, 'p1').activeEffects;
    expect(capped.brave).toEqual({ reduction: 3, baseDifficulty: 2, effectiveDifficulty: 1 });
    expect(capped.guardian).toEqual({ reduction: 0.25, baseChance: 0.35, effectiveChance: 0.1 });
    expect(capped.greedy).toEqual({ bonus: 6 });
    expect(capped.lucky).toMatchObject({ bonus: 0.3, baseChance: 0.35 });
    expect(capped.lucky?.effectiveChance).toBeCloseTo(0.65);
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

  it('keeps the run save when Last Chance succeeds', () => {
    let state = apply(failedResolution(), { type: 'tick' }, 1_001, 0.99);
    state = apply(state, { type: 'lastChanceHit', playerId: 'p2', attemptId: 1, elapsedMs: 200 }, 1_201);
    expect(state.runSaveTokens).toBe(1);
  });

  it('reassigns the attempt when the selected hero disconnects', () => {
    let state = apply(failedResolution(), { type: 'tick' }, 1_001, 0.99);
    state = apply(state, { type: 'syncPlayers', players: [players[0], { ...players[1], connected: false }] }, 1_010, 0.99);
    expect(state.phase).toBe('last_chance');
    expect(state.lastChance?.playerId).toBe('p1');
    expect(state.lastChance?.attemptId).toBe(2);
  });
});

describe('Run Save', () => {
  function failedCollection(unbanked: Plushie[], runSaveTokens = 1, lastChanceUsed = true): GameState {
    const target = plushie('bubbles', 8);
    return {
      ...initialGameState(), phase: 'round_resolution', players, mpcId: 'p1', currentPlushie: target, unbanked,
      outcome: { success: false, headline: 'Doomed', mpcId: 'p1', plushie: target }, deadline: 1_000,
      runSaveTokens, lastChanceUsed,
    };
  }

  it('starts each run with one token and restores the default for an older persisted room', () => {
    let state = apply(initialGameState(), { type: 'syncPlayers', players }, 0);
    state = apply(state, { type: 'start', byPlayerId: 'p1' }, 0);
    expect(state.runSaveTokens).toBe(1);
    const oldState = { ...initialGameState(), runSaveTokens: undefined } as unknown as GameState;
    expect(normalizeGameState(oldState).runSaveTokens).toBe(1);
    expect(projectFor(state, 'p1').runSaveTokens).toBe(1);
  });

  it('does not consume a token when the run has no collection to protect', () => {
    const next = apply(failedCollection([]), { type: 'tick' }, 1_001);
    expect(next.phase).toBe('run_failed');
    expect(next.runSaveTokens).toBe(1);
  });

  it('protects the existing collection, not the plushie that just failed', () => {
    const next = apply(failedCollection([plushie('kevin', 4), plushie('waddles', 2)]), { type: 'tick' }, 1_001);
    expect(next.phase).toBe('run_saved');
    expect(next.runSaveTokens).toBe(0);
    expect(next.unbanked.map((item) => item.id)).toEqual(['kevin', 'waddles']);
    expect(next.unbanked.some((item) => item.id === 'bubbles')).toBe(false);
  });

  it('moves from the saved beat into Bank/Risk and then supports either choice', () => {
    let state = apply(failedCollection([plushie('kevin', 4)]), { type: 'tick' }, 1_001);
    state = apply(state, { type: 'tick' }, state.deadline! + 1);
    expect(state.phase).toBe('risk_voting');
    state = apply(state, { type: 'riskVote', voterId: 'p1', choice: 'bank' }, 8_000);
    state = apply(state, { type: 'riskVote', voterId: 'p2', choice: 'bank' }, 8_000);
    expect(state.phase).toBe('run_complete');
    expect(state.trophies.map((item) => item.id)).toEqual(['kevin']);

    state = apply(failedCollection([plushie('waddles', 2)]), { type: 'tick' }, 1_001);
    state = apply(state, { type: 'tick' }, state.deadline! + 1);
    state = apply(state, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 8_000, 0);
    state = apply(state, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 8_000, 0);
    expect(state.phase).toBe('stakes');
    expect(state.runSaveTokens).toBe(0);
  });

  it('turns a second collection failure into a normal catastrophic loss', () => {
    const next = apply(failedCollection([plushie('kevin', 4)], 0), { type: 'tick' }, 1_001);
    expect(next.phase).toBe('run_failed');
    expect(next.unbanked).toEqual([]);
    expect(next.runSummary?.plushies.map((item) => item.id)).toEqual(['kevin']);
  });

  it('resets the token for the next run after a run ends', () => {
    const ended = { ...initialGameState(), phase: 'run_complete' as const, players, runSaveTokens: 0, deadline: 1_000 };
    const next = apply(ended, { type: 'tick' }, 1_001);
    expect(next.runSaveTokens).toBe(1);
  });

  it('uses the Run Save after a failed Last Chance', () => {
    let state = apply(failedCollection([plushie('kevin', 4)], 1, false), { type: 'tick' }, 1_001, 0.99);
    expect(state.phase).toBe('last_chance');
    state = apply(state, { type: 'lastChanceHit', playerId: 'p2', attemptId: 1, elapsedMs: 901 }, 1_902);
    expect(state.phase).toBe('run_saved');
    expect(state.runSaveTokens).toBe(0);
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

describe('The Deal routing', () => {
  function dealState(): GameState {
    const hostage = plushie('bubbles', 8);
    return {
      ...initialGameState(), phase: 'cruelty_event', players, previousMpcId: 'p1', unbanked: [hostage],
      cruelty: { kind: 'the_deal', chooserId: 'p2', hostagePlushieId: hostage.id }, deadline: 10_000,
    };
  }

  it('routes sacrifice through the engine and removes only the hostage', () => {
    const state = dealState();
    const next = apply(state, { type: 'crueltyChoice', playerId: 'p2', choice: 'sacrifice' }, 1_000);
    expect(next.phase).toBe('stakes');
    expect(next.unbanked).toEqual([]);
    expect(next.runSaveTokens).toBe(1);
  });

  it('routes harder through the engine and preserves the hostage', () => {
    const state = dealState();
    const next = apply(state, { type: 'crueltyChoice', playerId: 'p2', choice: 'harder' }, 1_000);
    expect(next.phase).toBe('stakes');
    expect(next.unbanked.map((item) => item.id)).toEqual(['bubbles']);
    expect(next.roundModifiers.difficultyBonus).toBe(2);
    // Bubbles' existing Brave Heart remains active, so it offsets one point
    // of the Deal's explicit +2 difficulty modifier.
    expect(next.difficulty).toBe(2);
    expect(next.runSaveTokens).toBe(1);
  });

  it('does not spend the Run Save token for either Nuts or Teeth', () => {
    for (const choice of ['nuts', 'teeth'] as const) {
      const state: GameState = {
        ...initialGameState(), phase: 'cruelty_event', players, unbanked: [plushie('bubbles', 8)],
        cruelty: { kind: 'nuts_or_teeth', chooserId: 'p2' }, deadline: 10_000,
      };
      const next = apply(state, { type: 'crueltyChoice', playerId: 'p2', choice }, 1_000);
      expect(next.runSaveTokens).toBe(1);
    }
  });
});
