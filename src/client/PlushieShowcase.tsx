import { useEffect, useRef, useState } from 'react';
import type { Machine, Plushie } from '../shared/game';
import { PlushieStage } from './PlushieStage';
import { modelFor, type PlushieAnimation } from './models';

/**
 * The 3D hero moment: the rescued animal on a spotlight, playing one of its
 * built-in animation clips (typically `dance`). Renders the emoji stage as a
 * graceful fallback while the viewer loads, for species without a model, and
 * whenever the model fails to load. @google/model-viewer (which pulls in
 * three.js) is imported lazily so it never weighs down the initial bundle.
 */
export function PlushieShowcase({
  plushie,
  mood,
  animation,
  machine,
  compact,
}: {
  plushie: Plushie | null;
  mood: string;
  animation: PlushieAnimation;
  machine: Machine;
  /** Smaller viewer for busy screens (active minigames). */
  compact?: boolean;
}) {
  const src = plushie ? modelFor(plushie.species) : undefined;
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

  // model-viewer reports a bad/unloadable GLB via a custom 'error' event,
  // which React doesn't expose as a prop — listen manually.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onError = () => setViewerState('failed');
    el.addEventListener('error', onError);
    return () => el.removeEventListener('error', onError);
  }, [viewerState]);

  if (!plushie) return null;
  if (!src || viewerState !== 'ready') return <PlushieStage plushie={plushie} mood={mood} machine={machine} />;

  return (
    <div className={`showcase ${compact ? 'showcase--compact' : ''}`}>
      <model-viewer
        ref={viewerRef}
        className="showcase__viewer"
        src={src}
        alt={plushie.name}
        autoplay
        animation-name={animation}
        camera-orbit="0deg 78deg 105%"
        shadow-intensity="1"
        interaction-prompt="none"
        disable-zoom
        disable-tap
      />
      <div className="stage__name">
        {plushie.name} <span className="stage__mood">{mood}</span>
      </div>
    </div>
  );
}
