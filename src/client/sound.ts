import { useEffect, useState } from 'react';

/**
 * Small, dependency-free sound-effect player. Each cue is a short CC0 clip
 * (public/sounds/README.md) preloaded once and cloned per play so overlapping
 * triggers (e.g. two quick clicks) don't cut each other off. Mute state is a
 * single module-level flag persisted to localStorage, with a tiny pub/sub so
 * the Hud's toggle re-renders without needing a context provider for one bool.
 */

type SoundKey = 'click' | 'success' | 'failure' | 'tick' | 'shot';

const SOUNDS: Record<SoundKey, { src: string; volume: number }> = {
  click: { src: '/sounds/click.ogg', volume: 0.5 },
  success: { src: '/sounds/success.ogg', volume: 0.6 },
  failure: { src: '/sounds/failure.ogg', volume: 0.6 },
  tick: { src: '/sounds/tick.ogg', volume: 0.35 },
  shot: { src: '/sounds/shot.wav', volume: 0.45 },
};

const STORAGE_KEY = 'savethe.muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

let muted = readMuted();
const listeners = new Set<() => void>();

export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
  } catch {
    // storage unavailable (private mode); the toggle just won't persist
  }
  for (const l of listeners) l();
}

/** Live-updating mute flag for UI (the Hud toggle). */
export function useMuted(): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState(muted);
  useEffect(() => {
    const listener = () => setValue(muted);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return [value, setMuted];
}

const cache = new Map<SoundKey, HTMLAudioElement>();

export function playSound(key: SoundKey): void {
  if (muted) return;
  let base = cache.get(key);
  if (!base) {
    const { src } = SOUNDS[key];
    base = new Audio(src);
    base.preload = 'auto';
    cache.set(key, base);
  }
  const instance = base.cloneNode(true) as HTMLAudioElement;
  instance.volume = SOUNDS[key].volume;
  // Autoplay can be blocked before the page has seen any user gesture;
  // by the time these fire the player has already clicked something, but
  // swallow the rejection defensively rather than crash on it.
  instance.play().catch(() => {});
}
