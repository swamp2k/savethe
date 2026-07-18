import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

interface MemoryView {
  role: 'mpc' | 'support' | 'spectator';
  stage: 'study' | 'recall';
  recallIndex: number;
  requiredCorrect: number;
  supportCompletions: number;
  alphabet: string[];
  sequence?: string[];
  mySequence?: string[];
  myIndex?: number;
}

function SymbolPad({ onPick, alphabet }: { onPick: (symbol: string) => void; alphabet: string[] }) {
  return (
    <div className="memory-pad">
      {alphabet.map((symbol) => (
        <button key={symbol} className="memory-pad__btn" onClick={() => onPick(symbol)} aria-label={`Pick ${symbol}`}>
          {symbol}
        </button>
      ))}
    </div>
  );
}

export const MemoryMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as MemoryView | undefined;
  if (!mg) return null;

  if (view.phase === 'round_resolution') {
    const assist = mg.supportCompletions > 0 ? ` — ${mg.supportCompletions} team assist${mg.supportCompletions === 1 ? '' : 's'}` : '';
    return (
      <p className="hint center">
        {mg.recallIndex}/{mg.requiredCorrect} symbols{assist}.
      </p>
    );
  }

  const pick = (symbol: string) => {
    conn.minigameAction({ kind: 'recall', symbol });
    playSound('click');
  };

  if (mg.role === 'mpc') {
    return (
      <>
        <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
        <p className="typing-progress">
          {mg.stage === 'study' ? 'Study the sequence…' : `${mg.recallIndex} / ${mg.requiredCorrect} correct`}
        </p>
        <div className="memory-sequence">
          {mg.stage === 'study'
            ? (mg.sequence ?? []).map((symbol, i) => (
                <span key={i} className="memory-tile">
                  {symbol}
                </span>
              ))
            : Array.from({ length: mg.requiredCorrect }, (_, i) => (
                <span key={i} className={`memory-tile ${i < mg.recallIndex ? 'memory-tile--done' : 'memory-tile--blank'}`}>
                  {i < mg.recallIndex ? '✔️' : '?'}
                </span>
              ))}
        </div>
        {mg.stage === 'recall' && <SymbolPad alphabet={mg.alphabet} onPick={pick} />}
      </>
    );
  }

  if (mg.role === 'support') {
    return (
      <>
        <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
        <p className="hint">
          Help {nameOf(view.mpcId)}! Repeat your sequence ({mg.supportCompletions} completed)
        </p>
        <div className="memory-sequence">
          {(mg.mySequence ?? []).map((symbol, i) => (
            <span key={i} className={`memory-tile ${i < (mg.myIndex ?? 0) ? 'memory-tile--done' : ''}`}>
              {symbol}
            </span>
          ))}
        </div>
        <SymbolPad alphabet={mg.alphabet} onPick={pick} />
      </>
    );
  }

  return (
    <>
      <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
      <p className="typing-progress">
        {mg.recallIndex} / {mg.requiredCorrect} correct
      </p>
      <p className="hint center">Watching {nameOf(view.mpcId)} remember&hellip;</p>
    </>
  );
};
