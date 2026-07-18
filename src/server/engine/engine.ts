import type { CrueltyState, GameView, Machine, Phase, Plushie, PlayerView, RoundOutcome, RoundModifiers, RunSummary } from '../../shared/game';
import { MIN_PLAYERS } from '../../shared/constants';
import type { MinigameContext, MinigameOutcome } from '../minigames/contract';
import { getMinigame, pickMinigame } from '../minigames/registry';
import { makePlushie } from './plushies';

/**
 * The pure game engine. No I/O, no Workers APIs, no wall-clock, no Math.random:
 * time and randomness arrive via `ctx` (architecture rule 2). It owns the phase
 * state machine, MPC voting, Bank/Risk, and the trophy shelf, and it drives
 * minigames only through the generic plugin contract (rule 3).
 *
 * `reduce(state, action, ctx)` is the single entry point. Every deadline lives
 * in `state.deadline`; the caller (GameRoom) schedules a Durable Object alarm
 * for it and feeds back a `{ type: 'tick' }` action when it fires (rule 5).
 */

export interface EnginePlayer {
  playerId: string;
  nickname: string;
  connected: boolean;
  seat: number;
}

export interface GameState {
  code: string;
  phase: Phase;
  players: EnginePlayer[];
  hostId: string | null;
  runId: number;
  round: number;
  difficulty: number;
  machine: Machine;
  deadline: number | null;
  previousMpcId: string | null;
  mpcId: string | null;
  mpcVotes: Record<string, string>; // voterId -> candidateId
  currentPlushie: Plushie | null;
  unbanked: Plushie[];
  trophies: Plushie[];
  riskVotes: Record<string, 'bank' | 'risk'>;
  cruelty: CrueltyState | null;
  roundModifiers: RoundModifiers;
  activeMinigameId: string | null;
  minigameState: unknown;
  outcome: RoundOutcome | null;
  runSummary: RunSummary | null;
}

export type EngineAction =
  | { type: 'syncPlayers'; players: EnginePlayer[] }
  | { type: 'start'; byPlayerId: string }
  | { type: 'mpcVote'; voterId: string; candidateId: string }
  | { type: 'riskVote'; voterId: string; choice: 'bank' | 'risk' }
  | { type: 'crueltyChoice'; playerId: string; choice: 'sacrifice' | 'harder' | 'nuts' | 'teeth' }
  | { type: 'minigameAction'; playerId: string; payload: unknown }
  | { type: 'tick' };

export const DURATIONS = {
  mpcVote: 30_000,
  mpcSelected: 3_000,
  challengeIntro: 4_000,
  resolution: 6_000,
  riskVote: 30_000,
  stakes: 6_000,
  cruelty: 20_000,
  runEnd: 8_000,
} as const;

export function initialGameState(): GameState {
  return {
    code: '',
    phase: 'lobby',
    players: [],
    hostId: null,
    runId: 0,
    round: 0,
    difficulty: 1,
    machine: 'press',
    deadline: null,
    previousMpcId: null,
    mpcId: null,
    mpcVotes: {},
    currentPlushie: null,
    unbanked: [],
    trophies: [],
    riskVotes: {},
    cruelty: null,
    roundModifiers: { difficultyBonus: 0, forcedMpcId: null, disableSupport: false },
    activeMinigameId: null,
    minigameState: null,
    outcome: null,
    runSummary: null,
  };
}

// --- Reducer -----------------------------------------------------------------

export function reduce(state: GameState, action: EngineAction, ctx: MinigameContext): GameState {
  switch (action.type) {
    case 'syncPlayers':
      return applySync(state, action.players, ctx);
    case 'start':
      return applyStart(state, action.byPlayerId, ctx);
    case 'mpcVote':
      return applyMpcVote(state, action.voterId, action.candidateId, ctx);
    case 'riskVote':
      return applyRiskVote(state, action.voterId, action.choice, ctx);
    case 'crueltyChoice':
      return applyCrueltyChoice(state, action.playerId, action.choice, ctx);
    case 'minigameAction':
      return applyMinigameAction(state, action.playerId, action.payload, ctx);
    case 'tick':
      return applyTick(state, ctx);
  }
}

// --- Player roster -----------------------------------------------------------

function connectedPlayers(state: GameState): EnginePlayer[] {
  return state.players.filter((p) => p.connected);
}

/** Candidates who may become MPC: everyone connected except the previous MPC.
 *  If that would leave nobody, the exclusion is dropped (2-player alternation
 *  edge, or everyone-but-the-previous-MPC disconnected). */
function eligibleCandidates(state: GameState): string[] {
  const connected = connectedPlayers(state).map((p) => p.playerId);
  const eligible = connected.filter((id) => id !== state.previousMpcId);
  return eligible.length > 0 ? eligible : connected;
}

function reassignHost(state: GameState): string | null {
  if (state.hostId && state.players.some((p) => p.playerId === state.hostId)) return state.hostId;
  const ordered = [...state.players].sort((a, b) => a.seat - b.seat);
  const connected = ordered.find((p) => p.connected);
  return (connected ?? ordered[0])?.playerId ?? null;
}

function applySync(state: GameState, players: EnginePlayer[], ctx: MinigameContext): GameState {
  const next: GameState = { ...state, players };
  next.hostId = reassignHost(next);
  // A disconnect may have completed a vote (the last non-voter left).
  if (next.phase === 'mpc_voting' && connectedPlayers(next).length > 0 && everyoneVotedMpc(next)) {
    return resolveMpcVote(next, ctx);
  }
  if (next.phase === 'risk_voting' && connectedPlayers(next).length > 0 && everyoneVotedRisk(next)) {
    return resolveRiskVote(next, ctx);
  }
  return next;
}

// --- Start / run / round setup ----------------------------------------------

function applyStart(state: GameState, byPlayerId: string, ctx: MinigameContext): GameState {
  if (state.phase !== 'lobby') return state;
  if (byPlayerId !== state.hostId) return state;
  if (connectedPlayers(state).length < MIN_PLAYERS) return state;
  return beginRun(state, ctx);
}

function beginRun(state: GameState, ctx: MinigameContext): GameState {
  const next: GameState = {
    ...state,
    runId: state.runId + 1,
    round: 0,
    difficulty: 1,
    machine: ctx.random() < 0.5 ? 'press' : 'cannon',
    unbanked: [],
    previousMpcId: null,
    mpcId: null,
    mpcVotes: {},
    riskVotes: {},
    cruelty: null,
    roundModifiers: { difficultyBonus: 0, forcedMpcId: null, disableSupport: false },
    outcome: null,
    runSummary: null,
  };
  // Round 1 has nothing at risk yet, so it skips straight to MPC voting
  // rather than showing a stakes beat (that's reserved for rounds reached
  // via a RISK vote — see resolveRiskVote).
  return enterMpcVoting(setupRound(next, ctx), ctx);
}

/** Round-init only: increments round/difficulty, assigns the new plushie,
 *  resets per-round vote/challenge state. Callers decide what phase follows
 *  (straight to MPC voting for a run's first round, or a stakes beat first
 *  for a round reached via RISK). */
function setupRound(state: GameState, ctx: MinigameContext): GameState {
  const round = state.round + 1;
  return {
    ...state,
    round,
    difficulty: round + state.roundModifiers.difficultyBonus,
    currentPlushie: makePlushie(`${state.runId}-${round}`, round, ctx.random),
    mpcId: null,
    mpcVotes: {},
    riskVotes: {},
    outcome: null,
    activeMinigameId: null,
    minigameState: null,
  };
}

function enterStakes(state: GameState, ctx: MinigameContext): GameState {
  return { ...state, phase: 'stakes', deadline: ctx.now + DURATIONS.stakes };
}

function enterMpcVoting(state: GameState, ctx: MinigameContext): GameState {
  if (state.roundModifiers.forcedMpcId && connectedPlayers(state).some((p) => p.playerId === state.roundModifiers.forcedMpcId)) {
    return enterMpcSelected({ ...state, mpcId: state.roundModifiers.forcedMpcId, mpcVotes: {} }, ctx);
  }
  const eligible = eligibleCandidates(state);
  // With two or fewer players (or a single eligible candidate), a vote is
  // meaningless: skip it and auto-alternate the MPC by seat (decision 6).
  if (connectedPlayers(state).length <= 2 || eligible.length === 1) {
    const mpcId = lowestSeat(state, eligible);
    if (mpcId) return enterMpcSelected({ ...state, mpcId, mpcVotes: {} }, ctx);
  }
  return { ...state, phase: 'mpc_voting', mpcVotes: {}, deadline: ctx.now + DURATIONS.mpcVote };
}

/** Deterministic pick: the eligible candidate with the lowest seat. Because the
 *  previous MPC is excluded from `eligible`, this alternates in a 2-player game. */
function lowestSeat(state: GameState, eligible: string[]): string | null {
  const seatOf = new Map(state.players.map((p) => [p.playerId, p.seat]));
  let best: string | null = null;
  let bestSeat = Number.POSITIVE_INFINITY;
  for (const id of eligible) {
    const seat = seatOf.get(id) ?? Number.POSITIVE_INFINITY;
    if (seat < bestSeat) {
      bestSeat = seat;
      best = id;
    }
  }
  return best;
}

function enterMpcSelected(state: GameState, ctx: MinigameContext): GameState {
  return { ...state, phase: 'mpc_selected', deadline: ctx.now + DURATIONS.mpcSelected };
}

function enterChallengeIntro(state: GameState, ctx: MinigameContext): GameState {
  const game = pickMinigame(ctx.random);
  const mpcId = state.mpcId;
  if (!mpcId) return state;
  const supportIds = state.roundModifiers.disableSupport ? [] : connectedPlayers(state)
    .map((p) => p.playerId)
    .filter((id) => id !== mpcId);
  const minigameState = game.createInitialState({ difficulty: state.difficulty, mpcId, supportIds }, ctx);
  return {
    ...state,
    phase: 'challenge_intro',
    activeMinigameId: game.id,
    minigameState,
    roundModifiers: { difficultyBonus: 0, forcedMpcId: null, disableSupport: false },
    deadline: ctx.now + DURATIONS.challengeIntro,
  };
}

function enterChallengeActive(state: GameState, ctx: MinigameContext): GameState {
  const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
  if (!game) return state;
  const started = game.onStart(state.minigameState, ctx);
  return { ...state, phase: 'challenge_active', minigameState: started, deadline: game.getNextDeadline(started) };
}

// --- MPC voting --------------------------------------------------------------

function everyoneVotedMpc(state: GameState): boolean {
  return connectedPlayers(state).every((p) => p.playerId in state.mpcVotes);
}

function applyMpcVote(state: GameState, voterId: string, candidateId: string, ctx: MinigameContext): GameState {
  if (state.phase !== 'mpc_voting') return state;
  if (!connectedPlayers(state).some((p) => p.playerId === voterId)) return state;
  if (!eligibleCandidates(state).includes(candidateId)) return state;

  const next: GameState = { ...state, mpcVotes: { ...state.mpcVotes, [voterId]: candidateId } };
  if (everyoneVotedMpc(next)) return resolveMpcVote(next, ctx);
  return next;
}

function resolveMpcVote(state: GameState, ctx: MinigameContext): GameState {
  const eligible = eligibleCandidates(state);
  if (eligible.length === 0) return state; // nobody connected; wait

  const tally = new Map<string, number>(eligible.map((id) => [id, 0]));
  for (const candidateId of Object.values(state.mpcVotes)) {
    if (tally.has(candidateId)) tally.set(candidateId, (tally.get(candidateId) ?? 0) + 1);
  }
  const max = Math.max(...tally.values());
  const top = [...tally.entries()].filter(([, n]) => n === max).map(([id]) => id);
  // Deterministic tie-break: random among the tied (or among all eligible if no
  // votes were cast — max is 0 and every eligible candidate is "tied").
  const mpcId = top[Math.floor(ctx.random() * top.length)];
  return enterMpcSelected({ ...state, mpcId, mpcVotes: state.mpcVotes }, ctx);
}

// --- Challenge ---------------------------------------------------------------

function applyMinigameAction(state: GameState, playerId: string, payload: unknown, ctx: MinigameContext): GameState {
  if (state.phase !== 'challenge_active') return state;
  const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
  if (!game) return state;

  const isMpc = playerId === state.mpcId;
  const isConnected = connectedPlayers(state).some((p) => p.playerId === playerId);
  if (!isMpc && !isConnected) return state;

  const minigameState = isMpc
    ? game.handleMpcAction(state.minigameState, payload, ctx)
    : game.handleSupportAction(state.minigameState, playerId, payload, ctx);

  const outcome = game.evaluate(minigameState, ctx);
  const advanced: GameState = { ...state, minigameState };
  if (outcome.status === 'resolved') return enterResolution(advanced, outcome, ctx);
  return { ...advanced, deadline: game.getNextDeadline(minigameState) };
}

function enterResolution(state: GameState, outcome: MinigameOutcome & { status: 'resolved' }, ctx: MinigameContext): GameState {
  const plushie = state.currentPlushie;
  const mpcId = state.mpcId ?? '';
  const roundOutcome: RoundOutcome = {
    success: outcome.success,
    headline: outcome.headline,
    mpcId,
    savedBy: outcome.savedBy,
    plushie: plushie ?? { id: '', species: '', emoji: '❓', name: 'Unknown', rarity: 'common', value: 1 },
  };
  const unbanked = outcome.success && plushie ? [...state.unbanked, plushie] : state.unbanked;
  return {
    ...state,
    phase: 'round_resolution',
    outcome: roundOutcome,
    unbanked,
    previousMpcId: state.mpcId,
    deadline: ctx.now + DURATIONS.resolution,
  };
}

// --- Bank / Risk -------------------------------------------------------------

function everyoneVotedRisk(state: GameState): boolean {
  return connectedPlayers(state).every((p) => p.playerId in state.riskVotes);
}

function enterRiskVoting(state: GameState, ctx: MinigameContext): GameState {
  return { ...state, phase: 'risk_voting', riskVotes: {}, deadline: ctx.now + DURATIONS.riskVote };
}

function applyRiskVote(state: GameState, voterId: string, choice: 'bank' | 'risk', ctx: MinigameContext): GameState {
  if (state.phase !== 'risk_voting') return state;
  if (!connectedPlayers(state).some((p) => p.playerId === voterId)) return state;

  const next: GameState = { ...state, riskVotes: { ...state.riskVotes, [voterId]: choice } };
  if (everyoneVotedRisk(next)) return resolveRiskVote(next, ctx);
  return next;
}

function resolveRiskVote(state: GameState, ctx: MinigameContext): GameState {
  let bank = 0;
  let risk = 0;
  for (const choice of Object.values(state.riskVotes)) {
    if (choice === 'risk') risk += 1;
    else bank += 1;
  }
  // RISK needs a strict majority of votes cast; tie or all-abstain -> BANK.
  if (risk > bank) return maybeEnterCruelty(state, ctx);
  return enterRunComplete(state, ctx);
}

function maybeEnterCruelty(state: GameState, ctx: MinigameContext): GameState {
  const chance = state.round >= 4 ? 0.65 : 0.25 + state.round * 0.1;
  // High random values trigger: this keeps the existing deterministic test
  // context (`random() === 0`) on the ordinary RISK path while preserving the
  // specified probability distribution for injected uniform RNGs.
  if (ctx.random() <= 1 - chance) return enterStakes(setupRound(state, ctx), ctx);
  const players = connectedPlayers(state).filter((p) => p.playerId !== state.previousMpcId);
  const chooser = (players.length ? players : connectedPlayers(state))[Math.floor(ctx.random() * (players.length || connectedPlayers(state).length))];
  if (!chooser) return enterStakes(setupRound(state, ctx), ctx);
  const kind = ctx.random() < 0.5 ? 'the_deal' : 'nuts_or_teeth';
  const hostage = [...state.unbanked].sort((a, b) => b.value - a.value)[0];
  return { ...state, phase: 'cruelty_event', cruelty: { kind, chooserId: chooser.playerId, hostagePlushieId: hostage?.id }, deadline: ctx.now + DURATIONS.cruelty };
}

function applyCrueltyChoice(state: GameState, playerId: string, choice: 'sacrifice' | 'harder' | 'nuts' | 'teeth', ctx: MinigameContext): GameState {
  if (state.phase !== 'cruelty_event' || state.cruelty?.chooserId !== playerId) return state;
  const event = state.cruelty;
  if (event.kind === 'the_deal' && (choice === 'sacrifice' || choice === 'harder')) {
    const unbanked = choice === 'sacrifice' ? state.unbanked.filter((p) => p.id !== event.hostagePlushieId) : state.unbanked;
    const roundModifiers = choice === 'harder' ? { ...state.roundModifiers, difficultyBonus: state.roundModifiers.difficultyBonus + 2 } : state.roundModifiers;
    return enterStakes(setupRound({ ...state, unbanked, roundModifiers, cruelty: null }, ctx), ctx);
  }
  if (event.kind === 'nuts_or_teeth' && (choice === 'nuts' || choice === 'teeth')) {
    const roundModifiers = choice === 'nuts' ? { ...state.roundModifiers, forcedMpcId: playerId, difficultyBonus: state.roundModifiers.difficultyBonus + 1 } : { ...state.roundModifiers, disableSupport: true };
    return enterStakes(setupRound({ ...state, roundModifiers, cruelty: null }, ctx), ctx);
  }
  return state;
}

function enterRunComplete(state: GameState, ctx: MinigameContext): GameState {
  const summary: RunSummary = { banked: true, rounds: state.round, plushies: state.unbanked };
  return {
    ...state,
    phase: 'run_complete',
    trophies: [...state.trophies, ...state.unbanked],
    unbanked: [],
    runSummary: summary,
    deadline: ctx.now + DURATIONS.runEnd,
  };
}

function enterRunFailed(state: GameState, ctx: MinigameContext): GameState {
  const summary: RunSummary = { banked: false, rounds: state.round, plushies: state.unbanked };
  return { ...state, phase: 'run_failed', unbanked: [], runSummary: summary, deadline: ctx.now + DURATIONS.runEnd };
}

// --- Tick (deadline elapsed) -------------------------------------------------

function applyTick(state: GameState, ctx: MinigameContext): GameState {
  if (state.deadline === null || ctx.now < state.deadline) return state;

  switch (state.phase) {
    case 'mpc_voting':
      return resolveMpcVote(state, ctx);
    case 'mpc_selected':
      return enterChallengeIntro(state, ctx);
    case 'challenge_intro':
      return enterChallengeActive(state, ctx);
    case 'challenge_active': {
      const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
      if (!game) return state;
      const minigameState = game.onDeadline(state.minigameState, ctx);
      const outcome = game.evaluate(minigameState, ctx);
      const advanced: GameState = { ...state, minigameState };
      if (outcome.status === 'resolved') return enterResolution(advanced, outcome, ctx);
      return { ...advanced, deadline: game.getNextDeadline(minigameState) };
    }
    case 'round_resolution':
      return state.outcome?.success ? enterRiskVoting(state, ctx) : enterRunFailed(state, ctx);
    case 'risk_voting':
      return resolveRiskVote(state, ctx);
    case 'cruelty_event':
      return applyCrueltyChoice(state, state.cruelty?.chooserId ?? '', state.cruelty?.kind === 'the_deal' ? 'harder' : 'teeth', ctx);
    case 'stakes':
      return enterMpcVoting(state, ctx);
    case 'run_complete':
    case 'run_failed':
      return beginRun(state, ctx);
    case 'lobby':
      return state;
  }
}

// --- Per-player projection ---------------------------------------------------

export function projectFor(state: GameState, viewerId: string, now = 0): GameView {
  const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
  const showMinigame =
    game != null &&
    (state.phase === 'challenge_intro' ||
      state.phase === 'challenge_active' ||
      state.phase === 'round_resolution');

  // Some minigames' fairness depends on a surprise signal (e.g. a reaction
  // test's random pre-signal delay). Showing the generic countdown for those
  // would leak exactly when that signal fires; let the minigame suppress it.
  const hideDeadline =
    state.phase === 'challenge_active' && game != null && (game.isDeadlineHidden?.(state.minigameState) ?? false);

  // The burning-fuse pressure bar: only while the challenge is live, and only
  // for minigames that expose a stable, non-secret overall budget.
  const rawFuse =
    state.phase === 'challenge_active' && game != null
      ? (game.getFuse?.(state.minigameState) ?? null)
      : null;
  const fuse = rawFuse ? { remainingMs: Math.max(0, rawFuse.deadlineAt - now), totalMs: rawFuse.totalMs } : null;

  const mpcVoteTally: Record<string, number> = {};
  for (const candidateId of Object.values(state.mpcVotes)) {
    mpcVoteTally[candidateId] = (mpcVoteTally[candidateId] ?? 0) + 1;
  }

  let bank = 0;
  let risk = 0;
  for (const choice of Object.values(state.riskVotes)) {
    if (choice === 'risk') risk += 1;
    else bank += 1;
  }

  const players: PlayerView[] = [...state.players]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => ({ playerId: p.playerId, nickname: p.nickname, connected: p.connected, seat: p.seat }));

  return {
    code: state.code,
    phase: state.phase,
    round: state.round,
    difficulty: state.difficulty,
    machine: state.machine,
    youId: viewerId,
    hostId: state.hostId,
    players,
    deadlineRemainingMs: hideDeadline || state.deadline === null ? null : Math.max(0, state.deadline - now),
    fuse,
    mpcId: state.mpcId,
    previousMpcId: state.previousMpcId,
    eligibleIds: state.phase === 'mpc_voting' ? eligibleCandidates(state) : [],
    mpcVoteTally,
    yourMpcVote: state.mpcVotes[viewerId] ?? null,
    currentPlushie: state.currentPlushie,
    unbanked: state.unbanked,
    trophies: state.trophies,
    riskTally: { bank, risk },
    yourRiskVote: state.riskVotes[viewerId] ?? null,
    cruelty: state.cruelty,
    minigame:
      showMinigame && game
        ? { id: game.id, title: game.title, view: game.getStateForPlayer(state.minigameState, viewerId) }
        : null,
    outcome: state.outcome,
    runSummary: state.runSummary,
  };
}
