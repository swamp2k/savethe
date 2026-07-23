import type { Machine, Plushie } from '../shared/game';
import { PlushieShowcase } from './PlushieShowcase';

export function DoomSpectacle({ plushie, machine, outcome }: { plushie: Plushie; machine: Machine; outcome: 'success' | 'failure' }) {
  const doomed = outcome === 'failure';
  const label = doomed
    ? machine === 'press' ? `${plushie.name} is squashed by the Hydraulic Press` : `${plushie.name} is launched into space by the cannon`
    : `${plushie.name} is pulled safely away from the ${machine === 'press' ? 'Hydraulic Press' : 'cannon'}`;
  return (
    <div className={`spectacle spectacle--${machine} spectacle--${outcome}`} role="img" aria-label={label}>
      <div className="spectacle__machine" aria-hidden="true">
        {machine === 'press'
          ? <><span className="spectacle__press-roof" /><span className="spectacle__press-ram" /><span className="spectacle__press-bed" /></>
          : <><span className="spectacle__cannon-barrel" /><span className="spectacle__cannon-wheel">⚙️</span><span className="spectacle__cannon-smoke">☁️</span><span className="spectacle__muzzle-flash">💥</span></>}
      </div>
      {!doomed && <div className="spectacle__rescue-line" aria-hidden="true">🪝</div>}
      <div className="spectacle__plushie">
        <PlushieShowcase plushie={plushie} mood={doomed ? '😵' : '😄'} animation={doomed ? 'gesture-negative' : 'dance'} machine={machine} showMachine={false} />
      </div>
      <div className="spectacle__burst" aria-hidden="true">{(machine === 'press' ? ['☁️', '✦', '🧶', '✦', '☁️'] : ['⭐', '✨', '🌟', '✨', '⭐']).map((particle, index) => <span key={index}>{particle}</span>)}</div>
      <div className="spectacle__caption">{doomed ? machine === 'press' ? 'CARTOON CRUNCH!' : 'YEETED INTO SPACE!' : 'RESCUE LINE: CLEAR!'}</div>
    </div>
  );
}
