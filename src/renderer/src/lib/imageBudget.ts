/**
 * How a product image is saved: a square file between 50 KB and 100 KB that
 * stays as crisp as possible.
 *
 * Quality comes first. At the standard size the encoder is asked for the
 * highest quality that fits under the ceiling. Only a very detailed photo,
 * still too heavy at a modest 80 % quality, is given fewer pixels (never fewer
 * than 320, which is still more than any screen in the app shows; only an
 * extreme texture such as gravel goes to 256 at a lower quality). A simple
 * picture on a plain background, under the floor even at the highest quality,
 * is saved with more pixels or as near-lossless JPEG, so the extra bytes buy
 * real detail. Nothing is ever padded with filler: an almost blank picture
 * that cannot reach 50 KB is saved at full quality instead.
 */

/** 50 KB. */
export const IMAGE_MIN_BYTES = 51_200
/** Under 100 KB, whichever way a kilobyte is counted (1,000 or 1,024 bytes). */
export const IMAGE_MAX_BYTES = 100_000

export type ImageFormat = 'image/webp' | 'image/jpeg'
/** Encodes the crop as a `side` × `side` image; null when the browser cannot write that format. */
export type Encoder = (side: number, format: ImageFormat, quality: number) => Promise<Blob | null>
export interface EncodedImage {
  blob: Blob
  side: number
  format: ImageFormat
  quality: number
}

/** The standard size first, then larger ones for simple pictures. */
export const GROW_SIDES = [800, 1024, 1280]
/** Smaller sizes, for photos too detailed for the standard size. */
export const SHRINK_SIDES = [640, 512, 400, 320]
/** WebP first (sharper for the bytes), then JPEG. */
const FORMATS: ImageFormat[] = ['image/webp', 'image/jpeg']
/** The lowest quality used: below it, fine edges start to soften. */
const LOWEST_QUALITY: Record<ImageFormat, number> = { 'image/webp': 0.8, 'image/jpeg': 0.85 }
/** The highest lossy quality (WebP at 1 is lossless in Chromium, tried separately). */
const HIGHEST_QUALITY: Record<ImageFormat, number> = { 'image/webp': 0.99, 'image/jpeg': 1 }

interface Attempt {
  /** A result between the floor and the ceiling. */
  fits?: EncodedImage
  /** The best result under the floor (the biggest file, so the highest quality). */
  under?: EncodedImage
  /** Even the lowest quality is over the ceiling at this size, in every format. */
  tooBig: boolean
}

async function attempt(encode: Encoder, side: number, min: number, max: number, lowest = LOWEST_QUALITY): Promise<Attempt> {
  let under: EncodedImage | undefined
  let tooBig = true
  const keep = (e: EncodedImage) => {
    if (!under || e.blob.size > under.blob.size) under = e
  }
  for (const format of FORMATS) {
    const at = async (quality: number): Promise<EncodedImage | null> => {
      const blob = await encode(side, format, quality)
      return blob ? { blob, side, format, quality } : null
    }
    const top = await at(HIGHEST_QUALITY[format])
    if (!top) continue // this browser cannot write the format
    if (top.blob.size <= max) {
      tooBig = false
      if (top.blob.size >= min) return { fits: top, tooBig }
      keep(top)
      if (format === 'image/webp') {
        const lossless = await at(1)
        if (lossless && lossless.blob.size <= max) {
          if (lossless.blob.size >= min) return { fits: lossless, tooBig }
          keep(lossless)
        }
      }
      continue
    }
    let low = await at(lowest[format])
    if (!low || low.blob.size > max) continue // too detailed for this size in this format
    tooBig = false
    // The highest quality that still fits under the ceiling (to within 0.3 %).
    let lowQ = lowest[format]
    let highQ = HIGHEST_QUALITY[format]
    for (let i = 0; i < 6; i++) {
      const q = Math.round(((lowQ + highQ) / 2) * 1000) / 1000
      const mid = await at(q)
      if (!mid) break
      if (mid.blob.size <= max) {
        low = mid
        lowQ = q
      } else highQ = q
    }
    if (low.blob.size >= min) return { fits: low, tooBig }
    keep(low)
  }
  return { under, tooBig }
}

/**
 * Picks the side, format and quality for an image: always at most `max`
 * bytes, at least `min` whenever the picture has the detail to fill it.
 */
export async function encodeWithinBudget(encode: Encoder, { min = IMAGE_MIN_BYTES, max = IMAGE_MAX_BYTES } = {}): Promise<EncodedImage> {
  let best: EncodedImage | undefined
  for (const side of GROW_SIDES) {
    const r = await attempt(encode, side, min, max)
    if (r.fits) return r.fits
    if (r.under && (!best || r.under.blob.size > best.blob.size)) best = r.under
    if (r.tooBig) break
  }
  // A plain picture: the highest quality found, without filler.
  if (best) return best
  for (const side of SHRINK_SIDES) {
    const r = await attempt(encode, side, min, max)
    if (r.fits) return r.fits
    if (r.under) return r.under
  }
  // Last resort, for an extreme texture (gravel, noise): a 256 px square at a lower quality, where its grain hides any loss.
  const last = await attempt(encode, 256, min, max, { 'image/webp': 0.5, 'image/jpeg': 0.5 })
  if (last.fits ?? last.under) return (last.fits ?? last.under)!
  throw new Error('This picture could not be saved under 100 KB. Try cropping closer to the product.')
}

/** "74 KB" (1 KB = 1,024 bytes, as Windows shows file sizes). */
export const formatKb = (bytes: number) => `${Math.round(bytes / 1024)} KB`
