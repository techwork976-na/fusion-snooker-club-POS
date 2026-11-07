import { supabase } from '@/lib/supabase'
import type { CropArea } from '@/lib/crop'
import { encodeWithinBudget, type ImageFormat } from '@/lib/imageBudget'
import { whitenBackdrop } from '@/lib/whiten'
import { setProductImagePath } from './api'

/**
 * Product images live in the Supabase Storage bucket "product-images", one
 * folder per product (`<product id>/<random>.webp` or `.jpg`). Only
 * administrators may write there (storage policies); everyone signed in sees
 * the images.
 *
 * Each image is a square the administrator crops, saved between 50 KB and
 * 100 KB (lib/imageBudget.ts) at 800 px or so: far sharper than the largest
 * place it is shown, on any screen.
 */
export const PRODUCT_IMAGE_BUCKET = 'product-images'
/** Originals larger than this are refused before cropping (a phone photo is usually 2–8 MB). */
export const MAX_PRODUCT_ORIGINAL_BYTES = 20 * 1024 * 1024

export interface PreparedProductImage {
  blob: Blob
  extension: 'webp' | 'jpg'
  /** Width and height in pixels. */
  side: number
}

export function productImageUrl(path: string | null | undefined): string | null {
  if (!path) return null
  return supabase().storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
}

const canvas = (w: number, h: number) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

/**
 * Draws part of `source` into `ctx` with the best smoothing the browser has.
 * Large reductions are made by halving step by step, which keeps fine detail
 * (text on packets) that a single big downscale would blur or alias.
 */
function drawRegionSharp(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  [sx, sy, sw, sh]: [number, number, number, number],
  [dx, dy, dw, dh]: [number, number, number, number]
) {
  let current = source
  let x = sx
  let y = sy
  let w = sw
  let h = sh
  while (w / 2 >= dw && h / 2 >= dh) {
    const step = canvas(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)))
    const sctx = step.getContext('2d')!
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(current, x, y, w, h, 0, 0, step.width, step.height)
    current = step
    x = 0
    y = 0
    w = step.width
    h = step.height
  }
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(current, x, y, w, h, dx, dy, dw, dh)
}

/** The cropped square at `side` × `side`, on white (transparent pictures are flattened onto white). */
function renderCrop(source: HTMLImageElement, area: CropArea, side: number): HTMLCanvasElement {
  const w = source.naturalWidth
  const h = source.naturalHeight
  const out = canvas(side, side)
  const ctx = out.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, side, side)
  const k = side / area.size
  const x0 = Math.max(0, area.x)
  const y0 = Math.max(0, area.y)
  const x1 = Math.min(w, area.x + area.size)
  const y1 = Math.min(h, area.y + area.size)
  if (x1 > x0 && y1 > y0) {
    const dest: [number, number, number, number] = [(x0 - area.x) * k, (y0 - area.y) * k, (x1 - x0) * k, (y1 - y0) * k]
    drawRegionSharp(ctx, source, [x0, y0, x1 - x0, y1 - y0], dest)
    // A photo's off-white backdrop becomes pure white, so it vanishes into the card (lib/whiten.ts).
    const image = ctx.getImageData(0, 0, side, side)
    const left = Math.min(side - 1, Math.max(0, Math.ceil(dest[0])))
    const top = Math.min(side - 1, Math.max(0, Math.ceil(dest[1])))
    const right = Math.max(left + 1, Math.min(side, Math.floor(dest[0] + dest[2])))
    const bottom = Math.max(top + 1, Math.min(side, Math.floor(dest[1] + dest[3])))
    whitenBackdrop(image.data, side, side, { x: left, y: top, w: right - left, h: bottom - top })
    ctx.putImageData(image, 0, 0)
  }
  return out
}

const toBlob = (c: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality))

/**
 * Crops a picture to the chosen square and compresses it to 50–100 KB at the
 * highest quality that allows (see lib/imageBudget.ts).
 */
export async function compressProductImage(source: HTMLImageElement, area: CropArea): Promise<PreparedProductImage> {
  const rendered = new Map<number, HTMLCanvasElement>()
  const encoded = await encodeWithinBudget(async (side, format: ImageFormat, quality) => {
    let c = rendered.get(side)
    if (!c) rendered.set(side, (c = renderCrop(source, area, side)))
    const blob = await toBlob(c, format, quality)
    return blob && blob.type === format ? blob : null
  })
  return { blob: encoded.blob, extension: encoded.format === 'image/webp' ? 'webp' : 'jpg', side: encoded.side }
}

/** Uploads a prepared image as the product's image (administrators); the previous file is deleted. */
export async function setProductImage(productId: string, image: { blob: Blob; extension: string }, previous: string | null | undefined) {
  const path = `${productId}/${crypto.randomUUID()}.${image.extension}`
  const { error } = await supabase()
    .storage.from(PRODUCT_IMAGE_BUCKET)
    .upload(path, image.blob, { contentType: image.blob.type, cacheControl: '31536000', upsert: false })
  if (error) throw new Error(`The image could not be uploaded: ${error.message}`)
  try {
    await setProductImagePath(productId, path)
  } catch (e) {
    await supabase().storage.from(PRODUCT_IMAGE_BUCKET).remove([path])
    throw e
  }
  if (previous) await supabase().storage.from(PRODUCT_IMAGE_BUCKET).remove([previous])
}

/** Removes a product's image (back to the name only). */
export async function removeProductImage(productId: string, previous: string | null | undefined) {
  await setProductImagePath(productId, null)
  if (previous) await supabase().storage.from(PRODUCT_IMAGE_BUCKET).remove([previous])
}

/** Deletes a product's image file (after the product itself was deleted). */
export async function deleteProductImageFile(path: string | null | undefined) {
  if (path) await supabase().storage.from(PRODUCT_IMAGE_BUCKET).remove([path])
}
