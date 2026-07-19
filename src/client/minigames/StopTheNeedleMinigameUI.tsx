import { useLayoutEffect, useRef, useState } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

interface Attempt { attemptId: number; periodMs: number; zoneCenter: number; zoneWidth: number; }
interface NeedleView { role: 'mpc' | 'support' | 'spectator'; hits: number; requiredHits: number; supportBoosts: number; attempt?: Attempt; }

function NeedleTrack({ attempt, onStop }: { attempt: Attempt; onStop: (attemptId: number, elapsedMs: number) => void }) {
  const startedAtRef = useRef<number | null>(null);
  const [position, setPosition] = useState(0);
  useLayoutEffect(() => {
    let raf = 0;
    let raf2 = 0;
    const begin = () => {
      startedAtRef.current = performance.now();
      const animate = () => {
        const elapsed = performance.now() - (startedAtRef.current ?? performance.now());
        const phase = (elapsed % attempt.periodMs) / attempt.periodMs;
        setPosition(phase <= 0.5 ? phase * 2 : (1 - phase) * 2);
        raf = requestAnimationFrame(animate);
      };
      raf = requestAnimationFrame(animate);
    };
    raf2 = requestAnimationFrame(() => { raf = requestAnimationFrame(begin); });
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); };
  }, [attempt.attemptId, attempt.periodMs]);
  const elapsed = () => Math.round(performance.now() - (startedAtRef.current ?? performance.now()));
  return <button className="needle-track" onClick={() => onStop(attempt.attemptId, elapsed())} aria-label="Stop the needle"><span className="needle-zone" style={{ left: `${(attempt.zoneCenter - attempt.zoneWidth / 2) * 100}%`, width: `${attempt.zoneWidth * 100}%` }} /><span className="needle-pointer" style={{ left: `${position * 100}%` }}>▲</span></button>;
}

export const StopTheNeedleMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as NeedleView | undefined;
  if (!mg) return null;
  const stop = (attemptId: number, elapsedMs: number) => { conn.minigameAction({ kind: 'stop', attemptId, elapsedMs }); playSound('click'); };
  const showcase = <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />;
  if (view.phase === 'round_resolution') return <p className="hint center">{mg.hits}/{mg.requiredHits} locks, {mg.supportBoosts} support boost(s).</p>;
  if (mg.role === 'spectator') return <>{showcase}<p className="typing-progress">{mg.hits} / {mg.requiredHits} LOCKS</p><p className="hint center">Watching {nameOf(view.mpcId)} hold their nerve&hellip;</p></>;
  return <>{showcase}<p className="typing-progress">{mg.role === 'mpc' ? 'STOP THE NEEDLE' : 'WIDEN THE TARGET!'}</p><p className="hint center">{mg.hits} / {mg.requiredHits} locks · {mg.supportBoosts} support boost(s)</p>{mg.attempt && <NeedleTrack attempt={mg.attempt} onStop={stop} />}{mg.role === 'support' && <p className="hint center">A good stop immediately widens the MPC&apos;s target.</p>}</>;
};
