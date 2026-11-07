import { useEffect, useState } from 'react'
import { cn } from '@/lib/cn'
import { avatarUrl } from '@/data/avatars'

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

/**
 * A person's round avatar: their profile picture when they have uploaded one,
 * otherwise their initials (brass for admins, sage for staff) — also if the
 * picture cannot be loaded.
 */
export function Avatar({
  name,
  path,
  role,
  size = 36,
  className
}: {
  name: string
  path?: string | null
  role: 'admin' | 'staff'
  size?: number
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [path])
  const url = !failed ? avatarUrl(path) : null
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-full font-bold tracking-wide select-none',
        role === 'admin' ? 'bg-brass-200 text-forest-950' : 'bg-sage-200 text-forest-950',
        className
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }}
      data-testid="avatar"
      data-has-picture={url ? 'true' : 'false'}
    >
      {url ? <img src={url} alt="" className="size-full object-cover" draggable={false} onError={() => setFailed(true)} /> : initials(name)}
    </span>
  )
}
