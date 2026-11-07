import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { useProductImages } from '@/data/hooks'
import { productImageUrl } from '@/data/productImages'

/**
 * A product's image, shown beside its name wherever the product appears.
 * A product without an image renders nothing at all — no placeholder, icon or
 * empty box — so its line looks exactly as it always has. The image keeps its
 * proportions inside a small white tile (packets and bottles are not cropped),
 * from a 640 px file, so it stays sharp on high-resolution screens.
 */
export function ProductImage({
  productId,
  name,
  size = 32,
  path: given,
  className
}: {
  productId?: string | null
  name?: string | null
  size?: number
  /** Known path (e.g. the admin product list), skipping the lookup. */
  path?: string | null
  className?: string
}) {
  const { data: find } = useProductImages()
  const path = given !== undefined ? given : (find?.(productId, name) ?? null)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [path])
  const url = productImageUrl(path)
  if (!url || failed) return null
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-forest-950/[0.07]', className)}
      style={{ width: size, height: size, borderRadius: Math.max(6, Math.round(size * 0.22)), padding: Math.max(1, Math.round(size * 0.06)) }}
      data-testid="product-image"
    >
      <img src={url} alt="" loading="lazy" decoding="async" draggable={false} className="size-full object-contain" onError={() => setFailed(true)} />
    </span>
  )
}
