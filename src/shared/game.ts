/** Game-wide types shared by client and server. The server owns the full
 *  authoritative GameState (server-only); clients only ever receive a per-player
 *  projection: `GameView`. */

export type Phase =
  | 'lobby'
  | 'mpc_voting'
  | 'mpc_selected'
  | 'challenge_intro'
  | 'challenge_active'
  | 'round_resolution'
  | 'plushie_naming'
  | 'risk_voting'
  | 'cruelty_event'
  | 'stakes'
  | 'last_chance'
  | 'run_complete'
  | 'run_failed';

/** The doom machine flavor for a run, chosen once at run start (engine
 *  `beginRun`). Purely cosmetic — no minigame or engine logic branches on
 *  it — but visible throughout the run via the Hud and plushie stage. */
export type Machine = 'press' | 'cannon';

export const MACHINES: Record<Machine, { emoji: string; label: string; failEmoji: string }> = {
  press: { emoji: '🏭', label: 'the Hydraulic Press', failEmoji: '💥' },
  cannon: { emoji: '🚀', label: 'the Cannon Into Space', failEmoji: '🌌' },
};

export type PlushieRarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITY_VALUES: Record<PlushieRarity, number> = {
  common: 1, uncommon: 2, rare: 4, epic: 8, legendary: 16,
};

export interface Plushie {
  id: string;
  species: string;
  emoji: string;
  name: string;
  rarity: PlushieRarity;
  value: number;
  ability: import('./abilities').PlushieAbility;
  abilityPower: number;
}

export interface PlayerView {
  playerId: string;
  nickname: string;
  connected: boolean;
  seat: number;
}

/** The result of a resolved round, surfaced to the resolution screen. */
export interface RoundOutcome {
  success: boolean;
  /** Human-readable flavour from the minigame, e.g. "Rescued by Lisa!". */
  headline: string;
  mpcId: string;
  /** Set when a support player made the save (team rescue). */
  savedBy?: string;
  plushie: Plushie;
}

/** Shown after a run ends (banked or failed) before the next run begins. */
export interface RunSummary {
  banked: boolean;
  rounds: number;
  /** Plushies secured this run (banked) or lost (failed). */
  plushies: Plushie[];
}

export type CrueltyKind = 'the_deal' | 'nuts_or_teeth' | 'the_sacrifice';
export type CrueltyView =
  | { kind: 'the_deal'; chooserId: string; hostagePlushieId: string }
  | { kind: 'nuts_or_teeth'; chooserId: string }
  | {
      kind: 'the_sacrifice';
      stage: 'voting' | 'resolved';
      candidateIds: [string, string];
      voteTally: Record<string, number>;
      yourVote: string | null;
      sacrificedPlushieId?: string;
      sacrificedPlushie?: Plushie;
    };
export interface RoundModifiers { difficultyBonus: number; forcedMpcId: string | null; disableSupport: boolean; }
export interface LastChanceView { playerId: string; attemptId: number; windowMs: number; }

/** Read-only summary of abilities that remain active while a run is at risk. */
export interface ActiveEffectsView {
  brave: { reduction: number; baseDifficulty: number; effectiveDifficulty: number } | null;
  guardian: { reduction: number; baseChance: number; effectiveChance: number } | null;
  greedy: { bonus: number } | null;
  lucky: { bonus: number; baseChance: number; effectiveChance: number } | null;
}

/**
 * Everything one specific viewer is allowed to see. Different players can get
 * different views (per-player projection, architecture rule 4) — notably the
 * `minigame` field, which is the active plugin's own projection for this viewer.
 */
export interface GameView {
  code: string;
  phase: Phase;
  round: number;
  difficulty: number;
  machine: Machine;

  youId: string;
  hostId: string | null;
  players: PlayerView[];

  /** Duration remaining when this projection was made, if the phase is timed. */
  deadlineRemainingMs: number | null;

  /** Burning-fuse pressure bar for the active challenge: the minigame's fixed
   *  overall budget (never the jittery/secret per-action deadlines). Null
   *  whenever the active minigame has no stable, player-visible budget. */
  fuse: { remainingMs: number; totalMs: number } | null;

  // MPC selection
  mpcId: string | null;
  previousMpcId: string | null;
  /** Candidates eligible to be voted MPC this round. */
  eligibleIds: string[];
  /** Live tally: candidateId -> number of votes. */
  mpcVoteTally: Record<string, number>;
  yourMpcVote: string | null;

  // Rescue targets
  currentPlushie: Plushie | null;
  unbanked: Plushie[];
  trophies: Plushie[];
  namingPlayerId: string | null;

  // Bank / Risk
  riskTally: { bank: number; risk: number };
  yourRiskVote: 'bank' | 'risk' | null;
  activeEffects: ActiveEffectsView;
  cruelty: CrueltyView | null;
  lastChance: LastChanceView | null;

  // Active challenge (per-player projection from the plugin)
  minigame: { id: string; title: string; view: unknown } | null;

  outcome: RoundOutcome | null;
  runSummary: RunSummary | null;
}

export const PHASE_LABELS: Record<Phase, string> = {
  lobby: 'Lobby',
  mpc_voting: 'Choosing the MPC',
  mpc_selected: 'MPC selected',
  challenge_intro: 'Challenge incoming',
  challenge_active: 'Save it!',
  round_resolution: 'Resolution',
  plushie_naming: 'Name your rescue',
  risk_voting: 'Bank or Risk?',
  cruelty_event: 'The machine demands a choice',
  stakes: 'Stakes',
  last_chance: 'Last Chance',
  run_complete: 'Run banked',
  run_failed: 'Run over',
};
