'use client';

import { useEffect, useState } from 'react';

export interface DeviceTier {
  /** True for phones / tablets / low-core machines — drives the lighter scene. */
  lowPower: boolean;
  /** True when the viewport is phone-sized, which changes HUD layout. */
  compact: boolean;
  /** Device pixel ratio ceiling for the canvas. */
  maxDpr: number;
  /** Resolved after mount; false during SSR so markup matches on hydration. */
  ready: boolean;
}

const INITIAL: DeviceTier = { lowPower: false, compact: false, maxDpr: 2, ready: false };

/**
 * Detects whether this machine should get the full battlefield or the light one.
 *
 * Deliberately conservative: a coarse pointer, few CPU cores, or a narrow
 * viewport all opt into the lighter scene. Getting this wrong on a phone means
 * a slideshow, so we'd rather under-promise on a capable tablet.
 */
export function useDeviceTier(): DeviceTier {
  const [tier, setTier] = useState<DeviceTier>(INITIAL);

  useEffect(() => {
    const evaluate = (): DeviceTier => {
      const width = window.innerWidth;
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const cores = navigator.hardwareConcurrency ?? 4;
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      const compact = width < 760;
      const lowPower = compact || (coarse && width < 1100) || cores <= 4 || reducedMotion;

      return {
        lowPower,
        compact,
        maxDpr: lowPower ? 1.25 : Math.min(2, window.devicePixelRatio || 1),
        ready: true,
      };
    };

    setTier(evaluate());

    const onResize = () => setTier(evaluate());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return tier;
}
