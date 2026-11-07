/**
 * Product images are saved between 50 KB and 100 KB at the highest quality
 * that allows, cropped as squares, with an off-white backdrop made pure white
 * (src/renderer/src/lib/imageBudget.ts, crop.ts, whiten.ts).
 */
import { describe, expect, it } from 'vitest'
import { IMAGE_MAX_BYTES, IMAGE_MIN_BYTES, encodeWithinBudget, formatKb, type Encoder, type ImageFormat } from '../../src/renderer/src/lib/imageBudget'
import { clampView, cropArea, fillZoom, maxZoom, startView } from '../../src/renderer/src/lib/crop'
import { whitenBackdrop } from '../../src/renderer/src/lib/whiten'

/**
 * A stand-in for the browser's encoder: bytes grow with pixels, quality and
 * how detailed the picture is (`detail`; a typical product photo is about 1.5).
 */
function fakeEncoder(detail: number, { webp = true } = {}) {
  const calls: { side: number; format: ImageFormat; quality: number }[] = []
  const encode: Encoder = async (side, format, quality) => {
    calls.push({ side, format, quality })
    if (format === 'image/webp' && !webp) return null
    const pixels = side * side
    const perPixel =
      format === 'image/webp'
        ? quality >= 1
          ? 0.6 // lossless
          : 0.04 * 10 ** ((quality - 0.8) * 2.5)
        : 0.06 * 10 ** ((quality - 0.85) * 3)
    return new Blob([new Uint8Array(Math.round(pixels * perPixel * detail))], { type: format })
  }
  return { encode, calls }
}

describe('encodeWithinBudget', () => {
  it('saves a typical photo as WebP at the standard 800 px, at the highest quality under 100 KB', async () => {
    const r = await encodeWithinBudget(fakeEncoder(1.5).encode)
    expect(r).toMatchObject({ side: 800, format: 'image/webp' })
    expect(r.blob.size).toBeGreaterThanOrEqual(IMAGE_MIN_BYTES)
    expect(r.blob.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
    expect(r.quality).toBeGreaterThan(0.95) // the 0.3 % search lands right under the ceiling
    expect(r.blob.size).toBeGreaterThan(IMAGE_MAX_BYTES * 0.97)
  })

  it('gives a very detailed photo fewer pixels rather than a blurry low quality', async () => {
    const r = await encodeWithinBudget(fakeEncoder(6).encode)
    expect(r.side).toBe(640)
    expect(r.quality).toBeGreaterThanOrEqual(0.8)
    expect(r.blob.size).toBeGreaterThanOrEqual(IMAGE_MIN_BYTES)
    expect(r.blob.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
  })

  it('spends the floor on detail for a plain picture: more pixels and near-lossless JPEG', async () => {
    const r = await encodeWithinBudget(fakeEncoder(0.3).encode)
    expect(r).toMatchObject({ side: 1024, format: 'image/jpeg', quality: 1 })
    expect(r.blob.size).toBeGreaterThanOrEqual(IMAGE_MIN_BYTES)
    expect(r.blob.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
  })

  it('never pads an almost blank picture: it is saved at full quality, under the floor', async () => {
    const r = await encodeWithinBudget(fakeEncoder(0.05).encode)
    expect(r).toMatchObject({ side: 1280, quality: 1 }) // the largest size, lossless
    expect(r.blob.size).toBeLessThan(IMAGE_MIN_BYTES)
  })

  it('uses JPEG where the browser cannot write WebP', async () => {
    const r = await encodeWithinBudget(fakeEncoder(1.5, { webp: false }).encode)
    expect(r).toMatchObject({ side: 800, format: 'image/jpeg' })
    expect(r.blob.size).toBeGreaterThanOrEqual(IMAGE_MIN_BYTES)
    expect(r.blob.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
  })

  it('is never over 100 KB, and within 50–100 KB whenever the picture has the detail', async () => {
    for (const detail of [0.2, 0.4, 0.8, 1, 1.5, 2, 3, 5, 8, 12, 20]) {
      const { encode, calls } = fakeEncoder(detail)
      const r = await encodeWithinBudget(encode)
      expect(r.blob.size, `detail ${detail}`).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
      expect(r.blob.size, `detail ${detail}`).toBeGreaterThanOrEqual(IMAGE_MIN_BYTES)
      expect(Math.min(...calls.map((c) => c.quality)), `detail ${detail}`).toBeGreaterThanOrEqual(0.8)
      expect(calls.length, `detail ${detail}`).toBeLessThanOrEqual(40) // quick enough to wait for
    }
  })

  it('saves even an extreme texture, as a smaller square', async () => {
    const r = await encodeWithinBudget(fakeEncoder(40).encode)
    expect(r.side).toBe(256)
    expect(r.blob.size).toBeGreaterThanOrEqual(IMAGE_MIN_BYTES)
    expect(r.blob.size).toBeLessThanOrEqual(IMAGE_MAX_BYTES)
  })

  it('says so when even the smallest size cannot get under 100 KB', async () => {
    await expect(encodeWithinBudget(fakeEncoder(1000).encode)).rejects.toThrow(/under 100 KB/)
  })

  it('shows sizes in KB as Windows does', () => {
    expect(formatKb(IMAGE_MIN_BYTES)).toBe('50 KB')
    expect(formatKb(IMAGE_MAX_BYTES)).toBe('98 KB')
  })
})

describe('the square crop', () => {
  it('starts with the whole picture inside the square (white above and below a landscape photo)', () => {
    expect(cropArea(1200, 800, startView(1200, 800))).toEqual({ x: 0, y: -200, size: 1200 })
  })

  it('zooms between the whole picture and a 160 px square, and can always fill the square', () => {
    expect(maxZoom(1200, 800)).toBe(7.5)
    expect(cropArea(1200, 800, clampView(1200, 800, { cx: 600, cy: 400, zoom: 99 })).size).toBe(160)
    expect(clampView(1200, 800, { cx: 600, cy: 400, zoom: 0.2 }).zoom).toBe(1)
    expect(fillZoom(1200, 800)).toBe(1.5)
    expect(maxZoom(200, 100)).toBe(2) // a small picture can still fill the square
  })

  it('keeps the square on the picture when it fills it', () => {
    const v = clampView(1200, 800, { cx: -500, cy: 5000, zoom: 1.5 })
    expect(cropArea(1200, 800, v)).toEqual({ x: 0, y: 0, size: 800 })
    expect(cropArea(1200, 800, clampView(1200, 800, { cx: 5000, cy: 400, zoom: 1.5 }))).toEqual({ x: 400, y: 0, size: 800 })
  })

  it('keeps a picture narrower than the square inside it', () => {
    // A tall bottle (600 × 1200) zoomed out: the square is 1200 wide, the bottle may slide 300 px either way.
    expect(clampView(600, 1200, { cx: -999, cy: 600, zoom: 1 }).cx).toBe(0)
    expect(clampView(600, 1200, { cx: 999, cy: 600, zoom: 1 }).cx).toBe(600)
    expect(cropArea(600, 1200, clampView(600, 1200, { cx: 999, cy: 600, zoom: 1 }))).toEqual({ x: 0, y: 0, size: 1200 })
  })
})

describe('whitening the backdrop', () => {
  /** A 100 × 100 picture: a backdrop colour with a dark 40 × 40 product in the middle. */
  const picture = (backdrop: [number, number, number], product: [number, number, number] = [60, 90, 140]) => {
    const d = new Uint8ClampedArray(100 * 100 * 4)
    for (let y = 0; y < 100; y++)
      for (let x = 0; x < 100; x++) {
        const c = x >= 30 && x < 70 && y >= 30 && y < 70 ? product : backdrop
        d.set([...c, 255], (y * 100 + x) * 4)
      }
    return d
  }
  const at = (d: Uint8ClampedArray, x: number, y: number) => [...d.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 3)]
  const all = { x: 0, y: 0, w: 100, h: 100 }

  it('turns an off-white photo backdrop pure white and balances the product with it', () => {
    const d = picture([240, 240, 236])
    expect(whitenBackdrop(d, 100, 100, all)).toEqual([240, 240, 236])
    expect(at(d, 2, 2)).toEqual([255, 255, 255])
    expect(at(d, 50, 50)).toEqual([64, 96, 151]) // brightened by the same 6 %, colours kept
  })

  it('leaves coloured, grey and cream backdrops (and tight crops into the product) alone', () => {
    for (const backdrop of [[200, 40, 40], [210, 210, 210], [250, 238, 215]] as [number, number, number][]) {
      const d = picture(backdrop)
      expect(whitenBackdrop(d, 100, 100, all), String(backdrop)).toBeNull()
      expect(at(d, 2, 2)).toEqual(backdrop)
      expect(at(d, 50, 50)).toEqual([60, 90, 140])
    }
  })

  it('eases JPEG speckle near white to pure white without touching the product', () => {
    const d = picture([255, 255, 255])
    d.set([249, 252, 250], (5 * 100 + 5) * 4)
    whitenBackdrop(d, 100, 100, all)
    expect(at(d, 5, 5)).toEqual([255, 255, 255])
    expect(at(d, 50, 50)).toEqual([60, 90, 140])
  })

  it('reads the backdrop where the picture was drawn, not the white fill around it', () => {
    const d = new Uint8ClampedArray(100 * 100 * 4).fill(255)
    const inner = picture([236, 236, 236])
    // Only rows 20–79 hold the picture (a landscape photo zoomed out); the rest is fill.
    for (let y = 20; y < 80; y++) d.set(inner.slice(y * 400, y * 400 + 400), y * 400)
    expect(whitenBackdrop(d, 100, 100, { x: 0, y: 20, w: 100, h: 60 })).toEqual([236, 236, 236])
    expect(at(d, 2, 25)).toEqual([255, 255, 255])
  })
})
