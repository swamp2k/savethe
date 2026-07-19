import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

type WireColor = 'red' | 'blue' | 'green' | 'yellow';
interface WireView { role: 'mpc' | 'support' | 'spectator'; wires: WireColor[]; clues: string[]; }

const WIRE_VISUALS: Record<WireColor, { emoji: string; shape: string; label: string }> = {
  red: { emoji: '🔴', shape: '●', label: 'RED' },
  blue: { emoji: '🔵', shape: '■', label: 'BLUE' },
  green: { emoji: '🟢', shape: '▲', label: 'GREEN' },
  yellow: { emoji: '🟡', shape: '★', label: 'YELLOW' },
};

function WireClue({ clue }: { clue: string }) {
  const color = clue.replace(/^NOT\s+/i, '').toLowerCase() as WireColor;
  const visual = WIRE_VISUALS[color];
  return visual ? <span className="wire-clue"><span aria-hidden="true">❌</span><span aria-hidden="true">{visual.emoji} {visual.shape}</span><strong>{clue.toUpperCase()}</strong></span> : <span>{clue}</span>;
}

export const WirePanicMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as WireView | undefined;
  if (!mg) return null;
  if (view.phase === 'round_resolution') return <p className="hint center">The wire cutter has spoken.</p>;

  const showcase = <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />;
  if (mg.role === 'mpc') {
    return <>{showcase}<p className="typing-progress">CUT THE RIGHT WIRE.</p>{mg.clues.length > 0 && <div className="wire-clues"><strong>EMERGENCY DIAGNOSTICS</strong>{mg.clues.map((clue) => <WireClue key={clue} clue={clue} />)}</div>}<div className="wire-grid">{mg.wires.map((wire) => { const visual = WIRE_VISUALS[wire]; return <button key={wire} className={`wire-button wire-button--${wire}`} onClick={() => { conn.minigameAction({ kind: 'cut', wire }); playSound('click'); }}><span className="wire-button__icon" aria-hidden="true">{visual.emoji} {visual.shape}</span><span>{visual.label}</span></button>; })}</div></>;
  }
  if (mg.role === 'support') {
    return <>{showcase}<div className="wire-clues wire-clues--support"><strong>YOUR CLUE</strong>{mg.clues.map((clue) => <WireClue key={clue} clue={clue} />)}<em>TELL THE MPC.</em></div></>;
  }
  return <>{showcase}<p className="hint center">Watching {nameOf(view.mpcId)} decide which wire to cut&hellip;</p></>;
};
