'use client';

/**
 * Is this browser drawing with the graphics card, or with the CPU?
 *
 * When a browser's GPU process crashes, Chromium falls back to a software
 * rasteriser (WARP on Windows, SwiftShader elsewhere) and stays there for the
 * life of the browser. Everything still works, so nothing announces itself:
 * WebGL runs, the scene renders, and every triangle and every pixel is drawn
 * by the CPU instead. On a 1440p screen at a high refresh rate that is enough
 * to pin a 16-core machine and spin its fans, which looks exactly like an
 * application being wasteful.
 *
 * It is worth detecting, because the fix is on the user's side and takes one
 * restart, and because the honest thing to do meanwhile is to stop asking a
 * software rasteriser to draw shadows.
 */
const SOFTWARE_RENDERERS = /swiftshader|basic render|warp|llvmpipe|softpipe|software|microsoft basic/i;

export interface RendererInfo {
  /** What the driver calls itself, when the browser will say. */
  name: string;
  /** True when the scene is being rasterised on the CPU. */
  software: boolean;
}

export function detectRenderer(): RendererInfo {
  if (typeof document === 'undefined') return { name: '', software: false };

  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { name: 'none', software: true };

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : String(gl.getParameter(gl.RENDERER) ?? '');

    // Release the context rather than leaving it for the browser to reclaim.
    gl.getExtension('WEBGL_lose_context')?.loseContext();

    return { name, software: SOFTWARE_RENDERERS.test(name) };
  } catch {
    return { name: '', software: false };
  }
}
