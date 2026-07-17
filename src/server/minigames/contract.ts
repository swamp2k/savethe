import type { z } from 'zod';

/**
 * The common minigame contract. The engine and GameRoom interact only through
 * this interface and never branch on a specific minigame id (architecture rule
 * 3). Minigame state is opaque (`unknown`) to the engine; each plugin casts it
 * to its own concrete type internally.
 *
 * Every method is pure: time and randomness arrive via `MinigameContext`, so a
 * minigame is as deterministically testable as the engine itself (rule 2).
 */

export interface MinigameContext {
  now: number;
  random: () => number;
}

export interface MinigameConfig {
  /** Round-scaled difficulty (1 = easiest). Greed makes this climb. */
  difficulty: number;
  mpcId: string;
  supportIds: string[];
}

export type MinigameOutcome =
  | { status: 'active' }
  | {
      status: 'resolved';
      success: boolean;
      /** Human-readable flavour for the resolution screen. */
      headline: string;
      /** Set when a support player made the save (team rescue). */
      savedBy?: string;
    };

export interface Minigame {
  readonly id: string;
  readonly title: string;

  /** Validates the payload of an inbound `minigame.action` at the boundary. */
  readonly actionSchema: z.ZodTypeAny;

  createInitialState(config: MinigameConfig, ctx: MinigameContext): unknown;

  /** Called once when the challenge goes live (phase CHALLENGE_ACTIVE). */
  onStart(state: unknown, ctx: MinigameContext): unknown;

  handleMpcAction(state: unknown, action: unknown, ctx: MinigameContext): unknown;
  handleSupportAction(state: unknown, playerId: string, action: unknown, ctx: MinigameContext): unknown;

  /** Called when the plugin's own deadline (from getNextDeadline) elapses. */
  onDeadline(state: unknown, ctx: MinigameContext): unknown;

  evaluate(state: unknown, ctx: MinigameContext): MinigameOutcome;

  /** The next moment this minigame needs the engine to wake it, or null. */
  getNextDeadline(state: unknown): number | null;

  /** Per-player projection: what this specific viewer may see. */
  getStateForPlayer(state: unknown, viewerId: string): unknown;
}
