/**
 * Makes a product photo's backdrop pure white before it is saved, so that
 * once the image is multiplied onto a card (ProductImage) the backdrop takes
 * the card's colour exactly, with no faint grey square around the product.
 *
 * 1. White balance: the backdrop colour is read from a thin ring just inside
 *    the picture's edges (where the backdrop is in almost every product
 *    shot). If it is a light, neutral colour, say #f4f4f0, every pixel is
 *    scaled so that colour becomes #ffffff. That brightens the photo by at
 *    most 11 %, like a phone's auto-levels.
 * 2. Clean-up: what is left within a whisker of white (JPEG speckle) is eased
 *    to pure white on a smooth ramp, so nothing bands.
 *
 * A tight crop into the product (no light, neutral ring) skips step 1.
 */

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

/** The darkest backdrop treated as "white": anything darker is a coloured or grey backdrop and is left alone. */
const DARKEST_BACKDROP = 230
/** How far apart the channels may be for the backdrop to count as neutral (not cream, not tinted). */
const MOST_TINT = 16
/** From here up (after balancing), pixels ease to pure white. */
const LIFT_FROM = 238

/** The backdrop colour (per-channel median of the ring), or null when the ring is not light and neutral. */
export function backdropColour(data: Uint8ClampedArray, width: number, rect: PixelRect): [number, number, number] | null {
  if (rect.w < 4 || rect.h < 4) return null
  const ring = Math.max(1, Math.round(Math.min(rect.w, rect.h) * 0.02))
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  let count = 0
  const add = (x: number, y: number) => {
    const i = (y * width + x) * 4
    hist[0]![data[i]!]!++
    hist[1]![data[i + 1]!]!++
    hist[2]![data[i + 2]!]!++
    count++
  }
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const edgeRow = y < rect.y + ring || y >= rect.y + rect.h - ring
    if (edgeRow) for (let x = rect.x; x < rect.x + rect.w; x++) add(x, y)
    else {
      for (let x = rect.x; x < rect.x + ring; x++) add(x, y)
      for (let x = rect.x + rect.w - ring; x < rect.x + rect.w; x++) add(x, y)
    }
  }
  const median = hist.map((h) => {
    let seen = 0
    for (let v = 0; v < 256; v++) if ((seen += h[v]!) * 2 >= count) return v
    return 255
  }) as [number, number, number]
  const low = Math.min(...median)
  return low >= DARKEST_BACKDROP && Math.max(...median) - low <= MOST_TINT ? median : null
}

/** Whitens the backdrop in place (RGBA pixels); `rect` is where the picture was drawn (the rest is already white). */
export function whitenBackdrop(data: Uint8ClampedArray, width: number, height: number, rect: PixelRect): [number, number, number] | null {
  const backdrop = backdropColour(data, width, rect)
  const [kr, kg, kb] = backdrop ? backdrop.map((c) => 255 / c) : [1, 1, 1]
  for (let i = 0; i < width * height * 4; i += 4) {
    const r = Math.min(255, data[i]! * kr!)
    const g = Math.min(255, data[i + 1]! * kg!)
    const b = Math.min(255, data[i + 2]! * kb!)
    const m = Math.min(r, g, b)
    if (m >= LIFT_FROM) {
      const u = Math.min(1, (m - LIFT_FROM) / (250 - LIFT_FROM))
      const t = u * u * (3 - 2 * u)
      data[i] = r + (255 - r) * t
      data[i + 1] = g + (255 - g) * t
      data[i + 2] = b + (255 - b) * t
    } else {
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
    }
  }
  return backdrop
}
