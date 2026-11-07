/**
 * The maths of the square image cropper, in the picture's own pixels.
 *
 * A view is the point of the picture at the centre of the square plus a zoom:
 * zoom 1 shows the whole picture inside the square (the rest is filled
 * white), higher zooms show less of it.
 */
export interface CropView {
  cx: number
  cy: number
  zoom: number
}
/** The square that is saved, in the picture's pixels; it may reach past the picture's edges (filled white). */
export interface CropArea {
  x: number
  y: number
  size: number
}

/** The smallest square (in the picture's own pixels) the zoom allows, so a crop never turns to mush. */
export const MIN_CROP_PIXELS = 160

/** The highest zoom: at least enough to fill the square, at most 12×, never below MIN_CROP_PIXELS. */
export function maxZoom(w: number, h: number): number {
  const long = Math.max(w, h)
  return Math.max(1, long / Math.min(w, h), Math.min(12, long / MIN_CROP_PIXELS))
}

/** The zoom at which the picture just fills the square. */
export const fillZoom = (w: number, h: number) => Math.max(w, h) / Math.min(w, h)

export const startView = (w: number, h: number): CropView => ({ cx: w / 2, cy: h / 2, zoom: 1 })

/** Keeps the zoom in range and the square on the picture: covering it when the picture is larger, containing it when smaller. */
export function clampView(w: number, h: number, v: CropView): CropView {
  const zoom = Math.min(Math.max(v.zoom, 1), maxZoom(w, h))
  const half = Math.max(w, h) / zoom / 2
  const clamp = (c: number, length: number) => {
    const a = half
    const b = length - half
    return Math.min(Math.max(c, Math.min(a, b)), Math.max(a, b))
  }
  return { zoom, cx: clamp(v.cx, w), cy: clamp(v.cy, h) }
}

export function cropArea(w: number, h: number, v: CropView): CropArea {
  const size = Math.max(w, h) / v.zoom
  return { x: v.cx - size / 2, y: v.cy - size / 2, size }
}
