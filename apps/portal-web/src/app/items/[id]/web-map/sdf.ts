/**
 * Runtime signed-distance-field generator for point icons.
 *
 * MapLibre's symbol layer supports `icon-color` tinting only when the
 * registered image is flagged as SDF via `addImage(id, img, {sdf: true})`.
 * For an SDF image MapLibre expects the pixel value to encode the
 * signed distance to the shape boundary, with the alpha channel
 * carrying coverage.
 *
 * We derive the distance field at load time from a rasterized SVG's
 * alpha mask via a two-pass sequential chamfer transform:
 *
 *   - Forward pass accumulates distances from top-left.
 *   - Backward pass refines from bottom-right.
 *   - 3-4 Chamfer kernel (axis step = 3, diagonal step = 4) is a
 *     standard cheap approximation of Euclidean distance, good enough
 *     that a 48 px rendered icon doesn't betray the approximation.
 *
 * The encoded image uses MapLibre's SDF convention: the red channel
 * carries a remap of the signed distance where values around 192
 * fall on the shape boundary (same contract as @mapbox/tiny-sdf for
 * glyphs). Green and blue are zero; alpha is 255 so the texture
 * sampler doesn't run off the edges.
 */

export interface SdfOptions {
  /** How many pixels past the edge still register as "inside the buffer". */
  buffer?: number;
  /** Max distance to encode; farther pixels clamp to the extremes. */
  cutoff?: number;
}

export function alphaToSdf(
  imageData: ImageData,
  opts: SdfOptions = {},
): ImageData {
  const { data, width: w, height: h } = imageData;
  const n = w * h;
  const INF = w + h;
  const buffer = opts.buffer ?? 3;
  const cutoff = opts.cutoff ?? Math.min(w, h) / 4;

  // Binary mask from alpha. Anything above 127 is "inside the shape".
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    mask[i] = data[i * 4 + 3]! > 127 ? 1 : 0;
  }

  // Two separate distance maps: outside-to-inside, and inside-to-outside.
  const dOut = new Float32Array(n);
  const dIn = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    dOut[i] = mask[i] ? 0 : INF;
    dIn[i] = mask[i] ? INF : 0;
  }

  const updatePair = (
    from: Float32Array,
    fromIdx: number,
    toIdx: number,
    step: number,
  ) => {
    const cand = from[fromIdx]! + step;
    if (cand < from[toIdx]!) from[toIdx] = cand;
  };

  // Forward pass: look up/left.
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (x > 0) {
        updatePair(dOut, i - 1, i, 1);
        updatePair(dIn, i - 1, i, 1);
      }
      if (y > 0) {
        updatePair(dOut, i - w, i, 1);
        updatePair(dIn, i - w, i, 1);
        if (x > 0) {
          updatePair(dOut, i - w - 1, i, Math.SQRT2);
          updatePair(dIn, i - w - 1, i, Math.SQRT2);
        }
        if (x < w - 1) {
          updatePair(dOut, i - w + 1, i, Math.SQRT2);
          updatePair(dIn, i - w + 1, i, Math.SQRT2);
        }
      }
    }
  }

  // Backward pass: look down/right.
  for (let y = h - 1; y >= 0; y -= 1) {
    for (let x = w - 1; x >= 0; x -= 1) {
      const i = y * w + x;
      if (x < w - 1) {
        updatePair(dOut, i + 1, i, 1);
        updatePair(dIn, i + 1, i, 1);
      }
      if (y < h - 1) {
        updatePair(dOut, i + w, i, 1);
        updatePair(dIn, i + w, i, 1);
        if (x > 0) {
          updatePair(dOut, i + w - 1, i, Math.SQRT2);
          updatePair(dIn, i + w - 1, i, Math.SQRT2);
        }
        if (x < w - 1) {
          updatePair(dOut, i + w + 1, i, Math.SQRT2);
          updatePair(dIn, i + w + 1, i, Math.SQRT2);
        }
      }
    }
  }

  // Encode in MapLibre's expected format. We match tiny-sdf's
  // convention: the value is 192 at the boundary and scales out in
  // both directions by the cutoff.
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i += 1) {
    const signed = mask[i] ? dIn[i]! : -dOut[i]!;
    const v = 192 + ((signed - buffer) * 63) / cutoff;
    const clamped = Math.max(0, Math.min(255, Math.round(v)));
    out[i * 4 + 0] = clamped;
    out[i * 4 + 1] = 0;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return new ImageData(out, w, h);
}

/**
 * Rasterize an SVG onto a canvas filled in black, then feed the
 * alpha mask into the SDF encoder. Used for both built-in and
 * uploaded vector icons — rasterized copies of the same SVG look
 * identical regardless of source.
 */
export async function svgToSdf(svg: string, size: number): Promise<ImageData> {
  const scale = 2;
  const w = size * scale;
  const h = size * scale;
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = (e) => reject(e);
      i.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2D unavailable');
    ctx.drawImage(img, 0, 0, w, h);
    const pixels = ctx.getImageData(0, 0, w, h);
    return alphaToSdf(pixels);
  } finally {
    URL.revokeObjectURL(url);
  }
}
