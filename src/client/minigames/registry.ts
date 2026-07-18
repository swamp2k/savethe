import type { MinigameUIComponent } from './types';
import { DebugMinigameUI } from './DebugMinigameUI';
import { ReactionMinigameUI } from './ReactionMinigameUI';
import { TypingMinigameUI } from './TypingMinigameUI';

/** Client counterpart to the server's minigame registry, keyed by the same id. */
const REGISTRY: Record<string, MinigameUIComponent> = {
  debug: DebugMinigameUI,
  reaction: ReactionMinigameUI,
  typing: TypingMinigameUI,
};

export function getMinigameUI(id: string): MinigameUIComponent | undefined {
  return REGISTRY[id];
}
