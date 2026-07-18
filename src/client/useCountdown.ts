import { useEffect, useRef, useState } from 'react';

/** Seconds remaining from a server-projected duration. `performance.now()` is
 * monotonic, so a device wall-clock change cannot freeze or extend the timer. */
export function useCountdown(remainingMs: number | null): number | null {
  const deadlineRef = useRef<number | null>(null);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    deadlineRef.current = remainingMs === null ? null : performance.now() + remainingMs;
    setNow(performance.now());
    if (remainingMs === null) return;
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, [remainingMs]);

  if (deadlineRef.current === null) return null;
  return Math.max(0, Math.ceil((deadlineRef.current - now) / 1000));
}
