import { describe, expect, it } from 'vitest';
import {
  DURATIONS,
  initialGameState,
  projectFor,
  reduce,
  type EngineAction,
  type EnginePlayer,
  type GameState,
} from '../src/server/engine/engine';
import type { MinigameContext } from '../src/server/minigames/contract';

// A deterministic context. `random` returns a fixed value so tie-breaks and
// plushie choices are reproducible.
function ctx(now: number, random = 0): MinigameContext {
  return { now, random: () => random };
}

function makePlayers(n: number): EnginePlayer[] {
  return Array.from({ length: n }, (_, i) => ({
    playerId: `p${i + 1}`,
    nickname: `P${i + 1}`,
    connected: true,
    seat: i,
  }));
}

function apply(state: GameState, action: EngineAction, now: number, random = 0): GameState {
  return reduce(state, action, ctx(now, random));
}

/** Build a started game with `n` players; returns state at the first phase. */
function started(n: number, now = 1000): GameState {
  let s = initialGameState();
  s = apply(s, { type: 'syncPlayers', players: makePlayers(n) }, now);
  s = apply(s, { type: 'start', byPlayerId: 'p1' }, now);
  return s;
}

/** Drive from any post-start phase up to CHALLENGE_ACTIVE, resolving a vote by
 *  deadline if one is open. */
function toActive(state: GameState): GameState {
  let s = state;
  if (s.phase === 'mpc_voting') s = apply(s, { type: 'tick' }, s.deadline! + 1);
  if (s.phase === 'mpc_selected') s = apply(s, { type: 'tick' }, s.deadline! + 1);
  if (s.phase === 'challenge_intro') s = apply(s, { type: 'tick' }, s.deadline! + 1);
  expect(s.phase).toBe('challenge_active');
  return s;
}

describe('lobby & start', () => {
  it('assigns the host to the first player', () => {
    let s = initialGameState();
    s = apply(s, { type: 'syncPlayers', players: makePlayers(3) }, 0);
    expect(s.hostId).toBe('p1');
    expect(s.phase).toBe('lobby');
  });

  it('only the host can start, and only with enough players', () => {
    let s = initialGameState();
    s = apply(s, { type: 'syncPlayers', players: makePlayers(1) }, 0);
    s = apply(s, { type: 'start', byPlayerId: 'p1' }, 0);
    expect(s.phase).toBe('lobby'); // too few players

    s = apply(s, { type: 'syncPlayers', players: makePlayers(3) }, 0);
    s = apply(s, { type: 'start', byPlayerId: 'p2' }, 0);
    expect(s.phase).toBe('lobby'); // not the host

    s = apply(s, { type: 'start', byPlayerId: 'p1' }, 0);
    expect(s.phase).toBe('mpc_voting');
  });
});

describe('MPC selection', () => {
  it('skips voting and alternates the MPC in a 2-player game', () => {
    let s = started(2);
    // Round 1: auto-selects the lowest seat.
    expect(s.phase).toBe('mpc_selected');
    expect(s.mpcId).toBe('p1');

    // Play the round out (MPC saves) and RISK to force a second round.
    s = toActive(s);
    s = apply(s, { type: 'minigameAction', playerId: 'p1', payload: { kind: 'save' } }, 5000);
    expect(s.phase).toBe('round_resolution');
    s = apply(s, { type: 'tick' }, s.deadline! + 1); // -> risk_voting
    expect(s.phase).toBe('risk_voting');
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 6000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 6000);
    // Round 2: previous MPC (p1) excluded -> p2.
    expect(s.phase).toBe('mpc_selected');
    expect(s.mpcId).toBe('p2');
  });

  it('opens a real vote with 3+ players and excludes the previous MPC', () => {
    const s = started(3);
    expect(s.phase).toBe('mpc_voting');
    expect(s.previousMpcId).toBeNull();
    const view = projectFor(s, 'p1');
    expect(view.eligibleIds.sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('tallies votes and selects the winner when everyone has voted', () => {
    let s = started(3);
    s = apply(s, { type: 'mpcVote', voterId: 'p1', candidateId: 'p2' }, 100);
    s = apply(s, { type: 'mpcVote', voterId: 'p2', candidateId: 'p2' }, 100);
    // Not everyone has voted yet.
    expect(s.phase).toBe('mpc_voting');
    expect(projectFor(s, 'p1').mpcVoteTally.p2).toBe(2);
    s = apply(s, { type: 'mpcVote', voterId: 'p3', candidateId: 'p3' }, 100);
    expect(s.phase).toBe('mpc_selected');
    expect(s.mpcId).toBe('p2');
  });

  it('resolves by deadline even if not everyone voted', () => {
    let s = started(3);
    s = apply(s, { type: 'mpcVote', voterId: 'p1', candidateId: 'p3' }, 100);
    s = apply(s, { type: 'tick' }, s.deadline! + 1);
    expect(s.phase).toBe('mpc_selected');
    expect(s.mpcId).toBe('p3'); // only cast vote wins
  });

  it('rejects votes for the excluded previous MPC', () => {
    // Round 2 of a 3-player game: p2 is the previous MPC.
    let s = started(3);
    s = apply(s, { type: 'mpcVote', voterId: 'p1', candidateId: 'p2' }, 100);
    s = apply(s, { type: 'mpcVote', voterId: 'p2', candidateId: 'p2' }, 100);
    s = apply(s, { type: 'mpcVote', voterId: 'p3', candidateId: 'p2' }, 100);
    expect(s.mpcId).toBe('p2');
    s = toActive(s);
    s = apply(s, { type: 'minigameAction', playerId: 'p2', payload: { kind: 'save' } }, 5000);
    s = apply(s, { type: 'tick' }, s.deadline! + 1); // risk_voting
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 6000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 6000);
    s = apply(s, { type: 'riskVote', voterId: 'p3', choice: 'risk' }, 6000);
    expect(s.phase).toBe('mpc_voting');
    expect(s.previousMpcId).toBe('p2');
    // A vote for the excluded previous MPC is ignored.
    s = apply(s, { type: 'mpcVote', voterId: 'p1', candidateId: 'p2' }, 7000);
    expect(projectFor(s, 'p1').mpcVoteTally.p2 ?? 0).toBe(0);
  });
});

describe('the three round outcomes', () => {
  it('clean victory when the MPC saves', () => {
    let s = toActive(started(2));
    const mpc = s.mpcId!;
    s = apply(s, { type: 'minigameAction', playerId: mpc, payload: { kind: 'save' } }, 3000);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.outcome?.savedBy).toBeUndefined();
    expect(s.unbanked).toHaveLength(1);
  });

  it('team rescue when the MPC dooms but support rescues', () => {
    let s = toActive(started(3));
    const mpc = s.mpcId!;
    const supporter = ['p1', 'p2', 'p3'].find((id) => id !== mpc)!;
    s = apply(s, { type: 'minigameAction', playerId: mpc, payload: { kind: 'doom' } }, 3000);
    expect(s.phase).toBe('challenge_active'); // doom alone doesn't resolve; support can still save
    s = apply(s, { type: 'minigameAction', playerId: supporter, payload: { kind: 'rescue' } }, 3100);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.outcome?.savedBy).toBe(supporter);
  });

  it('total failure when nobody saves before the deadline', () => {
    let s = toActive(started(2));
    const mpc = s.mpcId!;
    s = apply(s, { type: 'minigameAction', playerId: mpc, payload: { kind: 'doom' } }, 3000);
    s = apply(s, { type: 'tick' }, s.deadline! + 1); // challenge deadline
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(false);
    expect(s.unbanked).toHaveLength(0);
  });
});

describe('bank / risk & the run', () => {
  function toRiskVote(n: number): GameState {
    let s = toActive(started(n));
    s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'save' } }, 3000);
    s = apply(s, { type: 'tick' }, s.deadline! + 1); // -> risk_voting
    expect(s.phase).toBe('risk_voting');
    return s;
  }

  it('banks unbanked plushies onto the trophy shelf and starts a fresh run', () => {
    let s = toRiskVote(2);
    expect(s.unbanked).toHaveLength(1);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'bank' }, 5000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'bank' }, 5000);
    expect(s.phase).toBe('run_complete');
    expect(s.trophies).toHaveLength(1);
    expect(s.unbanked).toHaveLength(0);
    expect(s.runSummary?.banked).toBe(true);

    // Auto-advances into a new run, keeping the trophy shelf.
    s = apply(s, { type: 'tick' }, s.deadline! + 1);
    expect(s.trophies).toHaveLength(1);
    expect(s.round).toBe(1);
    expect(['mpc_voting', 'mpc_selected']).toContain(s.phase);
  });

  it('risk continues the run and increases difficulty', () => {
    let s = toRiskVote(2);
    expect(s.difficulty).toBe(1);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 5000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 5000);
    expect(s.round).toBe(2);
    expect(s.difficulty).toBe(2);
    // The first plushie is still unbanked and now at risk.
    expect(s.unbanked).toHaveLength(1);
  });

  it('a tied risk vote defaults to BANK', () => {
    let s = toRiskVote(2);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 5000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'bank' }, 5000);
    expect(s.phase).toBe('run_complete'); // tie -> bank
  });

  it('a failed round loses the unbanked collection and ends the run', () => {
    let s = toActive(started(2));
    // RISK once so there is something to lose, then fail the next round.
    s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'save' } }, 3000);
    s = apply(s, { type: 'tick' }, s.deadline! + 1);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 4000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 4000);
    s = toActive(s);
    s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'doom' } }, 6000);
    s = apply(s, { type: 'tick' }, s.deadline! + 1); // challenge deadline -> failure
    s = apply(s, { type: 'tick' }, s.deadline! + 1); // resolution -> run_failed
    expect(s.phase).toBe('run_failed');
    expect(s.runSummary?.banked).toBe(false);
    expect(s.runSummary?.plushies).toHaveLength(1); // the one lost
    expect(s.unbanked).toHaveLength(0);
    expect(s.trophies).toHaveLength(0);
  });
});

describe('per-player projection', () => {
  it('shows the MPC and support different action affordances', () => {
    const s = toActive(started(3));
    const mpc = s.mpcId!;
    const supporter = ['p1', 'p2', 'p3'].find((id) => id !== mpc)!;

    const mpcView = projectFor(s, mpc).minigame?.view as { role: string; canAct: string[] };
    expect(mpcView.role).toBe('mpc');
    expect(mpcView.canAct).toEqual(['save', 'doom']);

    const supportView = projectFor(s, supporter).minigame?.view as { role: string; canAct: string[] };
    expect(supportView.role).toBe('support');
    expect(supportView.canAct).toEqual(['rescue']);
  });

  it('does not expose the minigame before the challenge is revealed', () => {
    const s = started(3); // mpc_voting
    expect(projectFor(s, 'p1').minigame).toBeNull();
  });

  it('exposes the challenge deadline for a client countdown', () => {
    const s = toActive(started(2));
    expect(s.deadline).toBeGreaterThan(2000);
    expect(projectFor(s, s.mpcId!).deadline).toBe(s.deadline);
  });
});

describe('durations are sane', () => {
  it('every timed phase has a positive duration', () => {
    for (const ms of Object.values(DURATIONS)) expect(ms).toBeGreaterThan(0);
  });
});
