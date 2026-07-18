import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { modelFor, randomModeledSpecies } from '../models';
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

/** One-line how-to, always visible: playtesting showed a lone obstacle emoji
 *  in an empty lane reads as "…now what?" without it. */
function Legend() {
  return (
    <p className="hint center platformer-legend">
      🪨 rock → <strong>JUMP</strong> over it &nbsp;·&nbsp; 🪵 log → <strong>DUCK</strong> under it
    </p>
  );
}

/**
 * The runner: a random plushie GLB sprinting in place via its built-in `run`
 * clip (every Cube Pets rig has one), cast fresh each round — purely cosmetic
 * and client-side, so different players may see different animals. Pressing
 * JUMP hops the whole model in an arc; DUCK squashes it flat from the feet
 * up. The emoji stands in while the viewer loads or for a failed model.
 */
function Runner({ action, onActionDone }: { action: 'jump' | 'duck' | null; onActionDone: () => void }) {
  const [species] = useState(randomModeledSpecies);
  const src = modelFor(species);
  const [viewerState, setViewerState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const viewerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!src) return;
    let alive = true;
    import('@google/model-viewer').then(
      () => alive && setViewerState('ready'),
      () => alive && setViewerState('failed'),
    );
    return () => {
      alive = false;
    };
  }, [src]);

  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onError = () => setViewerState('failed');
    el.addEventListener('error', onError);
    return () => el.removeEventListener('error', onError);
  }, [viewerState]);

  const actionClass =
    action === 'jump' ? 'platformer-runner--jump' : action === 'duck' ? 'platformer-runner--duck' : '';
  return (
    <span className={`platformer-runner ${actionClass}`} onAnimationEnd={onActionDone}>
      {src && viewerState === 'ready' ? (
        <model-viewer
          ref={viewerRef}
          className="platformer-runner__viewer"
          src={src}
          alt="Your runner"
          autoplay
          animation-name="run"
          loading="eager"
          camera-orbit="-90deg 80deg 105%"
          shadow-intensity="0.6"
          interaction-prompt="none"
          disable-zoom
          disable-tap
        />
      ) : (
        <span className="platformer-runner__emoji">🏃</span>
      )}
    </span>
  );
}

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

  // The runner acts out whatever the player just pressed (hop or squash),
  // regardless of whether the server ends up counting it — it's feedback for
  // the button press, not the verdict.
  const [runnerAction, setRunnerAction] = useState<'jump' | 'duck' | null>(null);

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
    setRunnerAction(response);
    playSound('click');
  };

  const lane = (obstacle: React.ReactNode) => (
    <div className="platformer-lane">
      <Runner action={runnerAction} onActionDone={() => setRunnerAction(null)} />
      {obstacle}
    </div>
  );

  const buttons = (
    <div className="actions__row">
      <button className="btn btn--primary" onClick={() => react('jump')}>
        {OBSTACLE_LABEL.jump}
      </button>
      <button className="btn btn--primary" onClick={() => react('duck')}>
        {OBSTACLE_LABEL.duck}
      </button>
    </div>
  );

  if (mg.role === 'mpc') {
    return (
      <>
        <p className="typing-progress">
          {mg.obstaclesCleared} / {mg.requiredObstacles} cleared
        </p>
        <Legend />
        {lane(
          mg.obstacleType && (
            <span key={obstacleId} className="platformer-obstacle" style={{ animationDuration: `${mg.obstacleWindowMs}ms` }}>
              {OBSTACLE_EMOJI[mg.obstacleType]}
            </span>
          ),
        )}
        <p className="hint center">Hit the right button before it reaches you!</p>
        {buttons}
      </>
    );
  }

  if (mg.role === 'support') {
    return (
      <>
        <PlushieShowcase plushie={view.currentPlushie} mood="😰" animation="idle" machine={view.machine} compact />
        <p className="hint">
          Clear your own obstacle to shorten {nameOf(view.mpcId)}&rsquo;s run! ({mg.supportClears} cleared)
        </p>
        <Legend />
        {lane(
          mg.myObstacleType && (
            <span className="platformer-obstacle platformer-obstacle--static">{OBSTACLE_EMOJI[mg.myObstacleType]}</span>
          ),
        )}
        {buttons}
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
