'use client';

import { useMemo } from 'react';
import {
  Bloom,
  BrightnessContrast,
  EffectComposer,
  HueSaturation,
  SMAA,
  SSAO,
  ToneMapping,
  Vignette,
} from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';

/**
 * The look.
 *
 * Everything here is post-processing: the geometry, the data and the frame loop
 * are untouched. What separates a raw WebGL scene from something that reads as
 * rendered is almost never polygon count, it is what happens to the image after
 * the triangles land, and this is that pass.
 *
 *   SSAO         contact darkening where surfaces meet. This is the single
 *                biggest one: without it every object looks pasted onto the
 *                ground, with it the men and the armour sit *in* the dirt.
 *   Bloom        light bleeding off the hot things only. The threshold is set
 *                above the ground and the uniforms, so it catches muzzle flash,
 *                tracer, fireball and the team markers, and nothing else.
 *   Tone mapping ACES, moved off the renderer and into the chain so it runs
 *                after the effects rather than before them.
 *   Grade        a touch of contrast and desaturation, so the bright team
 *                colours read against a duller world instead of competing with
 *                a scene that is already fully saturated.
 *   Vignette     pulls the eye to the middle of the field.
 *   SMAA         edge antialiasing, because an EffectComposer chain cannot use
 *                the hardware multisampling the plain renderer had.
 *
 * Cost is real and it is per-pixel, so the whole chain is skipped on the light
 * scene and SSAO, by far the most expensive of them, is dropped first.
 */
export function Cinematics({ lowPower }: { lowPower: boolean }) {
  // Rebuilding the chain re-allocates its render targets, so keep it stable.
  const ao = useMemo(
    () => (
      <SSAO
        blendFunction={BlendFunction.MULTIPLY}
        samples={20}
        rings={4}
        distanceThreshold={0.35}
        distanceFalloff={0.12}
        rangeThreshold={0.008}
        rangeFalloff={0.02}
        luminanceInfluence={0.55}
        radius={0.05}
        intensity={16}
        bias={0.035}
        worldDistanceThreshold={60}
        worldDistanceFalloff={20}
        worldProximityThreshold={4}
        worldProximityFalloff={2}
      />
    ),
    [],
  );

  /*
   * Note on brightness. Moving tone mapping off the renderer and into the chain
   * means the raw image now arrives untouched, and ACES pulls midtones down, so
   * the grade lifts a little to land back where the scene was before.
   */

  if (lowPower) return null;

  return (
    <EffectComposer multisampling={0} enableNormalPass>
      {ao}
      <Bloom
        // High enough that the tinted ground and the daylit dirt stay out of
        // it: at 0.72 the whole red half of the field glowed.
        luminanceThreshold={0.92}
        luminanceSmoothing={0.2}
        intensity={0.5}
        mipmapBlur
        radius={0.5}
      />
      <HueSaturation saturation={-0.05} />
      <BrightnessContrast brightness={0.06} contrast={0.09} />
      <Vignette offset={0.36} darkness={0.3} eskil={false} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <SMAA />
    </EffectComposer>
  );
}
