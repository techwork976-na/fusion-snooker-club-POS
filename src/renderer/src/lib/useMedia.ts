import { useSyncExternalStore } from 'react'

/** Phones: below Tailwind's `md` breakpoint, where the tab bar replaces the sidebar. */
export const PHONE_QUERY = '(max-width: 767.98px)'

/** True while the media query matches; updates when the window is resized or rotated. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia(query).matches,
    () => false
  )
}

export const useIsPhone = () => useMediaQuery(PHONE_QUERY)
