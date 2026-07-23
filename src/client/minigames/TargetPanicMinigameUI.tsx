import type { MinigameUIComponent } from './types';

interface View { role: 'mpc' | 'support' | 'spectator'; target: number | null; hazard: number | null; hits: number; required: number; boosts: number; }

export const TargetPanicMinigameUI: MinigameUIComponent = ({ conn, view }) => {
  const game = view.minigame?.view as View | undefined;
  if (!game) return null;
  if (view.phase === 'round_resolution') return <p className="hint center">{game.hits}/{game.required} targets · {game.boosts} support shields.</p>;
  if (game.role === 'spectator') return <p className="hint center">Watching the target panic…</p>;
  const active = game.role === 'mpc' ? game.target : game.hazard;
  return <><p className="typing-progress">{game.role === 'mpc' ? `HIT THE STAR ${game.hits}/${game.required}` : 'SHIELD THE HAZARD!'}</p><div className="vote-grid">{Array.from({ length: 9 }, (_, cell) => <button key={cell} className="vote-btn" onClick={() => conn.minigameAction({ kind: game.role === 'mpc' ? 'hit' : 'shield', cell })}>{cell === active ? game.role === 'mpc' ? '⭐' : '💣' : '·'}</button>)}</div><p className="hint center">Support shields lower the MPC&apos;s target count.</p></>;
};
