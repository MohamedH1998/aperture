/**
 * Visual diff engine.
 *
 * Stores previous screenshots per URL+viewport key.
 * Compares current capture against previous via pixelmatch.
 * Returns diff overlay image + change percentage.
 *
 * Also provides cheap hash-based change detection for has_changed().
 */

import sharp from 'sharp';
import pixelmatch from 'pixelmatch';
import { createHash } from 'node:crypto';

// BUG-006: LRU cap to prevent unbounded memory growth
const MAX_CACHE_ENTRIES = 100;

/** Previous captures keyed by url+viewport hash */
const previousCaptures = new Map<string, Buffer>();

/** Tiny frame hashes for has_changed() */
const previousHashes = new Map<string, string>();

/** Evict oldest entry if map exceeds LRU cap */
function evictIfNeeded<V>(map: Map<string, V>): void {
  if (map.size > MAX_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// BUG-035: Normalize URLs so trailing slashes, fragments, etc. don't create duplicate keys
function normalizeUrl(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function captureKey(url: string, viewport?: { width: number; height: number }): string {
  const v = viewport ? `${viewport.width}x${viewport.height}` : 'default';
  return `${normalizeUrl(url)}::${v}`;
}

function hashBuffer(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

export interface DiffResult {
  diffImage: Buffer;
  diffBase64: string;
  changePercent: number;
  pixelsChanged: number;
  totalPixels: number;
  hasPrevious: boolean;
}

export async function computeDiff(
  currentImage: Buffer,
  url: string,
  viewport?: { width: number; height: number },
): Promise<DiffResult> {
  const key = captureKey(url, viewport);
  const previous = previousCaptures.get(key);

  // Store current for next comparison
  previousCaptures.set(key, currentImage);
  evictIfNeeded(previousCaptures);

  if (!previous) {
    return {
      diffImage: currentImage,
      diffBase64: currentImage.toString('base64'),
      changePercent: 100,
      pixelsChanged: 0,
      totalPixels: 0,
      hasPrevious: false,
    };
  }

  // Normalize both images to same dimensions + raw RGBA
  const targetWidth = 640;
  const targetHeight = 360;

  const [img1, img2] = await Promise.all([
    sharp(previous)
      .resize(targetWidth, targetHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .ensureAlpha()
      .raw()
      .toBuffer(),
    sharp(currentImage)
      .resize(targetWidth, targetHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .ensureAlpha()
      .raw()
      .toBuffer(),
  ]);

  const diffPixels = new Uint8Array(targetWidth * targetHeight * 4);

  const mismatchCount = pixelmatch(
    new Uint8Array(img1.buffer, img1.byteOffset, img1.byteLength),
    new Uint8Array(img2.buffer, img2.byteOffset, img2.byteLength),
    diffPixels,
    targetWidth,
    targetHeight,
    { threshold: 0.1 },
  );

  const totalPixels = targetWidth * targetHeight;
  const changePercent = Number(((mismatchCount / totalPixels) * 100).toFixed(2));

  // Convert diff pixels back to JPEG
  const diffImage = await sharp(Buffer.from(diffPixels.buffer), {
    raw: { width: targetWidth, height: targetHeight, channels: 4 },
  })
    .jpeg({ quality: 80 })
    .toBuffer();

  return {
    diffImage,
    diffBase64: diffImage.toString('base64'),
    changePercent,
    pixelsChanged: mismatchCount,
    totalPixels,
    hasPrevious: true,
  };
}

/**
 * Cheap change detection via hash comparison of tiny captures.
 * Returns true if the page looks different from last check.
 */
export function detectChange(tinyCapture: Buffer, url: string, viewport?: { width: number; height: number }): boolean {
  const key = captureKey(url, viewport);
  const currentHash = hashBuffer(tinyCapture);
  const previousHash = previousHashes.get(key);

  previousHashes.set(key, currentHash);
  evictIfNeeded(previousHashes);

  if (!previousHash) return true; // First capture — always "changed"
  return currentHash !== previousHash;
}
