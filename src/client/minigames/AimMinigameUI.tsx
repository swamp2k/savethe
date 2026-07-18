import { useLayoutEffect, useRef } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

interface AimView {
  role: 'mpc' | 'support' | 'spectator';
  hits: number;
  requiredHits: number;
  misses: number;
  supportHits: number;
  hitThresholdMs: number;
  targetId?: number;
  targetX?: number;
  targetY?: number;
}

export const AimMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as AimView | undefined;

  // Same fairness mechanism as Reaction Test's goAtRef (PLAN.md decision 3):
  // timestamp the moment THIS browser renders the current target, not any
  // server time, and measure elapsed time from there. Keyed on targetId, so
  // a fresh target — whether from a hit, a miss, or a natural expiry —
  // always resets the clock.
  const spawnedAtRef = useRef<number | null>(null);
  const targetId = mg?.targetId;
  useLayoutEffect(() => {
    if (targetId === undefined) {
      spawnedAtRef.current = null;
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        spawnedAtRef.current = Date.now();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [targetId]);

  if (!mg) return null;

  if (view.phase === 'round_resolution') {
    const assist = mg.supportHits > 0 ? ` — ${mg.supportHits} team assist${mg.supportHits === 1 ? '' : 's'}` : '';
    return (
      <p className="hint center">
        {mg.hits}/{mg.requiredHits} hits{assist}.
      </p>
    );
  }

  const handleHit = () => {
    if (targetId === undefined) return;
    const elapsedMs = spawnedAtRef.current !== null ? Date.now() - spawnedAtRef.current : 0;
    conn.minigameAction({ kind: 'hit', targetId, elapsedMs });
    playSound('click');
  };

  if (mg.role === 'mpc' || mg.role === 'support') {
    return (
      <>
        <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
        <p className="typing-progress">
          {mg.hits} / {mg.requiredHits} hits
        </p>
        <div className="aim-range">
          {targetId !== undefined && (
            <button
              key={targetId}
              className="aim-target"
              style={{
                left: `${(mg.targetX ?? 0.5) * 100}%`,
                top: `${(mg.targetY ?? 0.5) * 100}%`,
                animationDuration: `${mg.hitThresholdMs}ms`,
              }}
              onClick={handleHit}
              aria-label="Target"
            >
              🎯
            </button>
          )}
        </div>
        {mg.role === 'support' && (
          <p className="hint center">
            Helping {nameOf(view.mpcId)} — {mg.supportHits} hit{mg.supportHits === 1 ? '' : 's'} so far
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
      <p className="typing-progress">
        {mg.hits} / {mg.requiredHits} hits
      </p>
      <p className="hint center">Watching {nameOf(view.mpcId)} aim&hellip;</p>
    </>
  );
};
