import { supabase } from '@/lib/supabase'
import { setProductImagePath } from './api'

/**
 * Product images live in the Supabase Storage bucket "product-images", one
 * folder per product (`<product id>/<random>.webp`). Only administrators may
 * write there (storage policies); everyone signed in sees the images.
 */
export const PRODUCT_IMAGE_BUCKET = 'product-images'
/**
 * Longest side of a stored image. The largest place an image is shown is
 * under 100 CSS pixels, so 640 px stays sharp on 2× and 3× screens while each
 * file stays small (typically 30–120 KB).
 */
export const PRODUCT_IMAGE_PIXELS = 640
/** Originals larger than this are refused before resizing (a phone photo is usually 2–8 MB). */
export const MAX_PRODUCT_ORIGINAL_BYTES = 20 * 1024 * 1024

export function productImageUrl(path: string | null | undefined): string | null {
  if (!path) return null
  return supabase().storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(path).data.publicUrl
}

/** Draws `source` into `w`×`h` with the best smoothing the browser has (halving in steps for large reductions). */
function drawSharp(source: ImageBitmap, w: number, h: number): HTMLCanvasElement {
  let current: CanvasImageSource = source
  let cw = source.width
  let ch = source.height
  // Halving step by step keeps fine detail (text on packets) that a single large downscale would blur or alias.
  while (cw / 2 >= w && ch / 2 >= h) {
    const step = document.createElement('canvas')
    step.width = Math.round(cw / 2)
    step.height = Math.round(ch / 2)
    const sctx = step.getContext('2d')!
    sctx.imageSmoothingQuality = 'high'
    sctx.drawImage(current, 0, 0, step.width, step.height)
    current = step
    cw = step.width
    ch = step.height
  }
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(current, 0, 0, w, h)
  return out
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))

/**
 * Prepares an image for upload: never larger than PRODUCT_IMAGE_PIXELS on its
 * longest side (smaller images are kept at their own size, never enlarged),
 * aspect ratio and transparency kept, saved as high-quality WebP (PNG where
 * the browser cannot write WebP).
 */
export async function prepareProductImage(file: Blob): Promise<{ blob: Blob; extension: 'webp' | 'png' }> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not a picture this browser can open.')
  })
  const scale = Math.min(1, PRODUCT_IMAGE_PIXELS / Math.max(bitmap.width, bitmap.height))
  const canvas = drawSharp(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
  bitmap.close()
  const webp = await toBlob(canvas, 'image/webp', 0.92)
  if (webp && webp.type === 'image/webp') return { blob: webp, extension: 'webp' }
  const png = await toBlob(canvas, 'image/png')
  if (!png) throw new Error('The picture could not be prepared.')
  return { blob: png, extension: 'png' }
}

/** Uploads a prepared image as the product's image (administrators); the previous file is deleted. */
export async function setProductImage(productId: string, image: { blob: Blob; extension: 'webp' | 'png' }, previous: string | null | undefined) {
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
