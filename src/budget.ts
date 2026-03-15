/**
 * Token budget → pixel dimensions calculator.
 *
 * Claude's vision API tokenizes images as: tokens = ceil(width × height / 750)
 * Images with long edge > 1568px or area > 1.15MP are downscaled first.
 * Format (JPEG/PNG/WebP) has ZERO effect on token count — only pixel dimensions matter.
 */

export interface Dimensions {
  width: number;
  height: number;
}

/** Max dimensions before Claude downscales internally (wastes transfer bandwidth) */
const MAX_LONG_EDGE = 1568;
const MAX_AREA = 1_150_000;

/** Minimum budget to produce valid dimensions */
const MIN_BUDGET = 1;

export function dimensionsFromBudget(budget: number, aspectRatio = 16 / 9): Dimensions {
  // BUG-017: Clamp to minimum budget to prevent 0x0 dimensions
  budget = Math.max(budget, MIN_BUDGET);

  const maxPixels = budget * 750;
  let height = Math.floor(Math.sqrt(maxPixels / aspectRatio));
  let width = Math.floor(height * aspectRatio);

  // Clamp to Claude's rescaling thresholds — no point sending larger
  if (width > MAX_LONG_EDGE) {
    width = MAX_LONG_EDGE;
    height = Math.floor(width / aspectRatio);
  }
  if (height > MAX_LONG_EDGE) {
    height = MAX_LONG_EDGE;
    width = Math.floor(height * aspectRatio);
  }
  if (width * height > MAX_AREA) {
    const scale = Math.sqrt(MAX_AREA / (width * height));
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
  }

  // Ensure even dimensions (required by some encoders) and at least 2x2
  width = Math.max(width & ~1, 2);
  height = Math.max(height & ~1, 2);

  return { width, height };
}

export const DEFAULT_BUDGET = 300;
