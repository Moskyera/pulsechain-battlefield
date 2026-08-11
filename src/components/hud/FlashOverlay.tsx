'use client';

import { useEffect, useRef } from 'react';
import { runtime } from '@/lib/sim/runtime';

/**
 * Full-screen blast flash for nuke-tier trades (> $25k).
 *
 * Driven by a raw rAF loop writing straight to the DOM node's opacity. Routing
 * this through React state would re-render the entire HUD sixty times a second
 * for a purely cosmetic value.
 */
export function FlashOverlay() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame = 0;
    let lastValue = -1;

    const tick = () => {
      const node = ref.current;
      if (node) {
        const v = Math.min(1, runtime.combat.flash);
        // Only touch the DOM when the value actually moved.
        if (Math.abs(v - lastValue) > 0.004) {
          node.style.opacity = String(v * 0.5);
          lastValue = v;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <div ref={ref} className="flash-overlay" aria-hidden style={{ opacity: 0 }} />;
}
