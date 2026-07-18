import type { Plushie } from '../shared/game';

export function PlushieStage({ plushie, mood }: { plushie: Plushie | null; mood: string }) {
  if (!plushie) return null;
  return (
    <div className="stage">
      <div className="stage__press">🏭</div>
      <div className="stage__plushie">
        <span className="stage__emoji">{plushie.emoji}</span>
        <span className="stage__mood">{mood}</span>
      </div>
      <div className="stage__name">{plushie.name}</div>
    </div>
  );
}
