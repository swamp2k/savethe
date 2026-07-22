import { useState } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

interface SpellingView {
  role: 'mpc' | 'support' | 'spectator';
  stage: 'study' | 'recall';
  studyWord?: string;
  mask?: string[];
  supportReveals: number;
  supportGoal: number;
  supportSavedBy: string | null;
  prompt?: { id: number; options: string[] } | null;
}

export const SpellingPanicMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as SpellingView | undefined;
  const [word, setWord] = useState('');
  if (!mg) return null;
  const supportProgress = `${mg.supportReveals}/${mg.supportGoal} HIDDEN LETTERS RECOVERED`;
  if (view.phase === 'round_resolution') return <p className="hint center">{mg.supportSavedBy ? `Team rescue by ${nameOf(mg.supportSavedBy)} — ` : ''}{supportProgress.toLowerCase()}.</p>;
  const showcase = <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />;

  if (mg.role === 'mpc') return <>{showcase}{mg.stage === 'study' ? <><p className="typing-progress">MEMORIZE THIS</p><p className="spelling-word">{mg.studyWord?.toUpperCase()}</p></> : <><p className="typing-progress">SPELL IT · {supportProgress}</p><p className="spelling-mask">{mg.mask?.join(' ')}</p><form className="spelling-form" onSubmit={(event) => { event.preventDefault(); conn.minigameAction({ kind: 'submit', word }); playSound('click'); }}><input className="typing-input" value={word} onChange={(event) => setWord(event.target.value)} autoComplete="off" /><button className="btn btn--primary" disabled={!word.trim()}>SUBMIT</button></form></>}</>;

  if (mg.role === 'support') return <>{showcase}{mg.stage === 'study' ? <p className="hint center">The word is being shown to {nameOf(view.mpcId)}&hellip;</p> : <div className="spelling-support"><p className="typing-progress">RESCUE THE WORD · {supportProgress}</p><p>Recover every hidden letter and your team wins, even if the MPC is stuck. Which spelling is correct?</p>{mg.prompt?.options.map((option, index) => <button className="btn btn--ghost" key={option} onClick={() => { conn.minigameAction({ kind: 'support_answer', promptId: mg.prompt!.id, optionIndex: index }); playSound('click'); }}>{option.toUpperCase()}</button>)}</div>}</>;

  return <>{showcase}<p className="typing-progress">{supportProgress}</p><p className="hint center">Watching {nameOf(view.mpcId)} spell under pressure&hellip;</p></>;
};
