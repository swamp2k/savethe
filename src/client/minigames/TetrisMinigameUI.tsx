import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

interface TetrisView {
  role: 'mpc' | 'support' | 'spectator';
  linesCleared: number;
  requiredLines: number;
  supportAssists: number;
  grid?: boolean[][];
  cols?: number;
  rows?: number;
  pieceCells?: [number, number][];
  myChuteFilled?: number;
  myChuteHeight?: number;
}

export const TetrisMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as TetrisView | undefined;
  if (!mg) return null;

  if (view.phase === 'round_resolution') {
    const assist = mg.supportAssists > 0 ? ` — ${mg.supportAssists} team assist${mg.supportAssists === 1 ? '' : 's'}` : '';
    return (
      <p className="hint center">
        {mg.linesCleared}/{mg.requiredLines} lines{assist}.
      </p>
    );
  }

  const act = (payload: unknown) => {
    conn.minigameAction(payload);
    playSound('click');
  };

  if (mg.role === 'mpc') {
    const pieceSet = new Set((mg.pieceCells ?? []).map(([r, c]) => `${r},${c}`));
    return (
      <>
        <p className="typing-progress">
          {mg.linesCleared} / {mg.requiredLines} lines
        </p>
        <div className="tetris-grid" style={{ gridTemplateColumns: `repeat(${mg.cols ?? 6}, 1fr)` }}>
          {(mg.grid ?? []).map((row, r) =>
            row.map((filled, c) => (
              <div
                key={`${r},${c}`}
                className={`tetris-cell ${filled ? 'tetris-cell--locked' : ''} ${pieceSet.has(`${r},${c}`) ? 'tetris-cell--active' : ''}`}
              />
            )),
          )}
        </div>
        <div className="actions__row">
          <button className="btn btn--ghost" onClick={() => act({ kind: 'move', dir: 'left' })}>
            ⬅️
          </button>
          <button className="btn btn--ghost" onClick={() => act({ kind: 'rotate' })}>
            🔄
          </button>
          <button className="btn btn--ghost" onClick={() => act({ kind: 'move', dir: 'right' })}>
            ➡️
          </button>
          <button className="btn btn--primary" onClick={() => act({ kind: 'drop' })}>
            ⬇️ Drop
          </button>
        </div>
      </>
    );
  }

  if (mg.role === 'support') {
    const height = mg.myChuteHeight ?? 4;
    const filled = mg.myChuteFilled ?? 0;
    return (
      <>
        <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
        <p className="hint">
          Help {nameOf(view.mpcId)}! Fill your chute ({mg.supportAssists} completed)
        </p>
        <div className="tetris-chute">
          {Array.from({ length: height }, (_, i) => (
            <div key={i} className={`tetris-cell ${i < filled ? 'tetris-cell--locked' : ''}`} />
          ))}
        </div>
        <button className="btn btn--primary" onClick={() => act({ kind: 'assist' })}>
          ⬇️ Drop
        </button>
      </>
    );
  }

  return (
    <>
      <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
      <p className="typing-progress">
        {mg.linesCleared} / {mg.requiredLines} lines
      </p>
      <p className="hint center">Watching {nameOf(view.mpcId)} stack blocks&hellip;</p>
    </>
  );
};
