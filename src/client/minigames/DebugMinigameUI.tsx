import { PlushieShowcase } from '../PlushieShowcase';
import type { MinigameUIComponent } from './types';

interface DebugView {
  role: 'mpc' | 'support' | 'spectator';
  canAct: string[];
  mpcChoice: 'none' | 'save' | 'doom';
  rescuedBy: string | null;
}

export const DebugMinigameUI: MinigameUIComponent = ({ conn, view, nameOf }) => {
  const mg = view.minigame?.view as DebugView | undefined;
  if (!mg) return null;

  if (view.phase === 'round_resolution') {
    return (
      <p className="hint center">
        MPC chose {mg.mpcChoice}
        {mg.rescuedBy ? `, rescued by ${nameOf(mg.rescuedBy)}` : ''}.
      </p>
    );
  }

  return (
    <>
      <PlushieShowcase plushie={view.currentPlushie} mood="😨" animation="idle" machine={view.machine} compact />

      {mg.role === 'mpc' && (
        <div className="actions">
          <p className="hint">You are the MPC. Save the plushie!</p>
          {mg.canAct.includes('save') ? (
            <div className="actions__row">
              <button className="btn btn--save" onClick={() => conn.minigameAction({ kind: 'save' })}>
                SAVE
              </button>
              <button className="btn btn--doom" onClick={() => conn.minigameAction({ kind: 'doom' })}>
                DOOM
              </button>
            </div>
          ) : (
            <p className="hint">You pressed {mg.mpcChoice}. Now everyone waits…</p>
          )}
        </div>
      )}

      {mg.role === 'support' && (
        <div className="actions">
          <p className="hint">Support — you can rescue if the MPC fumbles.</p>
          {mg.canAct.includes('rescue') ? (
            <button className="btn btn--save" onClick={() => conn.minigameAction({ kind: 'rescue' })}>
              RESCUE!
            </button>
          ) : (
            <p className="hint">Rescue used{mg.rescuedBy ? ` by ${nameOf(mg.rescuedBy)}` : ''}.</p>
          )}
        </div>
      )}

      {mg.role === 'spectator' && <p className="hint">Watching {nameOf(view.mpcId)} sweat…</p>}
    </>
  );
};
