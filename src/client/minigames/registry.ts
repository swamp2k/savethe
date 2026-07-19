import type { MinigameUIComponent } from './types';
import { AimMinigameUI } from './AimMinigameUI';
import { DebugMinigameUI } from './DebugMinigameUI';
import { MemoryMinigameUI } from './MemoryMinigameUI';
import { PlatformerMinigameUI } from './PlatformerMinigameUI';
import { ReactionMinigameUI } from './ReactionMinigameUI';
import { TetrisMinigameUI } from './TetrisMinigameUI';
import { TypingMinigameUI } from './TypingMinigameUI';
import { WirePanicMinigameUI } from './WirePanicMinigameUI';
import { SpellingPanicMinigameUI } from './SpellingPanicMinigameUI';

/** Client counterpart to the server's minigame registry, keyed by the same id. */
const REGISTRY: Record<string, MinigameUIComponent> = {
  debug: DebugMinigameUI,
  reaction: ReactionMinigameUI,
  typing: TypingMinigameUI,
  aim: AimMinigameUI,
  memory: MemoryMinigameUI,
  tetris: TetrisMinigameUI,
  platformer: PlatformerMinigameUI,
  wire: WirePanicMinigameUI,
  spelling: SpellingPanicMinigameUI,
};

export function getMinigameUI(id: string): MinigameUIComponent | undefined {
  return REGISTRY[id];
}
