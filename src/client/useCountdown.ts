import { useEffect, useState } from 'react';

/** Seconds remaining until `deadline` (ms since epoch), or null if untimed.
 *  Ticks a few times a second so the UI counts down smoothly. */
export function useCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline === null) return null;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
