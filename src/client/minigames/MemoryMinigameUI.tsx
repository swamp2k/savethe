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
  myStage?: 'study' | 'recall';
  mySequence?: string[];
  myIndex?: number;
  myLength?: number;
  myWrongAttempts?: number;
}

function SymbolPad({ onPick, alphabet }: { onPick: (symbol: string) => void; alphabet: string[] }) {
  return <div className="memory-pad">{alphabet.map((symbol) => <button key={symbol} className="memory-pad__btn" onClick={() => onPick(symbol)} aria-label={`Pick ${symbol}`}>{symbol}</button>)}</div>;
}

function HiddenSequence({ length, index }: { length: number; index: number }) {
  return (
    <div className="memory-sequence" aria-label={`${index} of ${length} symbols recalled`}>
      {Array.from({ length }, (_, i) => <span key={i} className={`memory-tile ${i < index ? 'memory-tile--done' : 'memory-tile--blank'}`}>{i < index ? '✔️' : '?'}</span>)}
    </div>
  );
}

export const MemoryMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as MemoryView | undefined;
  if (!mg) return null;
  if (view.phase === 'round_resolution') return <p className="hint center">{mg.recallIndex}/{mg.requiredCorrect} symbols · {mg.supportCompletions} memory assist(s).</p>;

  const pick = (symbol: string) => {
    conn.minigameAction({ kind: 'recall', symbol });
    playSound('click');
  };
  const showcase = <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />;

  if (mg.role === 'mpc') return <>{showcase}<p className="typing-progress">{mg.stage === 'study' ? 'MEMORIZE THE SEQUENCE' : `${mg.recallIndex} / ${mg.requiredCorrect} correct`}</p>{mg.stage === 'study' ? <div className="memory-sequence">{(mg.sequence ?? []).map((symbol, i) => <span key={i} className="memory-tile">{symbol}</span>)}</div> : <><HiddenSequence length={mg.requiredCorrect} index={mg.recallIndex} /><SymbolPad alphabet={mg.alphabet} onPick={pick} /></>}</>;

  if (mg.role === 'support') {
    const studying = mg.myStage === 'study';
    return <>{showcase}<p className="typing-progress">{studying ? 'MEMORIZE YOUR 3' : 'RECALL — NO PEEKING'}</p><p className="hint center">Every completed sequence shortens {nameOf(view.mpcId)}&apos;s answer. {mg.supportCompletions} team assist(s).</p>{studying ? <div className="memory-sequence">{(mg.mySequence ?? []).map((symbol, i) => <span key={i} className="memory-tile">{symbol}</span>)}</div> : <><HiddenSequence length={mg.myLength ?? 3} index={mg.myIndex ?? 0} /><SymbolPad alphabet={mg.alphabet} onPick={pick} /></>}{(mg.myWrongAttempts ?? 0) > 0 && <p className="memory-penalty">Wrong input: restudy #{mg.myWrongAttempts}</p>}</>;
  }

  return <>{showcase}<p className="typing-progress">{mg.recallIndex} / {mg.requiredCorrect} correct</p><p className="hint center">Watching {nameOf(view.mpcId)} remember&hellip;</p></>;
};
