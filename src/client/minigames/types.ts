import type { ReactElement } from 'react';
import type { Connection } from '../useGameConnection';
import type { GameView } from '../../shared/game';

/**
 * The client-side counterpart to the server's minigame registry (PLAN.md:
 * "Adding a minigame touches only: its plugin module, the registry, its UI
 * component, and its tests"). A component receives the full GameView and
 * decides for itself, from `view.phase`, whether to render its interactive
 * controls (challenge_active) or a resolution-time stat reveal
 * (round_resolution) — the generic phase shell in Game.tsx doesn't need to
 * know which minigame is active to host either.
 */
export interface MinigameUIProps {
  conn: Connection;
  view: GameView;
  nameOf: (id: string | null) => string;
}

export type MinigameUIComponent = (props: MinigameUIProps) => ReactElement | null;
