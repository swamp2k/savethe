import { MACHINES, type Machine, type Plushie } from '../shared/game';

export function PlushieStage({
  plushie,
  mood,
  machine,
}: {
  plushie: Plushie | null;
  mood: string;
  machine: Machine;
}) {
  if (!plushie) return null;
  return (
    <div className="stage">
      <div className="stage__press">{MACHINES[machine].emoji}</div>
      <div className="stage__plushie">
        <span className="stage__emoji">{plushie.emoji}</span>
        <span className="stage__mood">{mood}</span>
      </div>
      <div className="stage__name">{plushie.name}</div>
    </div>
  );
}
