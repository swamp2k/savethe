import { useLayoutEffect, useRef } from 'react';
import { PlushieShowcase } from '../PlushieShowcase';
import { playSound } from '../sound';
import type { MinigameUIProps, MinigameUIComponent } from './types';

type Stage = 'mpc_ready' | 'mpc_waiting' | 'mpc_go' | 'support_waiting' | 'support_go';

interface Attempt {
  elapsedMs: number;
  falseStart: boolean;
}

interface ReactionView {
  role: 'mpc' | 'support' | 'spectator';
  stage: Stage;
  canReady: boolean;
  canClick: boolean;
  mpcThresholdMs: number;
  supportThresholdMs: number;
  mpc: Attempt | null;
  supportResults: Record<string, Attempt>;
  savedBy: string | null;
}

// Escalating peril as the round moves from "waiting to begin" through the
// MPC's shot to the team's emergency rescue window (design doc section 32).
const MOOD_FOR_STAGE: Record<Stage, string> = {
  mpc_ready: '😐',
  mpc_waiting: '😐',
  mpc_go: '😟',
  support_waiting: '😨',
  support_go: '😨',
};

export const ReactionMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as ReactionView | undefined;

  // The client's own clock is the fairness mechanism (PLAN.md decision 3): we
  // record the moment THIS browser renders the go signal, not any
  // server-provided timestamp (there isn't one — the server never reveals
  // when the signal will fire), and measure elapsed time from there.
  //
  // A plain `useEffect` fires after the browser paints, so timestamping there
  // would (slightly) understate the true reaction time. A double
  // requestAnimationFrame reliably lands right after the paint for the frame
  // that applied this state change, which is the closest a browser lets us
  // get to "the instant the go signal became visible."
  const goAtRef = useRef<number | null>(null);
  const stage = mg?.stage;
  const isGo = stage === 'mpc_go' || stage === 'support_go';
  useLayoutEffect(() => {
    if (!isGo) {
      goAtRef.current = null;
      return;
    }
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        goAtRef.current = Date.now();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isGo]);

  if (!mg) return null;

  if (view.phase === 'round_resolution') {
    return <StatReveal mg={mg} view={view} nameOf={nameOf} />;
  }

  const handlePress = () => {
    if (mg.stage === 'mpc_ready') {
      conn.minigameAction({ kind: 'ready' });
      playSound('click');
      return;
    }
    // Timing-critical: measure and dispatch before anything else (including
    // the click sound) touches the main thread, so audio setup can't inflate
    // the reported reaction time.
    const elapsedMs = goAtRef.current !== null ? Date.now() - goAtRef.current : 0;
    conn.minigameAction({ kind: 'click', elapsedMs });
    playSound('click');
  };

  const mpcTurn = mg.stage === 'mpc_ready' || mg.stage === 'mpc_waiting' || mg.stage === 'mpc_go';
  const supportTurn = mg.stage === 'support_waiting' || mg.stage === 'support_go';

  return (
    <>
      <PlushieShowcase plushie={view.currentPlushie} mood={MOOD_FOR_STAGE[mg.stage]} animation="idle" machine={view.machine} compact />

      {mg.role === 'mpc' && mpcTurn && (
        <SignalLight
          mode={mg.stage === 'mpc_ready' ? 'idle' : mg.stage === 'mpc_waiting' ? 'armed' : 'go'}
          label={mg.stage === 'mpc_ready' ? 'PRESS WHEN READY' : mg.stage === 'mpc_waiting' ? 'WAIT FOR IT' : 'CLICK!'}
          sublabel={mg.stage === 'mpc_ready' ? undefined : `React in ${mg.mpcThresholdMs}ms or less`}
          onClick={handlePress}
        />
      )}

      {mg.role === 'mpc' && supportTurn && (
        <p className="hint center">
          {mg.mpc?.falseStart ? 'FALSE START!' : `You reacted in ${mg.mpc?.elapsedMs}ms — too slow.`} Your team is
          trying to save it&hellip;
        </p>
      )}

      {mg.role === 'support' && mpcTurn && (
        <p className="hint center">Waiting to see if {nameOf(view.mpcId)} can save it&hellip;</p>
      )}

      {mg.role === 'support' && supportTurn && mg.canClick && (
        <SignalLight
          mode={mg.stage === 'support_waiting' ? 'armed' : 'go'}
          label={mg.stage === 'support_waiting' ? 'GET READY' : 'RESCUE!'}
          sublabel={`Emergency! React in ${mg.supportThresholdMs}ms or less`}
          onClick={handlePress}
          urgent
        />
      )}

      {mg.role === 'support' && supportTurn && !mg.canClick && (
        <p className="hint center">
          {mg.savedBy ? `Rescued by ${nameOf(mg.savedBy)}!` : 'Your shot is used. Watching the others…'}
        </p>
      )}

      {mg.role === 'spectator' && <p className="hint center">Watching the chaos unfold&hellip;</p>}
    </>
  );
};

/**
 * A single persistent element that just changes color/label/animation as the
 * round progresses, rather than swapping between differently-sized buttons —
 * that swap was the original source of a layout-shift bug (the ready button
 * and the click target had different box sizes), and reusing one element
 * makes the class of bug structurally impossible instead of just tuned away.
 * No numeric countdown anywhere: idle (gray, "press when ready") -> armed
 * (pulsing amber/red, "wait for it" — never predicts *when*) -> go (an
 * instant, unmistakable green flash). A traffic light, not a stopwatch.
 */
function SignalLight({
  mode,
  label,
  sublabel,
  onClick,
  urgent,
}: {
  mode: 'idle' | 'armed' | 'go';
  label: string;
  sublabel?: string;
  onClick: () => void;
  urgent?: boolean;
}) {
  return (
    <div className="signal">
      <button
        className={`signal__light signal__light--${mode} ${urgent && mode !== 'idle' ? 'signal__light--urgent' : ''}`}
        onClick={onClick}
      >
        {label}
      </button>
      <p className="hint signal__sublabel">{sublabel ?? ' '}</p>
    </div>
  );
}

function StatReveal({
  mg,
  view,
  nameOf,
}: {
  mg: ReactionView;
  view: MinigameUIProps['view'];
  nameOf: (id: string | null) => string;
}) {
  const rows: { label: string; text: string; win?: boolean }[] = [];
  if (view.mpcId && mg.mpc) {
    const label = view.mpcId === view.youId ? 'You (MPC)' : `${nameOf(view.mpcId)} (MPC)`;
    rows.push({ label, text: mg.mpc.falseStart ? 'FALSE START' : `${mg.mpc.elapsedMs}ms` });
  }
  for (const [playerId, attempt] of Object.entries(mg.supportResults)) {
    const label = playerId === view.youId ? 'You' : nameOf(playerId);
    const win = playerId === mg.savedBy;
    rows.push({ label, text: attempt.falseStart ? 'false start' : `${attempt.elapsedMs}ms`, win });
  }
  if (rows.length === 0) return null;

  return (
    <div className="stat-reveal">
      {rows.map((r) => (
        <div className="stat-reveal__row" key={r.label}>
          <span>{r.label}</span>
          <span className={r.win ? 'stat-reveal__win' : ''}>
            {r.text}
            {r.win ? ' — SAVE!' : ''}
          </span>
        </div>
      ))}
    </div>
  );
}
