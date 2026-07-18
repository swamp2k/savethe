import type { CrueltyView, GameView, Machine, Phase, Plushie, PlayerView, RoundOutcome, RoundModifiers, RunSummary } from '../../shared/game';
import { abilityPowerForRarity } from '../../shared/abilities';
import { MIN_PLAYERS } from '../../shared/constants';
import type { MinigameContext, MinigameOutcome } from '../minigames/contract';
import { getMinigame, pickMinigame } from '../minigames/registry';
import { braveReduction, greedyBonus, guardianReduction, luckyCharmBonus } from './abilities';
import { pickCruelty, sacrificeCandidates } from './cruelty';
import { makePlushie } from './plushies';

export interface EnginePlayer { playerId: string; nickname: string; connected: boolean; seat: number; }

type EngineCrueltyState =
  | { kind: 'the_deal'; chooserId: string; hostagePlushieId: string }
  | { kind: 'nuts_or_teeth'; chooserId: string }
  | {
      kind: 'the_sacrifice';
      stage: 'voting' | 'resolved';
      candidateIds: [string, string];
      votes: Record<string, string>;
      sacrificedPlushieId: string | null;
      sacrificedPlushie: Plushie | null;
    };

interface LastChanceState {
  playerId: string;
  attemptId: number;
  startedAt: number;
  windowMs: number;
  outcome: 'pending' | 'success' | 'failure';
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
  mpcVotes: Record<string, string>;
  currentPlushie: Plushie | null;
  unbanked: Plushie[];
  trophies: Plushie[];
  namingPlayerId: string | null;
  riskVotes: Record<string, 'bank' | 'risk'>;
  cruelty: EngineCrueltyState | null;
  roundModifiers: RoundModifiers;
  activeMinigameId: string | null;
  minigameState: unknown;
  outcome: RoundOutcome | null;
  lastChanceUsed: boolean;
  lastChanceAttemptId: number;
  lastChance: LastChanceState | null;
  runSummary: RunSummary | null;
}

export type EngineAction =
  | { type: 'syncPlayers'; players: EnginePlayer[] }
  | { type: 'start'; byPlayerId: string }
  | { type: 'mpcVote'; voterId: string; candidateId: string }
  | { type: 'riskVote'; voterId: string; choice: 'bank' | 'risk' }
  | { type: 'namePlushie'; playerId: string; name: string }
  | { type: 'lastChanceHit'; playerId: string; attemptId: number; elapsedMs: number }
  | { type: 'crueltyChoice'; playerId: string; choice: 'sacrifice' | 'harder' | 'nuts' | 'teeth' }
  | { type: 'sacrificeVote'; voterId: string; plushieId: string }
  | { type: 'minigameAction'; playerId: string; payload: unknown }
  | { type: 'tick' };

export const DURATIONS = {
  mpcVote: 30_000,
  mpcSelected: 3_000,
  challengeIntro: 4_000,
  resolution: 6_000,
  plushieNaming: 10_000,
  riskVote: 30_000,
  stakes: 6_000,
  cruelty: 20_000,
  sacrificeResolution: 4_000,
  runEnd: 8_000,
} as const;

const LAST_CHANCE_BASE_CHANCE = 0.35;
const LAST_CHANCE_WINDOW_MS = 900;
const LAST_CHANCE_TRANSIT_BUFFER_MS = 800;
const MIN_PLAUSIBLE_MS = 100;
const LATENCY_TOLERANCE_MS = 150;

export function initialGameState(): GameState {
  return {
    code: '', phase: 'lobby', players: [], hostId: null, runId: 0, round: 0, difficulty: 1, machine: 'press', deadline: null,
    previousMpcId: null, mpcId: null, mpcVotes: {}, currentPlushie: null, unbanked: [], trophies: [], namingPlayerId: null,
    riskVotes: {}, cruelty: null, roundModifiers: { difficultyBonus: 0, forcedMpcId: null, disableSupport: false },
    activeMinigameId: null, minigameState: null, outcome: null, lastChanceUsed: false, lastChanceAttemptId: 0, lastChance: null,
    runSummary: null,
  };
}

/** Adds Phase 2 defaults when an existing persisted room wakes after deployment. */
export function normalizeGameState(raw: GameState): GameState {
  const defaults = initialGameState();
  const normalizePlushie = (plushie: Plushie): Plushie => ({
    ...plushie,
    ability: plushie.ability ?? 'brave_heart',
    abilityPower: plushie.abilityPower ?? abilityPowerForRarity(plushie.rarity),
  });
  const state = { ...defaults, ...raw };
  return {
    ...state,
    currentPlushie: state.currentPlushie ? normalizePlushie(state.currentPlushie) : null,
    unbanked: (state.unbanked ?? []).map(normalizePlushie),
    trophies: (state.trophies ?? []).map(normalizePlushie),
    outcome: state.outcome ? { ...state.outcome, plushie: normalizePlushie(state.outcome.plushie) } : null,
    namingPlayerId: state.namingPlayerId ?? null,
    lastChanceUsed: state.lastChanceUsed ?? false,
    lastChanceAttemptId: state.lastChanceAttemptId ?? 0,
    lastChance: state.lastChance ?? null,
  };
}

export function reduce(state: GameState, action: EngineAction, ctx: MinigameContext): GameState {
  switch (action.type) {
    case 'syncPlayers': return applySync(state, action.players, ctx);
    case 'start': return applyStart(state, action.byPlayerId, ctx);
    case 'mpcVote': return applyMpcVote(state, action.voterId, action.candidateId, ctx);
    case 'riskVote': return applyRiskVote(state, action.voterId, action.choice, ctx);
    case 'namePlushie': return applyNamePlushie(state, action.playerId, action.name, ctx);
    case 'lastChanceHit': return applyLastChanceHit(state, action.playerId, action.attemptId, action.elapsedMs, ctx);
    case 'crueltyChoice': return applyCrueltyChoice(state, action.playerId, action.choice, ctx);
    case 'sacrificeVote': return applySacrificeVote(state, action.voterId, action.plushieId, ctx);
    case 'minigameAction': return applyMinigameAction(state, action.playerId, action.payload, ctx);
    case 'tick': return applyTick(state, ctx);
  }
}

function connectedPlayers(state: GameState): EnginePlayer[] { return state.players.filter((player) => player.connected); }
function eligibleCandidates(state: GameState): string[] {
  const connected = connectedPlayers(state).map((player) => player.playerId);
  const eligible = connected.filter((id) => id !== state.previousMpcId);
  return eligible.length > 0 ? eligible : connected;
}
function reassignHost(state: GameState): string | null {
  if (state.hostId && state.players.some((player) => player.playerId === state.hostId)) return state.hostId;
  const ordered = [...state.players].sort((a, b) => a.seat - b.seat);
  return (ordered.find((player) => player.connected) ?? ordered[0])?.playerId ?? null;
}
function allConnectedVoted(votes: Record<string, string>, state: GameState): boolean {
  return connectedPlayers(state).every((player) => player.playerId in votes);
}

function applySync(state: GameState, players: EnginePlayer[], ctx: MinigameContext): GameState {
  const next = { ...state, players };
  next.hostId = reassignHost(next);
  if (next.phase === 'mpc_voting' && connectedPlayers(next).length > 0 && allConnectedVoted(next.mpcVotes, next)) return resolveMpcVote(next, ctx);
  if (next.phase === 'risk_voting' && connectedPlayers(next).length > 0 && allConnectedVoted(next.riskVotes, next)) return resolveRiskVote(next, ctx);
  if (next.phase === 'cruelty_event' && next.cruelty?.kind === 'the_sacrifice' && next.cruelty.stage === 'voting' && connectedPlayers(next).length > 0 && allConnectedVoted(next.cruelty.votes, next)) return resolveSacrificeVote(next, ctx);
  if (next.phase === 'last_chance' && next.lastChance && !connectedPlayers(next).some((player) => player.playerId === next.lastChance?.playerId)) return reassignLastChance(next, ctx);
  return next;
}

function applyStart(state: GameState, byPlayerId: string, ctx: MinigameContext): GameState {
  if (state.phase !== 'lobby' || byPlayerId !== state.hostId || connectedPlayers(state).length < MIN_PLAYERS) return state;
  return beginRun(state, ctx);
}
function beginRun(state: GameState, ctx: MinigameContext): GameState {
  const next: GameState = {
    ...state, runId: state.runId + 1, round: 0, difficulty: 1, machine: ctx.random() < 0.5 ? 'press' : 'cannon',
    unbanked: [], previousMpcId: null, mpcId: null, mpcVotes: {}, riskVotes: {}, namingPlayerId: null, cruelty: null,
    roundModifiers: { difficultyBonus: 0, forcedMpcId: null, disableSupport: false }, outcome: null,
    lastChanceUsed: false, lastChanceAttemptId: 0, lastChance: null, runSummary: null,
  };
  return enterMpcVoting(setupRound(next, ctx), ctx);
}
function setupRound(state: GameState, ctx: MinigameContext): GameState {
  const round = state.round + 1;
  const baseDifficulty = round + state.roundModifiers.difficultyBonus;
  const plushie = makePlushie(`${state.runId}-${round}`, round, ctx.random);
  return {
    ...state, round, difficulty: Math.max(1, baseDifficulty - braveReduction(state.unbanked)),
    currentPlushie: { ...plushie, value: plushie.value + greedyBonus(state.unbanked) }, mpcId: null, mpcVotes: {}, riskVotes: {},
    namingPlayerId: null, outcome: null, activeMinigameId: null, minigameState: null, lastChance: null,
  };
}
function enterStakes(state: GameState, ctx: MinigameContext): GameState { return { ...state, phase: 'stakes', deadline: ctx.now + DURATIONS.stakes }; }
function enterMpcVoting(state: GameState, ctx: MinigameContext): GameState {
  if (state.roundModifiers.forcedMpcId && connectedPlayers(state).some((player) => player.playerId === state.roundModifiers.forcedMpcId)) return enterMpcSelected({ ...state, mpcId: state.roundModifiers.forcedMpcId, mpcVotes: {} }, ctx);
  const eligible = eligibleCandidates(state);
  if (connectedPlayers(state).length <= 2 || eligible.length === 1) {
    const mpcId = lowestSeat(state, eligible);
    if (mpcId) return enterMpcSelected({ ...state, mpcId, mpcVotes: {} }, ctx);
  }
  return { ...state, phase: 'mpc_voting', mpcVotes: {}, deadline: ctx.now + DURATIONS.mpcVote };
}
function lowestSeat(state: GameState, eligible: string[]): string | null {
  const seats = new Map(state.players.map((player) => [player.playerId, player.seat]));
  return [...eligible].sort((a, b) => (seats.get(a) ?? Infinity) - (seats.get(b) ?? Infinity))[0] ?? null;
}
function enterMpcSelected(state: GameState, ctx: MinigameContext): GameState { return { ...state, phase: 'mpc_selected', deadline: ctx.now + DURATIONS.mpcSelected }; }
function enterChallengeIntro(state: GameState, ctx: MinigameContext): GameState {
  const game = pickMinigame(ctx.random);
  if (!state.mpcId) return state;
  const supportIds = state.roundModifiers.disableSupport ? [] : connectedPlayers(state).map((player) => player.playerId).filter((id) => id !== state.mpcId);
  return {
    ...state, phase: 'challenge_intro', activeMinigameId: game.id,
    minigameState: game.createInitialState({ difficulty: state.difficulty, mpcId: state.mpcId, supportIds }, ctx),
    roundModifiers: { difficultyBonus: 0, forcedMpcId: null, disableSupport: false }, deadline: ctx.now + DURATIONS.challengeIntro,
  };
}
function enterChallengeActive(state: GameState, ctx: MinigameContext): GameState {
  const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
  if (!game) return state;
  const minigameState = game.onStart(state.minigameState, ctx);
  return { ...state, phase: 'challenge_active', minigameState, deadline: game.getNextDeadline(minigameState) };
}

function applyMpcVote(state: GameState, voterId: string, candidateId: string, ctx: MinigameContext): GameState {
  if (state.phase !== 'mpc_voting' || !connectedPlayers(state).some((player) => player.playerId === voterId) || !eligibleCandidates(state).includes(candidateId)) return state;
  const next = { ...state, mpcVotes: { ...state.mpcVotes, [voterId]: candidateId } };
  return allConnectedVoted(next.mpcVotes, next) ? resolveMpcVote(next, ctx) : next;
}
function resolveMpcVote(state: GameState, ctx: MinigameContext): GameState {
  const eligible = eligibleCandidates(state);
  if (eligible.length === 0) return state;
  const tally = new Map(eligible.map((id) => [id, 0]));
  for (const candidateId of Object.values(state.mpcVotes)) if (tally.has(candidateId)) tally.set(candidateId, (tally.get(candidateId) ?? 0) + 1);
  const max = Math.max(...tally.values());
  const tied = [...tally].filter(([, count]) => count === max).map(([id]) => id);
  return enterMpcSelected({ ...state, mpcId: tied[Math.floor(ctx.random() * tied.length)] }, ctx);
}

function applyMinigameAction(state: GameState, playerId: string, payload: unknown, ctx: MinigameContext): GameState {
  if (state.phase !== 'challenge_active') return state;
  const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
  if (!game || (!connectedPlayers(state).some((player) => player.playerId === playerId) && playerId !== state.mpcId)) return state;
  const minigameState = playerId === state.mpcId ? game.handleMpcAction(state.minigameState, payload, ctx) : game.handleSupportAction(state.minigameState, playerId, payload, ctx);
  const outcome = game.evaluate(minigameState, ctx);
  const advanced = { ...state, minigameState };
  return outcome.status === 'resolved' ? enterResolution(advanced, outcome, ctx) : { ...advanced, deadline: game.getNextDeadline(minigameState) };
}
function enterResolution(state: GameState, minigameOutcome: MinigameOutcome & { status: 'resolved' }, ctx: MinigameContext): GameState {
  const plushie = state.currentPlushie ?? { id: '', species: '', emoji: '❓', name: 'Unknown', rarity: 'common' as const, value: 1, ability: 'brave_heart' as const, abilityPower: 1 };
  const outcome: RoundOutcome = { success: minigameOutcome.success, headline: minigameOutcome.headline, mpcId: state.mpcId ?? '', savedBy: minigameOutcome.savedBy, plushie };
  return {
    ...state, phase: 'round_resolution', outcome,
    unbanked: minigameOutcome.success && state.currentPlushie ? [...state.unbanked, state.currentPlushie] : state.unbanked,
    previousMpcId: state.mpcId, deadline: ctx.now + DURATIONS.resolution,
  };
}

function enterPlushieNaming(state: GameState, ctx: MinigameContext): GameState {
  return { ...state, phase: 'plushie_naming', namingPlayerId: state.outcome?.savedBy ?? state.mpcId, deadline: ctx.now + DURATIONS.plushieNaming };
}
function renamePlushie(state: GameState, plushieId: string, name: string): GameState {
  const rename = (plushie: Plushie) => plushie.id === plushieId ? { ...plushie, name } : plushie;
  return {
    ...state, currentPlushie: state.currentPlushie?.id === plushieId ? rename(state.currentPlushie) : state.currentPlushie,
    unbanked: state.unbanked.map(rename), outcome: state.outcome?.plushie.id === plushieId ? { ...state.outcome, plushie: rename(state.outcome.plushie) } : state.outcome,
  };
}
function applyNamePlushie(state: GameState, playerId: string, name: string, ctx: MinigameContext): GameState {
  if (state.phase !== 'plushie_naming' || playerId !== state.namingPlayerId || !state.outcome || !name.trim()) return state;
  return enterRiskVoting({ ...renamePlushie(state, state.outcome.plushie.id, name), namingPlayerId: null }, ctx);
}

function enterRiskVoting(state: GameState, ctx: MinigameContext): GameState { return { ...state, phase: 'risk_voting', riskVotes: {}, deadline: ctx.now + DURATIONS.riskVote }; }
function applyRiskVote(state: GameState, voterId: string, choice: 'bank' | 'risk', ctx: MinigameContext): GameState {
  if (state.phase !== 'risk_voting' || !connectedPlayers(state).some((player) => player.playerId === voterId)) return state;
  const next = { ...state, riskVotes: { ...state.riskVotes, [voterId]: choice } };
  return allConnectedVoted(next.riskVotes, next) ? resolveRiskVote(next, ctx) : next;
}
function resolveRiskVote(state: GameState, ctx: MinigameContext): GameState {
  const votes = Object.values(state.riskVotes);
  return votes.filter((choice) => choice === 'risk').length > votes.filter((choice) => choice === 'bank').length ? maybeEnterCruelty(state, ctx) : enterRunComplete(state, ctx);
}

function maybeEnterCruelty(state: GameState, ctx: MinigameContext): GameState {
  const baseChance = state.round >= 4 ? 0.65 : 0.25 + state.round * 0.1;
  const chance = Math.max(0.10, baseChance - guardianReduction(state.unbanked));
  if (ctx.random() <= 1 - chance) return enterStakes(setupRound(state, ctx), ctx);
  const connected = connectedPlayers(state);
  const pool = connected.filter((player) => player.playerId !== state.previousMpcId);
  const chooser = (pool.length ? pool : connected)[Math.floor(ctx.random() * (pool.length || connected.length))];
  const kind = pickCruelty(state, ctx.random);
  if (!kind || !chooser) return enterStakes(setupRound(state, ctx), ctx);
  if (kind === 'the_sacrifice') {
    const candidateIds = sacrificeCandidates(state.unbanked);
    if (!candidateIds) return enterStakes(setupRound(state, ctx), ctx);
    return { ...state, phase: 'cruelty_event', cruelty: { kind, stage: 'voting', candidateIds, votes: {}, sacrificedPlushieId: null, sacrificedPlushie: null }, deadline: ctx.now + DURATIONS.cruelty };
  }
  if (kind === 'the_deal') {
    const hostagePlushieId = [...state.unbanked].sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))[0]?.id;
    if (!hostagePlushieId) return enterStakes(setupRound(state, ctx), ctx);
    return { ...state, phase: 'cruelty_event', cruelty: { kind, chooserId: chooser.playerId, hostagePlushieId }, deadline: ctx.now + DURATIONS.cruelty };
  }
  return { ...state, phase: 'cruelty_event', cruelty: { kind, chooserId: chooser.playerId }, deadline: ctx.now + DURATIONS.cruelty };
}
function applyCrueltyChoice(state: GameState, playerId: string, choice: 'sacrifice' | 'harder' | 'nuts' | 'teeth', ctx: MinigameContext): GameState {
  if (state.phase !== 'cruelty_event' || !state.cruelty || state.cruelty.kind === 'the_sacrifice' || state.cruelty.chooserId !== playerId) return state;
  const event = state.cruelty;
  if (event.kind === 'the_deal' && (choice === 'sacrifice' || choice === 'harder')) {
    const unbanked = choice === 'sacrifice' ? state.unbanked.filter((plushie) => plushie.id !== event.hostagePlushieId) : state.unbanked;
    const roundModifiers = choice === 'harder' ? { ...state.roundModifiers, difficultyBonus: state.roundModifiers.difficultyBonus + 2 } : state.roundModifiers;
    return enterStakes(setupRound({ ...state, unbanked, roundModifiers, cruelty: null }, ctx), ctx);
  }
  if (event.kind === 'nuts_or_teeth' && (choice === 'nuts' || choice === 'teeth')) {
    const roundModifiers = choice === 'nuts' ? { ...state.roundModifiers, forcedMpcId: playerId, difficultyBonus: state.roundModifiers.difficultyBonus + 1 } : { ...state.roundModifiers, disableSupport: true };
    return enterStakes(setupRound({ ...state, roundModifiers, cruelty: null }, ctx), ctx);
  }
  return state;
}
function applySacrificeVote(state: GameState, voterId: string, plushieId: string, ctx: MinigameContext): GameState {
  if (state.phase !== 'cruelty_event' || state.cruelty?.kind !== 'the_sacrifice' || state.cruelty.stage !== 'voting') return state;
  if (!connectedPlayers(state).some((player) => player.playerId === voterId) || !state.cruelty.candidateIds.includes(plushieId)) return state;
  const cruelty = { ...state.cruelty, votes: { ...state.cruelty.votes, [voterId]: plushieId } };
  const next = { ...state, cruelty };
  return allConnectedVoted(cruelty.votes, next) ? resolveSacrificeVote(next, ctx) : next;
}
function resolveSacrificeVote(state: GameState, ctx: MinigameContext): GameState {
  if (state.cruelty?.kind !== 'the_sacrifice' || state.cruelty.stage !== 'voting') return state;
  const [first, second] = state.cruelty.candidateIds;
  const tally = { [first]: 0, [second]: 0 };
  for (const vote of Object.values(state.cruelty.votes)) if (vote === first || vote === second) tally[vote] += 1;
  const victim = tally[first] === tally[second] ? state.cruelty.candidateIds[Math.floor(ctx.random() * 2)] : tally[first] > tally[second] ? first : second;
  const sacrificedPlushie = state.unbanked.find((plushie) => plushie.id === victim) ?? null;
  return {
    ...state, unbanked: state.unbanked.filter((plushie) => plushie.id !== victim),
    cruelty: { ...state.cruelty, stage: 'resolved', sacrificedPlushieId: victim, sacrificedPlushie }, deadline: ctx.now + DURATIONS.sacrificeResolution,
  };
}

function selectLastChanceHero(state: GameState, ctx: MinigameContext): string | null {
  const connected = connectedPlayers(state);
  const alternatives = connected.filter((player) => player.playerId !== state.mpcId);
  const pool = alternatives.length ? alternatives : connected;
  return pool[Math.floor(ctx.random() * pool.length)]?.playerId ?? null;
}
function maybeEnterLastChance(state: GameState, ctx: MinigameContext): GameState {
  if (state.lastChanceUsed || !state.currentPlushie || state.outcome?.success) return enterRunFailed(state, ctx);
  const chance = Math.min(0.75, LAST_CHANCE_BASE_CHANCE + luckyCharmBonus(state.unbanked));
  if (ctx.random() <= 1 - chance) return enterRunFailed(state, ctx);
  const playerId = selectLastChanceHero(state, ctx);
  if (!playerId) return enterRunFailed(state, ctx);
  return startLastChance({ ...state, lastChanceUsed: true }, playerId, ctx);
}
function startLastChance(state: GameState, playerId: string, ctx: MinigameContext): GameState {
  const attemptId = state.lastChanceAttemptId + 1;
  return {
    ...state, phase: 'last_chance', lastChanceAttemptId: attemptId,
    lastChance: { playerId, attemptId, startedAt: ctx.now, windowMs: LAST_CHANCE_WINDOW_MS, outcome: 'pending' },
    deadline: ctx.now + LAST_CHANCE_WINDOW_MS + LAST_CHANCE_TRANSIT_BUFFER_MS,
  };
}
function reassignLastChance(state: GameState, ctx: MinigameContext): GameState {
  const playerId = selectLastChanceHero(state, ctx);
  return playerId ? startLastChance(state, playerId, ctx) : state;
}
function applyLastChanceHit(state: GameState, playerId: string, attemptId: number, elapsedMs: number, ctx: MinigameContext): GameState {
  const lastChance = state.lastChance;
  if (state.phase !== 'last_chance' || !lastChance || lastChance.playerId !== playerId || lastChance.attemptId !== attemptId || lastChance.outcome !== 'pending') return state;
  if (elapsedMs < MIN_PLAUSIBLE_MS || elapsedMs > ctx.now - lastChance.startedAt + LATENCY_TOLERANCE_MS) return state;
  if (elapsedMs > lastChance.windowMs) return enterRunFailed({ ...state, lastChance: { ...lastChance, outcome: 'failure' } }, ctx);
  const plushie = state.currentPlushie;
  if (!plushie || !state.outcome) return enterRunFailed(state, ctx);
  const alreadySaved = state.unbanked.some((unbanked) => unbanked.id === plushie.id);
  return {
    ...state, phase: 'round_resolution', lastChance: null,
    unbanked: alreadySaved ? state.unbanked : [...state.unbanked, plushie],
    outcome: { ...state.outcome, success: true, savedBy: playerId, headline: `LAST CHANCE! ${playerName(state, playerId)} saved ${plushie.name}!` },
    deadline: ctx.now + DURATIONS.resolution,
  };
}
function playerName(state: GameState, playerId: string): string { return state.players.find((player) => player.playerId === playerId)?.nickname ?? 'Someone'; }

function enterRunComplete(state: GameState, ctx: MinigameContext): GameState {
  const runSummary: RunSummary = { banked: true, rounds: state.round, plushies: state.unbanked };
  return { ...state, phase: 'run_complete', trophies: [...state.trophies, ...state.unbanked], unbanked: [], namingPlayerId: null, runSummary, deadline: ctx.now + DURATIONS.runEnd };
}
function enterRunFailed(state: GameState, ctx: MinigameContext): GameState {
  const runSummary: RunSummary = { banked: false, rounds: state.round, plushies: state.unbanked };
  return { ...state, phase: 'run_failed', unbanked: [], namingPlayerId: null, lastChance: null, runSummary, deadline: ctx.now + DURATIONS.runEnd };
}

function applyTick(state: GameState, ctx: MinigameContext): GameState {
  if (state.deadline === null || ctx.now < state.deadline) return state;
  switch (state.phase) {
    case 'mpc_voting': return resolveMpcVote(state, ctx);
    case 'mpc_selected': return enterChallengeIntro(state, ctx);
    case 'challenge_intro': return enterChallengeActive(state, ctx);
    case 'challenge_active': {
      const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
      if (!game) return state;
      const minigameState = game.onDeadline(state.minigameState, ctx);
      const outcome = game.evaluate(minigameState, ctx);
      const advanced = { ...state, minigameState };
      return outcome.status === 'resolved' ? enterResolution(advanced, outcome, ctx) : { ...advanced, deadline: game.getNextDeadline(minigameState) };
    }
    case 'round_resolution': return state.outcome?.success ? enterPlushieNaming(state, ctx) : maybeEnterLastChance(state, ctx);
    case 'plushie_naming': return enterRiskVoting({ ...state, namingPlayerId: null }, ctx);
    case 'risk_voting': return resolveRiskVote(state, ctx);
    case 'cruelty_event':
      if (state.cruelty?.kind === 'the_sacrifice') return state.cruelty.stage === 'voting' ? resolveSacrificeVote(state, ctx) : enterStakes(setupRound({ ...state, cruelty: null }, ctx), ctx);
      return applyCrueltyChoice(state, state.cruelty?.chooserId ?? '', state.cruelty?.kind === 'the_deal' ? 'harder' : 'teeth', ctx);
    case 'stakes': return enterMpcVoting(state, ctx);
    case 'last_chance': return enterRunFailed({ ...state, lastChance: state.lastChance ? { ...state.lastChance, outcome: 'failure' } : null }, ctx);
    case 'run_complete':
    case 'run_failed': return beginRun(state, ctx);
    case 'lobby': return state;
  }
}

function projectCruelty(state: GameState, viewerId: string): CrueltyView | null {
  const cruelty = state.cruelty;
  if (!cruelty) return null;
  if (cruelty.kind === 'the_deal') return cruelty;
  if (cruelty.kind === 'nuts_or_teeth') return cruelty;
  const voteTally: Record<string, number> = { [cruelty.candidateIds[0]]: 0, [cruelty.candidateIds[1]]: 0 };
  for (const vote of Object.values(cruelty.votes)) if (vote in voteTally) voteTally[vote] += 1;
  return {
    kind: 'the_sacrifice', stage: cruelty.stage, candidateIds: cruelty.candidateIds, voteTally, yourVote: cruelty.votes[viewerId] ?? null,
    ...(cruelty.sacrificedPlushieId ? { sacrificedPlushieId: cruelty.sacrificedPlushieId } : {}),
    ...(cruelty.sacrificedPlushie ? { sacrificedPlushie: cruelty.sacrificedPlushie } : {}),
  };
}

export function projectFor(state: GameState, viewerId: string, now = 0): GameView {
  const game = state.activeMinigameId ? getMinigame(state.activeMinigameId) : undefined;
  const showMinigame = game != null && (state.phase === 'challenge_intro' || state.phase === 'challenge_active' || state.phase === 'round_resolution');
  const hideDeadline = state.phase === 'challenge_active' && game != null && (game.isDeadlineHidden?.(state.minigameState) ?? false);
  const rawFuse = state.phase === 'challenge_active' && game != null ? game.getFuse?.(state.minigameState) ?? null : null;
  const tally = (votes: Record<string, string>): Record<string, number> => Object.values(votes).reduce<Record<string, number>>((counts, vote) => ({ ...counts, [vote]: (counts[vote] ?? 0) + 1 }), {});
  const mpcVoteTally = tally(state.mpcVotes);
  const riskTally = { bank: 0, risk: 0 };
  for (const vote of Object.values(state.riskVotes)) riskTally[vote] += 1;
  const players: PlayerView[] = [...state.players].sort((a, b) => a.seat - b.seat).map(({ playerId, nickname, connected, seat }) => ({ playerId, nickname, connected, seat }));
  return {
    code: state.code, phase: state.phase, round: state.round, difficulty: state.difficulty, machine: state.machine, youId: viewerId, hostId: state.hostId, players,
    deadlineRemainingMs: hideDeadline || state.deadline === null ? null : Math.max(0, state.deadline - now),
    fuse: rawFuse ? { remainingMs: Math.max(0, rawFuse.deadlineAt - now), totalMs: rawFuse.totalMs } : null,
    mpcId: state.mpcId, previousMpcId: state.previousMpcId, eligibleIds: state.phase === 'mpc_voting' ? eligibleCandidates(state) : [], mpcVoteTally, yourMpcVote: state.mpcVotes[viewerId] ?? null,
    currentPlushie: state.currentPlushie, unbanked: state.unbanked, trophies: state.trophies, namingPlayerId: state.namingPlayerId,
    riskTally, yourRiskVote: state.riskVotes[viewerId] ?? null, cruelty: projectCruelty(state, viewerId),
    lastChance: state.lastChance?.outcome === 'pending' ? { playerId: state.lastChance.playerId, attemptId: state.lastChance.attemptId, windowMs: state.lastChance.windowMs } : null,
    minigame: showMinigame && game ? { id: game.id, title: game.title, view: game.getStateForPlayer(state.minigameState, viewerId) } : null,
    outcome: state.outcome, runSummary: state.runSummary,
  };
}
