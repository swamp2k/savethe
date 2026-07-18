import { useEffect, useRef, useState } from 'react';
import type { Plushie } from '../shared/game';
import { modelFor } from './models';

/**
 * Full-screen modal for admiring a single plushie: the GLB on a turntable
 * with camera controls enabled (drag to orbit, wheel/pinch to zoom) — unlike
 * the in-game showcase, which locks the camera so nobody fat-fingers their
 * view mid-challenge. Species without a model (or a failed load) fall back
 * to a big emoji so the modal is never empty. Click anywhere outside the
 * card (or the ✕) to close; Escape works too.
 */
export function PlushieInspector({ plushie, onClose }: { plushie: Plushie; onClose: () => void }) {
  const src = modelFor(plushie.species);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="inspector" onClick={onClose} role="dialog" aria-label={`${plushie.name} up close`}>
      <div className="inspector__card" onClick={(e) => e.stopPropagation()}>
        <button className="inspector__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {src && viewerState === 'ready' ? (
          <model-viewer
            ref={viewerRef}
            className="inspector__viewer"
            src={src}
            alt={plushie.name}
            autoplay
            animation-name="dance"
            camera-controls
            auto-rotate
            camera-orbit="0deg 78deg 105%"
            shadow-intensity="1"
            interaction-prompt="none"
          />
        ) : (
          <div className="inspector__fallback">{plushie.emoji}</div>
        )}
        <div className="inspector__name">
          {plushie.emoji} {plushie.name}
        </div>
        <p className={`rarity rarity--${plushie.rarity}`}>{plushie.rarity.toUpperCase()} · {plushie.value}★</p>
        <p className="hint center">Drag to spin · scroll to zoom</p>
      </div>
    </div>
  );
}
