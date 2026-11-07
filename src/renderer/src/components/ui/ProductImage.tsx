import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { useProductImages } from '@/data/hooks'
import { productImageUrl } from '@/data/productImages'

/**
 * A product's image, shown beside its name wherever the product appears.
 * A product without an image renders nothing at all — no placeholder, icon or
 * empty box — so its line looks exactly as it always has.
 *
 * There is no tile or frame: the image is multiplied onto whatever it sits on
 * (mix-blend-mode: multiply), so a photo's white background takes on the
 * card's own colour and the product looks printed on the card. For that to
 * work, nothing between the card and the image may fade or isolate (an opacity
 * below 1 on a see-through row, for one); give such a row the card's solid
 * background. Files are square crops of about 800 px, sharp on any screen.
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
    <span className={cn('inline-flex shrink-0 items-center justify-center', className)} style={{ width: size, height: size }} data-testid="product-image">
      <img
        src={url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="size-full object-contain mix-blend-multiply"
        style={{ borderRadius: Math.max(4, Math.round(size * 0.18)) }}
        onError={() => setFailed(true)}
      />
    </span>
  )
}
