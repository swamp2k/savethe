import { useLayoutEffect, useRef } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

interface Attempt { attemptId: number; periodMs: number; zoneCenter: number; zoneWidth: number; }
interface NeedleView { role: 'mpc' | 'support' | 'spectator'; hits: number; requiredHits: number; supportBoosts: number; attempt?: Attempt; }

function NeedleTrack({ attempt, onStop }: { attempt: Attempt; onStop: (attemptId: number, elapsedMs: number) => void }) {
  const pointerRef = useRef<HTMLSpanElement | null>(null);
  const animationRef = useRef<Animation | null>(null);

  useLayoutEffect(() => {
    const pointer = pointerRef.current;
    if (!pointer) return;
    // The compositor draws from this Animation's timeline, and the click reads
    // that exact same timeline. No per-frame React render can lag behind it.
    const animation = pointer.animate(
      [{ left: '0%' }, { left: '100%' }, { left: '0%' }],
      { duration: attempt.periodMs, iterations: Infinity, easing: 'linear' },
    );
    animationRef.current = animation;
    return () => {
      animation.cancel();
      if (animationRef.current === animation) animationRef.current = null;
    };
  }, [attempt.attemptId, attempt.periodMs]);

  const stop = () => {
    const currentTime = animationRef.current?.currentTime;
    if (typeof currentTime !== 'number') return;
    animationRef.current?.pause();
    onStop(attempt.attemptId, Math.round(currentTime));
  };

  return (
    <button className="needle-track" onClick={stop} aria-label="Stop the needle">
      <span className="needle-zone" style={{ left: `${(attempt.zoneCenter - attempt.zoneWidth / 2) * 100}%`, width: `${attempt.zoneWidth * 100}%` }} />
      <span ref={pointerRef} className="needle-pointer">▲</span>
    </button>
  );
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
