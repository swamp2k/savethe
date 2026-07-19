import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

type WireColor = 'red' | 'blue' | 'green' | 'yellow';
interface WireView { role: 'mpc' | 'support' | 'spectator'; wires: WireColor[]; clues: string[]; }

export const WirePanicMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as WireView | undefined;
  if (!mg) return null;
  if (view.phase === 'round_resolution') return <p className="hint center">The wire cutter has spoken.</p>;

  const showcase = <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />;
  if (mg.role === 'mpc') {
    return <>{showcase}<p className="typing-progress">CUT THE RIGHT WIRE.</p>{mg.clues.length > 0 && <div className="wire-clues"><strong>EMERGENCY DIAGNOSTICS</strong>{mg.clues.map((clue) => <span key={clue}>{clue}</span>)}</div>}<div className="wire-grid">{mg.wires.map((wire) => <button key={wire} className={`wire-button wire-button--${wire}`} onClick={() => { conn.minigameAction({ kind: 'cut', wire }); playSound('click'); }}>{wire.toUpperCase()}</button>)}</div></>;
  }
  if (mg.role === 'support') {
    return <>{showcase}<div className="wire-clues wire-clues--support"><strong>YOUR CLUE</strong>{mg.clues.map((clue) => <span key={clue}>{clue}</span>)}<em>TELL THE MPC.</em></div></>;
  }
  return <>{showcase}<p className="hint center">Watching {nameOf(view.mpcId)} decide which wire to cut&hellip;</p></>;
};
