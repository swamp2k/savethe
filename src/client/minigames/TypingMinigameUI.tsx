import { useEffect, useState } from 'react';
import { PlushieStage } from '../PlushieStage';
import type { MinigameUIComponent } from './types';

interface TypingView {
  role: 'mpc' | 'support' | 'spectator';
  passageWords: string[];
  wordsCorrect: number;
  wordsRequired: number;
  totalSupportCompletions: number;
  myPhraseWords?: string[];
  myCompletedCount?: number;
}

type WordStatus = 'correct' | 'active-ok' | 'active-bad' | 'pending';

/**
 * Client-side mirror of the server's word-matching rule, purely for instant
 * visual feedback as the player types (no round trip). The server's count is
 * still the only one that decides the outcome — this can never credit
 * progress the server wouldn't also credit, it just shows it sooner.
 */
function wordStatuses(target: string[], typed: string): WordStatus[] {
  const trimmed = typed.trim();
  const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const sealed = typed.endsWith(' ') || tokens.length >= target.length;
  const sealedCount = sealed ? tokens.length : tokens.length - 1;

  const statuses: WordStatus[] = [];
  for (let i = 0; i < target.length; i++) {
    if (i < sealedCount) {
      if (tokens[i]?.toLowerCase() === target[i].toLowerCase()) {
        statuses.push('correct');
        continue;
      }
      statuses.push('active-bad');
      break;
    }
    if (i === sealedCount && tokens[i] !== undefined) {
      const partial = tokens[i].toLowerCase();
      statuses.push(target[i].toLowerCase().startsWith(partial) ? 'active-ok' : 'active-bad');
    }
    break;
  }
  while (statuses.length < target.length) statuses.push('pending');
  return statuses;
}

function Passage({ words, typed }: { words: string[]; typed: string }) {
  const statuses = wordStatuses(words, typed);
  return (
    <p className="typing-passage">
      {words.map((w, i) => (
        <span key={i} className={`typing-word typing-word--${statuses[i]}`}>
          {w}{' '}
        </span>
      ))}
    </p>
  );
}

export const TypingMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as TypingView | undefined;
  const [mpcText, setMpcText] = useState('');
  const [supportText, setSupportText] = useState('');

  // A completed phrase gets replaced server-side; clear the local box so it
  // doesn't keep showing the just-finished (now stale) phrase's leftovers.
  const myCompletedCount = mg?.myCompletedCount ?? 0;
  useEffect(() => {
    setSupportText('');
  }, [myCompletedCount]);

  if (!mg) return null;

  if (view.phase === 'round_resolution') {
    const assist =
      mg.totalSupportCompletions > 0
        ? ` — ${mg.totalSupportCompletions} team assist${mg.totalSupportCompletions === 1 ? '' : 's'}`
        : '';
    return (
      <p className="hint center">
        {mg.wordsCorrect}/{mg.wordsRequired} words typed{assist}.
      </p>
    );
  }

  if (mg.role === 'mpc') {
    return (
      <>
        <PlushieStage plushie={view.currentPlushie} mood="😰" />
        <p className="typing-progress">
          {mg.wordsCorrect} / {mg.wordsRequired} words
        </p>
        <Passage words={mg.passageWords} typed={mpcText} />
        <input
          className="typing-input"
          value={mpcText}
          onChange={(e) => {
            setMpcText(e.target.value);
            conn.minigameAction({ kind: 'type', text: e.target.value });
          }}
          placeholder="Start typing…"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </>
    );
  }

  if (mg.role === 'support') {
    const phrase = mg.myPhraseWords ?? [];
    return (
      <>
        <PlushieStage plushie={view.currentPlushie} mood="😰" />
        <p className="hint">
          Type your phrase to help {nameOf(view.mpcId)}! ({myCompletedCount} completed)
        </p>
        <Passage words={phrase} typed={supportText} />
        <input
          className="typing-input"
          value={supportText}
          onChange={(e) => {
            setSupportText(e.target.value);
            conn.minigameAction({ kind: 'type', text: e.target.value });
          }}
          placeholder="Type here…"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </>
    );
  }

  return (
    <>
      <PlushieStage plushie={view.currentPlushie} mood="😰" />
      <p className="typing-progress">
        {mg.wordsCorrect} / {mg.wordsRequired} words
      </p>
      <p className="hint center">Watching {nameOf(view.mpcId)} type furiously&hellip;</p>
    </>
  );
};
