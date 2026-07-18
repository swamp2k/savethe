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
// the minigame's random pre-signal delay are reproducible.
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
 *  deadline if one is open. The only minigame the production registry ever
 *  selects is the Reaction Test, so this always lands in its `mpc_ready` stage. */
function toActive(state: GameState): GameState {
  let s = state;
  if (s.phase === 'mpc_voting') s = apply(s, { type: 'tick' }, s.deadline! + 1);
  if (s.phase === 'mpc_selected') s = apply(s, { type: 'tick' }, s.deadline! + 1);
  if (s.phase === 'challenge_intro') s = apply(s, { type: 'tick' }, s.deadline! + 1);
  expect(s.phase).toBe('challenge_active');
  return s;
}

/**
 * Reaction Test driving helpers. Each dispatches the exact ready/tick/click
 * sequence a real client + DO alarm loop would produce, choosing `now` values
 * so the claimed elapsedMs is always self-consistent with the server's
 * arrival-time plausibility check (arrivalDelta === elapsedMs exactly).
 * 150ms is comfortably under the MPC threshold at every difficulty this
 * suite reaches (round 1: 250ms, round 2: 230ms); 900ms is comfortably over;
 * 200ms is comfortably under the fixed 350ms support threshold.
 */
function mpcArmAndAwaitGo(s: GameState, readyAt: number): GameState {
  const armed = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'ready' } }, readyAt);
  const goTime = armed.deadline! + 1;
  return apply(armed, { type: 'tick' }, goTime);
}

/** MPC reacts fast enough for a clean, solo victory. */
function mpcSucceeds(s: GameState, readyAt = 2000, elapsedMs = 150): GameState {
  const atGo = mpcArmAndAwaitGo(s, readyAt);
  const signalAt = atGo.deadline as number; // signalAt equals the tick's `now` (armed.deadline!+1)
  return apply(atGo, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'click', elapsedMs } }, signalAt + elapsedMs);
}

/** MPC reacts too slowly (a valid attempt, not a false start); opens the
 *  support rescue window. Returns state still in CHALLENGE_ACTIVE. */
function mpcMisses(s: GameState, readyAt = 2000): GameState {
  const atGo = mpcArmAndAwaitGo(s, readyAt);
  const signalAt = atGo.deadline as number;
  return apply(atGo, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'click', elapsedMs: 900 } }, signalAt + 900);
}

/** After an MPC miss, let the support race play out with nobody rescuing. */
function noOneRescues(s: GameState): GameState {
  const atSupportGo = apply(s, { type: 'tick' }, s.deadline! + 1); // support_waiting -> support_go
  return apply(atSupportGo, { type: 'tick' }, atSupportGo.deadline! + 1); // timeout -> total_failure
}

/** After an MPC miss, have `rescuerId` make the emergency save. */
function supportRescues(s: GameState, rescuerId: string, elapsedMs = 200): GameState {
  const atSupportGo = apply(s, { type: 'tick' }, s.deadline! + 1); // support_waiting -> support_go
  const signalAt = atSupportGo.deadline as number;
  return apply(
    atSupportGo,
    { type: 'minigameAction', playerId: rescuerId, payload: { kind: 'click', elapsedMs } },
    signalAt + elapsedMs,
  );
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

    // Play the round out (MPC succeeds) and RISK to force a second round.
    s = toActive(s);
    s = mpcSucceeds(s);
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
    s = mpcSucceeds(s);
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
  it('clean victory when the MPC reacts in time', () => {
    let s = toActive(started(2));
    s = mpcSucceeds(s);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.outcome?.savedBy).toBeUndefined();
    expect(s.unbanked).toHaveLength(1);
  });

  it('team rescue when the MPC is too slow but support saves it', () => {
    let s = toActive(started(3));
    const mpc = s.mpcId!;
    const supporter = ['p1', 'p2', 'p3'].find((id) => id !== mpc)!;
    s = mpcMisses(s);
    expect(s.phase).toBe('challenge_active'); // a miss alone doesn't resolve; support can still save
    s = supportRescues(s, supporter);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.outcome?.savedBy).toBe(supporter);
  });

  it('total failure when nobody reacts in time', () => {
    let s = toActive(started(2));
    s = mpcMisses(s);
    s = noOneRescues(s);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(false);
    expect(s.unbanked).toHaveLength(0);
  });
});

describe('bank / risk & the run', () => {
  function toRiskVote(n: number): GameState {
    let s = mpcSucceeds(toActive(started(n)));
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
    let s = mpcSucceeds(toActive(started(2)));
    // RISK once so there is something to lose, then fail the next round.
    s = apply(s, { type: 'tick' }, s.deadline! + 1);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 4000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 4000);
    s = toActive(s);
    s = mpcMisses(s);
    s = noOneRescues(s);
    expect(s.phase).toBe('round_resolution');
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

    const mpcView = projectFor(s, mpc).minigame?.view as { role: string; canReady: boolean };
    expect(mpcView.role).toBe('mpc');
    expect(mpcView.canReady).toBe(true);

    const supportView = projectFor(s, supporter).minigame?.view as { role: string; canReady: boolean };
    expect(supportView.role).toBe('support');
    expect(supportView.canReady).toBe(false);
  });

  it('does not expose the minigame before the challenge is revealed', () => {
    const s = started(3); // mpc_voting
    expect(projectFor(s, 'p1').minigame).toBeNull();
  });

  it('still exposes the minigame during round resolution for a stat reveal', () => {
    const s = mpcSucceeds(toActive(started(2)));
    expect(s.phase).toBe('round_resolution');
    expect(projectFor(s, s.mpcId!).minigame).not.toBeNull();
  });

  it('exposes the ready-gate deadline (not itself a secret) for a client countdown', () => {
    const s = toActive(started(2));
    expect(s.deadline).toBeGreaterThan(1000);
    expect(projectFor(s, s.mpcId!).deadline).toBe(s.deadline);
  });

  it("hides the deadline once armed, without affecting the engine's own alarm schedule", () => {
    let s = toActive(started(2));
    s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'ready' } }, 2000);
    // The real scheduling deadline must still be set (the DO alarm depends on it)...
    expect(s.deadline).not.toBeNull();
    // ...but no player should be able to see it and time a click to the signal.
    expect(projectFor(s, s.mpcId!).deadline).toBeNull();
    for (const p of s.players) expect(projectFor(s, p.playerId).deadline).toBeNull();
  });
});

describe('durations are sane', () => {
  it('every timed phase has a positive duration', () => {
    for (const ms of Object.values(DURATIONS)) expect(ms).toBeGreaterThan(0);
  });
});
