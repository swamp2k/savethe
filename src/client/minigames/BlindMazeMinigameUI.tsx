import { useCallback, useEffect } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

type Direction = 'up' | 'down' | 'left' | 'right';
type Cell = 'wall' | 'open' | 'player' | 'goal';
interface MazeView { role: 'mpc' | 'support' | 'spectator'; bumps: number; maxBumps: number; moves: number; localGrid?: Cell[][]; grid?: number[][]; position?: { x: number; y: number }; goal?: { x: number; y: number }; }

function MazeGrid({ cells, position, goal }: { cells: Array<Array<Cell | number>>; position?: { x: number; y: number }; goal?: { x: number; y: number } }) {
  return <div className="maze-grid" style={{ gridTemplateColumns: `repeat(${cells[0]?.length ?? 1}, 1fr)` }}>{cells.flatMap((row, y) => row.map((cell, x) => { const value = position?.x === x && position?.y === y ? 'player' : goal?.x === x && goal?.y === y ? 'goal' : cell === 0 ? 'wall' : cell === 1 ? 'open' : cell; return <span className={`maze-cell maze-cell--${value}`} key={`${x}-${y}`}>{value === 'player' ? '🧸' : value === 'goal' ? '⭐' : ''}</span>; }))}</div>;
}

export const BlindMazeMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as MazeView | undefined;
  const role = mg?.role;
  const move = useCallback((direction: Direction) => { conn.minigameAction({ kind: 'move', direction }); playSound('click'); }, [conn]);
  useEffect(() => {
    if (view.phase !== 'challenge_active' || role !== 'mpc') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const direction = ({ ArrowUp: 'up', w: 'up', W: 'up', ArrowDown: 'down', s: 'down', S: 'down', ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' } as Record<string, Direction | undefined>)[event.key];
      if (direction) { event.preventDefault(); move(direction); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [role, view.phase, move]);
  if (!mg) return null;
  const showcase = <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />;
  const stats = <p className="hint center">Bumps: {mg.bumps}/{mg.maxBumps} · Moves: {mg.moves}</p>;
  if (view.phase === 'round_resolution') return <>{stats}</>;
  if (mg.role === 'support') return <>{showcase}<p className="typing-progress">GUIDE THE MPC!</p><p className="hint center">{nameOf(view.mpcId)} cannot see what you see.</p>{mg.grid && <MazeGrid cells={mg.grid} position={mg.position} goal={mg.goal} />}{stats}</>;
  if (mg.role === 'spectator') return <>{showcase}<p className="typing-progress">NO SUPPORT THIS ROUND.</p><p className="hint center">The MPC is on their own.</p>{stats}</>;
  return <>{showcase}<p className="typing-progress">BLIND MAZE</p>{mg.localGrid && <MazeGrid cells={mg.localGrid} />}{stats}<div className="maze-controls"><button className="btn btn--ghost" onClick={() => move('up')}>↑</button><div><button className="btn btn--ghost" onClick={() => move('left')}>←</button><button className="btn btn--ghost" onClick={() => move('down')}>↓</button><button className="btn btn--ghost" onClick={() => move('right')}>→</button></div></div></>;
};
