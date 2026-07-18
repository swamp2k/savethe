import { useLayoutEffect, useRef } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIComponent } from './types';

interface PlatformerView {
  role: 'mpc' | 'support' | 'spectator';
  obstaclesCleared: number;
  requiredObstacles: number;
  obstacleWindowMs: number;
  supportClears: number;
  obstacleId?: number;
  obstacleType?: 'jump' | 'duck';
  myObstacleType?: 'jump' | 'duck';
}

const OBSTACLE_LABEL: Record<'jump' | 'duck', string> = { jump: 'JUMP!', duck: 'DUCK!' };
const OBSTACLE_EMOJI: Record<'jump' | 'duck', string> = { jump: '🪨', duck: '🪵' };

export const PlatformerMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as PlatformerView | undefined;

  // Same fairness mechanism as Reaction Test's goAtRef / Aim Trainer's
  // spawnedAtRef (PLAN.md decision 3): timestamp the moment THIS browser
  // renders the current obstacle, keyed on obstacleId (not type — two
  // obstacles in a row can share a type).
  const spawnedAtRef = useRef<number | null>(null);
  const obstacleId = mg?.role === 'mpc' ? mg.obstacleId : undefined;
  useLayoutEffect(() => {
    if (obstacleId === undefined) {
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
  }, [obstacleId]);

  if (!mg) return null;

  if (view.phase === 'round_resolution') {
    const assist = mg.supportClears > 0 ? ` — ${mg.supportClears} team assist${mg.supportClears === 1 ? '' : 's'}` : '';
    return (
      <p className="hint center">
        {mg.obstaclesCleared}/{mg.requiredObstacles} obstacles{assist}.
      </p>
    );
  }

  const react = (response: 'jump' | 'duck') => {
    const elapsedMs = spawnedAtRef.current !== null ? Date.now() - spawnedAtRef.current : 0;
    conn.minigameAction({ kind: 'react', response, elapsedMs });
    playSound('click');
  };

  if (mg.role === 'mpc') {
    return (
      <>
        <p className="typing-progress">
          {mg.obstaclesCleared} / {mg.requiredObstacles} cleared
        </p>
        <div className="platformer-lane">
          {mg.obstacleType && (
            <span key={obstacleId} className="platformer-obstacle" style={{ animationDuration: `${mg.obstacleWindowMs}ms` }}>
              {OBSTACLE_EMOJI[mg.obstacleType]}
            </span>
          )}
        </div>
        <div className="actions__row">
          <button className="btn btn--primary" onClick={() => react('jump')}>
            {OBSTACLE_LABEL.jump}
          </button>
          <button className="btn btn--primary" onClick={() => react('duck')}>
            {OBSTACLE_LABEL.duck}
          </button>
        </div>
      </>
    );
  }

  if (mg.role === 'support') {
    return (
      <>
        <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
        <p className="hint">
          Help {nameOf(view.mpcId)}! ({mg.supportClears} completed)
        </p>
        <div className="platformer-lane">
          {mg.myObstacleType && <span className="platformer-obstacle platformer-obstacle--static">{OBSTACLE_EMOJI[mg.myObstacleType]}</span>}
        </div>
        <div className="actions__row">
          <button className="btn btn--primary" onClick={() => react('jump')}>
            {OBSTACLE_LABEL.jump}
          </button>
          <button className="btn btn--primary" onClick={() => react('duck')}>
            {OBSTACLE_LABEL.duck}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
      <p className="typing-progress">
        {mg.obstaclesCleared} / {mg.requiredObstacles} cleared
      </p>
      <p className="hint center">Watching {nameOf(view.mpcId)} run&hellip;</p>
    </>
  );
};
