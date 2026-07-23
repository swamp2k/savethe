import { describe, expect, it } from 'vitest';
import {
  DURATIONS,
  initialGameState,
  normalizeGameState,
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
 *  deadline if one is open. `random` defaults to 0, which always lands on the
 *  first entry in the weighted selectable pool (the Reaction Test) — most of
 *  this file exercises that game specifically via its `mpc_ready` stage. */
function toActive(state: GameState, minigameId: string | null = 'reaction', minigameRandom = 0): GameState {
  let s = throughStakes(state);
  if (s.phase === 'mpc_voting') s = apply(s, { type: 'tick' }, s.deadline! + 1);
  // The combined MPC/challenge reveal has already drawn a game. Override the
  // selected ID when a test needs a specific plugin, then one tick starts it.
  if (s.phase === 'mpc_selected') s = apply(minigameId === null ? s : { ...s, activeMinigameId: minigameId }, { type: 'tick' }, s.deadline! + 1, minigameRandom);
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
 * suite reaches (round 1: 250ms, round 2: 240ms); 900ms is comfortably over;
 * 200ms is comfortably under the fixed 300ms support threshold.
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

/** A round reached via a RISK vote passes through a stakes recap beat before
 *  the next MPC vote; skip past it by letting its deadline elapse. */
function throughStakes(s: GameState): GameState {
  return s.phase === 'stakes' ? apply(s, { type: 'tick' }, s.deadline! + 1) : s;
}

/** A successful resolution now deliberately pauses for attachment: the naming
 * beat must complete (or time out) before Bank/Risk opens. */
function throughNaming(s: GameState): GameState {
  expect(s.phase).toBe('round_resolution');
  s = apply(s, { type: 'tick' }, s.deadline! + 1);
  expect(s.phase).toBe('plushie_naming');
  return apply(s, { type: 'namePlushie', playerId: s.namingPlayerId!, name: s.currentPlushie!.name }, s.deadline! - 1);
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
  it('migrates an older persisted room without losing previous or current MPC service', () => {
    const legacy = JSON.parse(JSON.stringify({
      ...started(2),
      previousMpcId: 'p2',
      activeMinigameId: null,
      minigameState: null,
    })) as Omit<GameState, 'mpcCyclePlayerIds'> & { mpcCyclePlayerIds?: string[] };
    delete legacy.mpcCyclePlayerIds;
    const restored = normalizeGameState(legacy as GameState);
    expect(restored.mpcCyclePlayerIds).toEqual(['p2', 'p1']);
    const active = apply(restored, { type: 'tick' }, restored.deadline! + 1);
    expect(active.phase).toBe('challenge_active');
    expect(active.activeMinigameId).not.toBeNull();
  });

  it('skips voting and alternates the MPC in a 2-player game', () => {
    let s = started(2);
    // Round 1: auto-selects the lowest seat.
    expect(s.phase).toBe('mpc_selected');
    expect(s.mpcId).toBe('p1');

    // Play the round out (MPC succeeds) and RISK to force a second round.
    s = toActive(s);
    s = mpcSucceeds(s);
    expect(s.phase).toBe('round_resolution');
    s = throughNaming(s);
    expect(s.phase).toBe('risk_voting');
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 6000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 6000);
    expect(s.phase).toBe('stakes');
    s = throughStakes(s);
    // Round 2: previous MPC (p1) excluded -> p2.
    expect(s.phase).toBe('mpc_selected');
    expect(s.mpcId).toBe('p2');
  });

  it('opens a real vote with 3+ players and offers the unserved rotation pool', () => {
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

  it('rejects votes for anyone already served in the current cycle', () => {
    // Round 2 of a 3-player game: p2 is the previous MPC.
    let s = started(3);
    s = apply(s, { type: 'mpcVote', voterId: 'p1', candidateId: 'p2' }, 100);
    s = apply(s, { type: 'mpcVote', voterId: 'p2', candidateId: 'p2' }, 100);
    s = apply(s, { type: 'mpcVote', voterId: 'p3', candidateId: 'p2' }, 100);
    expect(s.mpcId).toBe('p2');
    s = toActive(s);
    s = mpcSucceeds(s);
    s = throughNaming(s);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 6000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 6000);
    s = apply(s, { type: 'riskVote', voterId: 'p3', choice: 'risk' }, 6000);
    s = throughStakes(s);
    expect(s.phase).toBe('mpc_voting');
    expect(s.previousMpcId).toBe('p2');
    // A vote for the excluded previous MPC is ignored.
    s = apply(s, { type: 'mpcVote', voterId: 'p1', candidateId: 'p2' }, 7000);
    expect(projectFor(s, 'p1').mpcVoteTally.p2 ?? 0).toBe(0);
  });

  function voteFor(state: GameState, candidateId: string, now: number): GameState {
    let next = state;
    for (const player of next.players.filter((entry) => entry.connected)) {
      next = apply(next, { type: 'mpcVote', voterId: player.playerId, candidateId }, now);
    }
    return next;
  }

  function openNextSelection(state: GameState, now: number): GameState {
    return apply({ ...state, phase: 'stakes', deadline: now, mpcId: null, mpcVotes: {} }, { type: 'tick' }, now);
  }

  it('alternates two players across a full cycle', () => {
    let s = started(2);
    expect(s.mpcId).toBe('p1');
    s = openNextSelection(s, 2_000);
    expect(s.mpcId).toBe('p2');
    s = openNextSelection(s, 3_000);
    expect(s.mpcId).toBe('p1');
  });

  it('rotates all three players before a repeat', () => {
    let s = voteFor(started(3), 'p2', 1_100);
    expect(s.mpcCyclePlayerIds).toEqual(['p2']);
    s = voteFor(openNextSelection(s, 2_000), 'p3', 2_100);
    s = openNextSelection(s, 3_000);
    expect(s.mpcId).toBe('p1');
    expect(s.mpcCyclePlayerIds).toEqual(['p2', 'p3', 'p1']);
    s = openNextSelection(s, 4_000);
    expect(projectFor(s, 'p1').eligibleIds.sort()).toEqual(['p1', 'p2', 'p3']);
  });

  it('rotates all four players before a repeat', () => {
    let s = voteFor(started(4), 'p4', 1_100);
    s = voteFor(openNextSelection(s, 2_000), 'p2', 2_100);
    s = voteFor(openNextSelection(s, 3_000), 'p3', 3_100);
    s = openNextSelection(s, 4_000);
    expect(s.mpcId).toBe('p1');
    expect(s.mpcCyclePlayerIds).toEqual(['p4', 'p2', 'p3', 'p1']);
    s = openNextSelection(s, 5_000);
    expect(projectFor(s, 'p1').eligibleIds.sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('skips a disconnected unserved player, then includes them after reconnect', () => {
    let s = voteFor(started(3), 'p1', 1_100);
    const disconnected = makePlayers(3).map((player) => player.playerId === 'p2' ? { ...player, connected: false } : player);
    s = apply(s, { type: 'syncPlayers', players: disconnected }, 1_500);
    s = openNextSelection(s, 2_000);
    expect(s.mpcId).toBe('p3');
    s = apply(s, { type: 'syncPlayers', players: makePlayers(3) }, 2_500);
    s = openNextSelection(s, 3_000);
    expect(s.mpcId).toBe('p2');
  });

  it('adds a player who joins mid-cycle to the unserved pool', () => {
    let s = voteFor(started(3), 'p1', 1_100);
    s = apply(s, { type: 'syncPlayers', players: makePlayers(4) }, 1_500);
    s = openNextSelection(s, 2_000);
    expect(projectFor(s, 'p1').eligibleIds.sort()).toEqual(['p2', 'p3', 'p4']);
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

describe('fuse projection (challenge time-pressure bar)', () => {
  it('projects the overall budget as a fuse for a budget-based minigame (aim)', () => {
    const s = toActive(started(2), 'aim');
    expect(s.activeMinigameId).toBe('aim');
    const view = projectFor(s, s.mpcId!, (s.minigameState as { deadlineForChallenge: number }).deadlineForChallenge - 7_000);
    expect(view.fuse).not.toBeNull();
    expect(view.fuse!.totalMs).toBe(22_000);
    expect(view.fuse!.remainingMs).toBe(7_000);
    // The jittery per-target deadline stays hidden even though the fuse shows.
    expect(view.deadlineRemainingMs).toBeNull();
  });

  it('projects no fuse for a secret-timing minigame (reaction)', () => {
    const s = toActive(started(2));
    expect(s.activeMinigameId).toBe('reaction');
    expect(projectFor(s, s.mpcId!).fuse).toBeNull();
  });

  it('projects no fuse outside challenge_active', () => {
    const s = started(2);
    expect(projectFor(s, 'p1').fuse).toBeNull();
  });
});

describe('minigame selection (M4 exit criteria: both minigames playable, no engine changes)', () => {
  it('keeps a serialized bag through reconnect normalization and a new run', () => {
    let seeded = apply(initialGameState(), { type: 'syncPlayers', players: makePlayers(2) }, 1_000);
    seeded = {
      ...seeded,
      minigameBag: ['typing', 'aim'],
      lastMinigameId: 'reaction',
    };
    const restored = apply(
      normalizeGameState(JSON.parse(JSON.stringify(seeded)) as GameState),
      { type: 'start', byPlayerId: 'p1' },
      1_000,
    );
    const active = toActive(restored, null);
    expect(active.activeMinigameId).toBe('typing');
    expect(active.minigameBag).toEqual(['aim']);

    const nextRun = apply({ ...active, phase: 'run_complete', deadline: 0 }, { type: 'tick' }, 1);
    expect(nextRun.activeMinigameId).toBe('aim');
    expect(nextRun.minigameBag).toEqual([]);
    expect(nextRun.lastMinigameId).toBe('aim');
  });

  it('drives Wire Panic through the generic minigame dispatch', () => {
    let s = toActive(started(2), 'wire');
    expect(s.activeMinigameId).toBe('wire');
    s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'cut', wire: 'red' } }, s.deadline! - 1);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
  });

  it('drives Spelling Panic through the generic minigame dispatch', () => {
    let s = toActive(started(2), 'spelling');
    expect(s.activeMinigameId).toBe('spelling');
    s = apply(s, { type: 'tick' }, s.deadline!);
    s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'submit', word: 'banana' } }, s.deadline! - 1);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
  });

  it('drives Stop the Needle through the generic minigame dispatch', () => {
    let s = toActive(started(2), 'needle');
    expect(s.activeMinigameId).toBe('needle');
    for (let index = 0; index < 3; index += 1) {
      const attemptId = (s.minigameState as { mpcAttempt: { attemptId: number } }).mpcAttempt.attemptId;
      s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'stop', attemptId, elapsedMs: 150 } }, s.deadline! - 1);
    }
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
  });

  it('drives Blind Maze through the generic minigame dispatch', () => {
    let s = toActive(started(2), 'maze');
    expect(s.activeMinigameId).toBe('maze');
    const maze = s.minigameState as { grid: Array<Array<0 | 1>>; position: { x: number; y: number }; goal: { x: number; y: number } };
    const queue = [{ ...maze.position, path: [] as Array<'up' | 'down' | 'left' | 'right'> }];
    const seen = new Set([`${maze.position.x},${maze.position.y}`]);
    const steps = [{ direction: 'up' as const, x: 0, y: -1 }, { direction: 'down' as const, x: 0, y: 1 }, { direction: 'left' as const, x: -1, y: 0 }, { direction: 'right' as const, x: 1, y: 0 }];
    let path: Array<'up' | 'down' | 'left' | 'right'> = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.x === maze.goal.x && current.y === maze.goal.y) { path = current.path; break; }
      for (const step of steps) {
        const next = { x: current.x + step.x, y: current.y + step.y };
        const key = `${next.x},${next.y}`;
        if (maze.grid[next.y]?.[next.x] === 1 && !seen.has(key)) { seen.add(key); queue.push({ ...next, path: [...current.path, step.direction] }); }
      }
    }
    for (const direction of path) s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'move', direction } }, s.deadline! - 1);
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
  });

  it('can select and fully play the Typing Challenge through the exact same generic dispatch', () => {
    // Six equal-weight entries now (reaction, typing, aim, memory, tetris,
    // platformer); random=0.25 lands on the second one (typing).
    let s = toActive(started(2), 'typing');
    expect(s.activeMinigameId).toBe('typing');

    const mg = projectFor(s, s.mpcId!).minigame;
    expect(mg?.id).toBe('typing');
    const passageWords = (mg!.view as { passageWords: string[] }).passageWords;

    s = apply(
      s,
      { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'type', text: `${passageWords.join(' ')} ` } },
      s.deadline! - 1000, // comfortably before the challenge's own deadline
    );
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.unbanked).toHaveLength(1);
  });

  it('a support word-burst contributes toward a Typing round exactly like any other minigame action', () => {
    let s = toActive(started(3), 'typing');
    expect(s.activeMinigameId).toBe('typing');
    const mpc = s.mpcId!;
    const supporter = ['p1', 'p2', 'p3'].find((id) => id !== mpc)!;

    const supportMg = projectFor(s, supporter).minigame!.view as { myPhraseWords: string[] };
    s = apply(
      s,
      {
        type: 'minigameAction',
        playerId: supporter,
        payload: { kind: 'type', text: `${supportMg.myPhraseWords.join(' ')} ` },
      },
      s.deadline! - 5000,
    );
    const afterSupport = projectFor(s, mpc).minigame!.view as { totalSupportCompletions: number };
    expect(afterSupport.totalSupportCompletions).toBe(1);
    expect(s.phase).toBe('challenge_active'); // one support burst alone doesn't finish the MPC's passage
  });

  it('can select and fully play Aim Trainer through the exact same generic dispatch', () => {
    // Six equal-weight entries (reaction, typing, aim, memory, tetris,
    // platformer); random=0.42 lands on the third one (aim).
    let s = toActive(started(2), 'aim');
    expect(s.activeMinigameId).toBe('aim');

    const required = (projectFor(s, s.mpcId!).minigame!.view as { requiredHits: number }).requiredHits;
    for (let i = 0; i < required; i++) {
      const mg = projectFor(s, s.mpcId!).minigame!.view as { targetId: number };
      const spawnAt = s.deadline! - 1500; // difficulty 1 -> hitThresholdMs 1500
      s = apply(
        s,
        { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'hit', targetId: mg.targetId, elapsedMs: 200 } },
        spawnAt + 200,
      );
    }
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.unbanked).toHaveLength(1);
  });

  it('can select and fully play Memory through the exact same generic dispatch', () => {
    // Six equal-weight entries (reaction, typing, aim, memory, tetris,
    // platformer); random=0.58 lands on the fourth one (memory).
    let s = toActive(started(2), 'memory', 0.58);
    expect(s.activeMinigameId).toBe('memory');

    // Support study/hide has its own earlier alarm. Advance every due study
    // beat until the MPC's longer study phase reaches recall.
    let mg = projectFor(s, s.mpcId!).minigame!.view as {
      stage: string;
      requiredCorrect: number;
      alphabet: string[];
    };
    while (mg.stage === 'study') {
      s = apply(s, { type: 'tick' }, s.deadline! + 1);
      mg = projectFor(s, s.mpcId!).minigame!.view as typeof mg;
    }
    expect(mg.stage).toBe('recall');

    // random=0.58 deterministically picks the same alphabet entry for every
    // symbol in the sequence.
    const symbol = mg.alphabet[Math.floor(0.58 * mg.alphabet.length)];
    for (let i = 0; i < mg.requiredCorrect; i++) {
      s = apply(
        s,
        { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'recall', symbol } },
        s.deadline! - 1000,
      );
    }
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.unbanked).toHaveLength(1);
  });

  it('can select and play Block Fit through the exact same generic dispatch', () => {
    // Six equal-weight entries (reaction, typing, aim, memory, tetris,
    // platformer); random=0.75 lands on the fifth one (tetris).
    let s = toActive(started(2), 'tetris');
    expect(s.activeMinigameId).toBe('tetris');

    const before = projectFor(s, s.mpcId!).minigame!.view as { linesCleared: number };
    s = apply(
      s,
      { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'drop' } },
      s.deadline! - 1000,
    );
    const after = projectFor(s, s.mpcId!).minigame!.view as { linesCleared: number; grid: boolean[][] };
    expect(after.grid.some((row) => row.some(Boolean))).toBe(true); // the piece locked somewhere
    expect(after.linesCleared).toBe(before.linesCleared); // one piece alone can't clear a 6-wide row
    expect(s.phase).toBe('challenge_active');
  });

  it('can select and fully play Obstacle Run through the exact same generic dispatch', () => {
    // Six equal-weight entries (reaction, typing, aim, memory, tetris,
    // platformer); random=0.92 lands on the last one (platformer).
    let s = toActive(started(2), 'platformer', 0.92);
    expect(s.activeMinigameId).toBe('platformer');

    const required = (projectFor(s, s.mpcId!).minigame!.view as { requiredObstacles: number }).requiredObstacles;
    // random=0.92 -> randomObstacleType always returns 'duck'; pass it through
    // on every action too, since each cleared obstacle spawns the next one
    // using that action's own ctx.random (apply()'s default is 0, which would
    // start generating 'jump' obstacles instead after the first response).
    for (let i = 0; i < required; i++) {
      const spawnAt = s.deadline! - 1800; // difficulty 1 -> obstacleWindowMs 1800
      const obstacleId = (projectFor(s, s.mpcId!).minigame!.view as { obstacleId: number }).obstacleId;
      s = apply(
        s,
        {
          type: 'minigameAction',
          playerId: s.mpcId!,
          payload: { kind: 'react', obstacleId, response: 'duck', elapsedMs: 200 },
        },
        spawnAt + 200,
        0.92,
      );
    }
    expect(s.phase).toBe('round_resolution');
    expect(s.outcome?.success).toBe(true);
    expect(s.unbanked).toHaveLength(1);
  });
});

describe('bank / risk & the run', () => {
  function toRiskVote(n: number): GameState {
    let s = mpcSucceeds(toActive(started(n)));
    s = throughNaming(s);
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
    expect(s.mpcId).toBe('p2');
    expect(s.mpcCyclePlayerIds).toEqual(['p1', 'p2']);
  });

  it('risk continues the run and increases difficulty', () => {
    let s = toRiskVote(2);
    expect(s.difficulty).toBe(1);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 5000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 5000);
    expect(s.round).toBe(2);
    // The deterministic first plushie receives Brave Heart, so its active
    // unbanked ability cancels one point of round-two difficulty.
    expect(s.difficulty).toBe(1);
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
    s = throughNaming(s);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 4000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 4000);
    s = toActive(s);
    s = { ...s, runSaveTokens: 0 }; // this test exercises the post-save catastrophic failure path
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

describe('stakes screen', () => {
  it("skips the stakes beat for a run's first round", () => {
    const s = started(2);
    expect(s.phase).toBe('mpc_selected'); // straight in, no stakes
  });

  it('shows a stakes beat before a round reached via RISK, carrying the unbanked plushies', () => {
    let s = mpcSucceeds(toActive(started(2)));
    s = throughNaming(s);
    s = apply(s, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 5000);
    s = apply(s, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 5000);
    expect(s.phase).toBe('stakes');
    expect(s.unbanked).toHaveLength(1); // still at risk
    expect(s.currentPlushie).not.toBeNull(); // the next round's plushie is already assigned
    expect(s.deadline).not.toBeNull();

    s = apply(s, { type: 'tick' }, s.deadline! + 1);
    expect(['mpc_voting', 'mpc_selected']).toContain(s.phase);
  });
});

describe('destruction machine', () => {
  it('randomizes the first run, then alternates without repeating', () => {
    const s = apply(initialGameState(), { type: 'syncPlayers', players: makePlayers(2) }, 0);
    const press = apply(s, { type: 'start', byPlayerId: 'p1' }, 0, 0); // random=0 -> press
    expect(press.machine).toBe('press');
    const cannon = apply(s, { type: 'start', byPlayerId: 'p1' }, 0, 0.99); // random close to 1 -> cannon
    expect(cannon.machine).toBe('cannon');

    const afterBank = apply({ ...press, phase: 'run_complete', deadline: 0 }, { type: 'tick' }, 1, 0);
    expect(afterBank.machine).toBe('cannon');
    const afterFailure = apply({ ...afterBank, phase: 'run_failed', deadline: 1 }, { type: 'tick' }, 2, 0.99);
    expect(afterFailure.machine).toBe('press');

    let run = mpcSucceeds(toActive(press));
    run = throughNaming(run);
    run = apply(run, { type: 'riskVote', voterId: 'p1', choice: 'risk' }, 5000);
    run = apply(run, { type: 'riskVote', voterId: 'p2', choice: 'risk' }, 5000);
    expect(run.machine).toBe('press'); // unchanged mid-run
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

  it("hides the deadline from players from the very start of the challenge, without affecting the engine's own alarm schedule", () => {
    // Even the ready-gate's own countdown is hidden: a ticking number there
    // would misleadingly read as "counting down to the test" when it's
    // really an unrelated AFK safety net, so the Reaction Test hides its
    // deadline throughout, not just during the secret-timing stages.
    let s = toActive(started(2));
    expect(s.deadline).toBeGreaterThan(1000); // the real scheduling deadline is still set
    expect(projectFor(s, s.mpcId!, 1_500).deadlineRemainingMs).toBeNull();

    s = apply(s, { type: 'minigameAction', playerId: s.mpcId!, payload: { kind: 'ready' } }, 2000);
    expect(s.deadline).not.toBeNull(); // still driving the DO alarm...
    expect(projectFor(s, s.mpcId!, 2_000).deadlineRemainingMs).toBeNull(); // ...never shown to any player
    for (const p of s.players) expect(projectFor(s, p.playerId, 2_000).deadlineRemainingMs).toBeNull();
  });

  it('projects normal phase timing as a relative duration for reconnecting clients', () => {
    const s = started(2);
    expect(s.deadline).not.toBeNull();
    const now = s.deadline! - 12_345;
    expect(projectFor(s, 'p1', now).deadlineRemainingMs).toBe(12_345);
  });
});

describe('durations are sane', () => {
  it('compresses non-interactive transitions after the playtest', () => {
    expect(DURATIONS.mpcSelected).toBe(3_500);
    expect(DURATIONS.stakes).toBe(2_500);
    expect(DURATIONS.resolutionSuccess).toBe(4_500);
    expect(DURATIONS.resolutionFailure).toBe(6_500);
    expect(DURATIONS.runEnd).toBe(6_000);
  });

  it('gives successful resolutions 4.5 seconds and failed resolutions 6.5 seconds', () => {
    const actionAt = 10_000;
    let success = toActive(started(2), 'debug');
    success = apply(success, { type: 'minigameAction', playerId: success.mpcId!, payload: { kind: 'save' } }, actionAt);
    expect(success.phase).toBe('round_resolution');
    expect(success.deadline).toBe(actionAt + DURATIONS.resolutionSuccess);

    let failure = toActive(started(2), 'debug');
    const failureAt = failure.deadline! + 1;
    failure = apply(failure, { type: 'tick' }, failureAt);
    expect(failure.phase).toBe('round_resolution');
    expect(failure.deadline).toBe(failureAt + DURATIONS.resolutionFailure);
  });

  it('every timed phase has a positive duration', () => {
    for (const ms of Object.values(DURATIONS)) expect(ms).toBeGreaterThan(0);
  });
});

describe('expired challenge recovery', () => {
  it('safely resolves a hibernated room whose retired minigame no longer exists', () => {
    const active = toActive(started(2), 'debug');
    const recovered = apply(
      { ...active, activeMinigameId: 'retired-game', deadline: 10 },
      { type: 'tick' },
      10,
    );
    expect(recovered.phase).toBe('round_resolution');
    expect(recovered.outcome).toMatchObject({ success: false, headline: expect.stringContaining('unavailable') });
    expect(recovered.deadline).toBeGreaterThan(10);
  });
});
