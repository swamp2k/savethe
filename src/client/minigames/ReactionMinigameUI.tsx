import { useLayoutEffect, useRef } from 'react';
import { PlushieStage } from '../PlushieStage';
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

  const handleClick = () => {
    const elapsedMs = goAtRef.current !== null ? Date.now() - goAtRef.current : 0;
    conn.minigameAction({ kind: 'click', elapsedMs });
  };

  return (
    <>
      <PlushieStage plushie={view.currentPlushie} mood={MOOD_FOR_STAGE[mg.stage]} />

      {mg.role === 'mpc' && mg.stage === 'mpc_ready' && (
        <div className="actions">
          <p className="hint">Press ready when you&rsquo;re prepared. Then wait for it&hellip;</p>
          <button
            className="btn reaction-target reaction-target--ready"
            onClick={() => conn.minigameAction({ kind: 'ready' })}
          >
            I&rsquo;M READY
          </button>
        </div>
      )}

      {mg.role === 'mpc' && (mg.stage === 'mpc_waiting' || mg.stage === 'mpc_go') && (
        <div className="actions">
          <p className="hint">React in {mg.mpcThresholdMs}ms or less!</p>
          <button
            className={`btn reaction-target ${mg.stage === 'mpc_go' ? 'reaction-target--go' : 'reaction-target--wait'}`}
            onClick={handleClick}
          >
            {mg.stage === 'mpc_go' ? 'CLICK!' : 'Wait for it…'}
          </button>
        </div>
      )}

      {mg.role === 'mpc' && (mg.stage === 'support_waiting' || mg.stage === 'support_go') && (
        <p className="hint center">
          {mg.mpc?.falseStart ? 'FALSE START!' : `You reacted in ${mg.mpc?.elapsedMs}ms — too slow.`} Your team is
          trying to save it&hellip;
        </p>
      )}

      {mg.role === 'support' && (mg.stage === 'mpc_ready' || mg.stage === 'mpc_waiting' || mg.stage === 'mpc_go') && (
        <p className="hint center">Waiting to see if {nameOf(view.mpcId)} can save it&hellip;</p>
      )}

      {mg.role === 'support' &&
        (mg.stage === 'support_waiting' || mg.stage === 'support_go') &&
        (mg.canClick ? (
          <div className="actions">
            <p className="hint">EMERGENCY! React in {mg.supportThresholdMs}ms or less!</p>
            <button
              className={`btn btn--doom reaction-target ${mg.stage === 'support_go' ? 'reaction-target--go' : 'reaction-target--wait'}`}
              onClick={handleClick}
            >
              {mg.stage === 'support_go' ? 'RESCUE!' : 'Get ready…'}
            </button>
          </div>
        ) : (
          <p className="hint center">
            {mg.savedBy ? `Rescued by ${nameOf(mg.savedBy)}!` : 'Your shot is used. Watching the others…'}
          </p>
        ))}

      {mg.role === 'spectator' && <p className="hint center">Watching the chaos unfold&hellip;</p>}
    </>
  );
};

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
