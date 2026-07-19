import { useState } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';
interface SpellingView { role: 'mpc' | 'support' | 'spectator'; stage: 'study' | 'recall'; studyWord?: string; mask?: string[]; supportReveals?: number; prompt?: { id: number; options: string[] } | null; }
export const SpellingPanicMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as SpellingView | undefined; const [word, setWord] = useState(''); if (!mg) return null;
  const showcase = <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />;
  if (view.phase === 'round_resolution') return <p className="hint center">{mg.supportReveals ?? 0} team letter reveal(s).</p>;
  if (mg.role === 'mpc') return <>{showcase}{mg.stage === 'study' ? <><p className="typing-progress">MEMORIZE THIS</p><p className="spelling-word">{mg.studyWord?.toUpperCase()}</p></> : <><p className="typing-progress">SPELL IT.</p><p className="spelling-mask">{mg.mask?.join(' ')}</p><form className="spelling-form" onSubmit={(event) => { event.preventDefault(); conn.minigameAction({ kind: 'submit', word }); playSound('click'); }}><input className="typing-input" value={word} onChange={(event) => setWord(event.target.value)} autoComplete="off" /><button className="btn btn--primary" disabled={!word.trim()}>SUBMIT</button></form></>}</>;
  if (mg.role === 'support') return <>{showcase}{mg.stage === 'study' ? <p className="hint center">The word is being shown to {nameOf(view.mpcId)}&hellip;</p> : <div className="spelling-support"><p className="typing-progress">HELP REVEAL A LETTER</p><p>WHICH IS SPELLED CORRECTLY?</p>{mg.prompt?.options.map((option, index) => <button className="btn btn--ghost" key={option} onClick={() => { conn.minigameAction({ kind: 'support_answer', promptId: mg.prompt!.id, optionIndex: index }); playSound('click'); }}>{option.toUpperCase()}</button>)}</div>}</>;
  return <>{showcase}<p className="hint center">Watching {nameOf(view.mpcId)} spell under pressure&hellip;</p></>;
};
