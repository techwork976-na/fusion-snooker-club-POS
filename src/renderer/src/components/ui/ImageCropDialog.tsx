import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { Crop, Maximize, ZoomIn, ZoomOut } from 'lucide-react'
import { clampView, cropArea, fillZoom, maxZoom, startView, type CropArea, type CropView } from '@/lib/crop'
import { errorMessage } from '@/lib/errors'
import { Button, IconButton } from './Button'
import { Modal } from './Modal'

type Point = { x: number; y: number }
const mid = (p: Point[]) => ({ x: p.reduce((s, q) => s + q.x, 0) / p.length, y: p.reduce((s, q) => s + q.y, 0) / p.length })
const apart = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * A square (1:1) cropper. The picture moves under a fixed square: drag (or
 * the arrow keys) to place it, zoom with the slider, the mouse wheel, a pinch
 * or + / −. Zoomed all the way out the whole picture fits, with white around
 * it, which disappears once the image is blended onto a card.
 */
export function ImageCropDialog({
  file,
  initialView,
  title = 'Crop image',
  onCancel,
  onConfirm
}: {
  /** The picture to crop; null closes the dialog. */
  file: File | null
  /** Where to start (to adjust an earlier crop of the same file). */
  initialView?: CropView | null
  title?: string
  onCancel: () => void
  /** Saves the crop; the dialog shows progress and any error. */
  onConfirm: (image: HTMLImageElement, area: CropArea, view: CropView) => Promise<void>
}) {
  const [picture, setPicture] = useState<{ el: HTMLImageElement; src: string } | null>(null)
  const [view, setView] = useState<CropView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const [stageSize, setStageSize] = useState(0)
  const start = useRef(initialView)
  start.current = initialView

  useEffect(() => {
    if (!file) return
    setPicture(null)
    setView(null)
    setError(null)
    const src = URL.createObjectURL(file)
    const el = new Image()
    el.decoding = 'async'
    el.src = src
    let live = true
    el.decode()
      .then(() => {
        if (!live) return
        if (!el.naturalWidth || !el.naturalHeight) throw new Error('empty')
        setPicture({ el, src })
        setView(clampView(el.naturalWidth, el.naturalHeight, start.current ?? startView(el.naturalWidth, el.naturalHeight)))
      })
      .catch(() => live && setError('That file is not a picture this browser can open. Try a JPG, PNG or WebP.'))
    return () => {
      live = false
      URL.revokeObjectURL(src)
    }
  }, [file])

  useEffect(() => {
    if (!stage) return
    const ro = new ResizeObserver(([entry]) => setStageSize(entry!.contentRect.width))
    ro.observe(stage)
    return () => ro.disconnect()
  }, [stage])

  const w = picture?.el.naturalWidth ?? 1
  const h = picture?.el.naturalHeight ?? 1
  // The square sits inside the stage with a margin that shows what lies just outside the crop.
  const margin = Math.round(Math.min(32, Math.max(18, stageSize * 0.07)))
  const square = Math.max(1, stageSize - margin * 2)
  const scaleAt = (zoom: number) => (square / Math.max(w, h)) * zoom
  const limit = maxZoom(w, h)

  const viewRef = useRef(view)
  viewRef.current = view
  const update = useCallback((next: (v: CropView) => CropView) => setView((v) => (v ? clampView(w, h, next(v)) : v)), [w, h])
  const zoomBy = useCallback((factor: number) => update((v) => ({ ...v, zoom: v.zoom * factor })), [update])

  // The mouse wheel zooms (a non-passive listener, so the dialog does not scroll instead).
  useEffect(() => {
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      zoomBy(Math.exp(-e.deltaY * 0.0015))
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [stage, zoomBy])

  // Dragging with one pointer moves the picture; two pointers pinch to zoom.
  const pointers = useRef(new Map<number, Point>())
  const gesture = useRef<{ view: CropView; mid: Point; apart: number } | null>(null)
  const beginGesture = () => {
    const pts = [...pointers.current.values()]
    gesture.current = pts.length && viewRef.current ? { view: viewRef.current, mid: mid(pts), apart: pts.length > 1 ? apart(pts[0]!, pts[1]!) : 0 } : null
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!view) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    beginGesture()
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const g = gesture.current
    if (!g) return
    const pts = [...pointers.current.values()]
    const zoom = pts.length > 1 && g.apart > 0 ? g.view.zoom * (apart(pts[0]!, pts[1]!) / g.apart) : g.view.zoom
    const m = mid(pts)
    const s = scaleAt(zoom)
    setView(clampView(w, h, { zoom, cx: g.view.cx - (m.x - g.mid.x) / s, cy: g.view.cy - (m.y - g.mid.y) / s }))
  }
  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    beginGesture()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!view) return
    const step = (e.shiftKey ? 48 : 12) / scaleAt(view.zoom)
    const moves: Record<string, (v: CropView) => CropView> = {
      ArrowLeft: (v) => ({ ...v, cx: v.cx - step }),
      ArrowRight: (v) => ({ ...v, cx: v.cx + step }),
      ArrowUp: (v) => ({ ...v, cy: v.cy - step }),
      ArrowDown: (v) => ({ ...v, cy: v.cy + step }),
      '+': (v) => ({ ...v, zoom: v.zoom * 1.15 }),
      '=': (v) => ({ ...v, zoom: v.zoom * 1.15 }),
      '-': (v) => ({ ...v, zoom: v.zoom / 1.15 })
    }
    const move = moves[e.key]
    if (!move) return
    e.preventDefault()
    update(move)
  }

  const confirm = async () => {
    if (!picture || !view) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm(picture.el, cropArea(w, h, view), view)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const s = view ? scaleAt(view.zoom) : 0
  const area = view ? cropArea(w, h, view) : null
  // The slider runs on a log scale, so each step zooms by the same proportion.
  const sliderMax = Math.log(limit)
  const slider = view && sliderMax > 0 ? Math.round((Math.log(view.zoom) / sliderMax) * 1000) : 0
  const filled = view ? view.zoom >= fillZoom(w, h) - 1e-6 : false

  return (
    <Modal
      open={file !== null}
      onOpenChange={(o) => !o && !busy && onCancel()}
      title={title}
      description="Drag to place the product in the square, then zoom in to focus on it. The square is what gets saved."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Crop className="size-4" />} onClick={() => void confirm()} loading={busy} disabled={!view} data-testid="crop-confirm">
            {busy ? 'Preparing…' : 'Use this crop'}
          </Button>
        </>
      }
    >
      <div
        ref={setStage}
        role="application"
        aria-label="Crop area. Drag or use the arrow keys to move the picture; plus and minus zoom."
        tabIndex={0}
        className="relative aspect-square w-full cursor-grab touch-none overflow-hidden rounded-2xl bg-white outline-none select-none focus-visible:ring-2 focus-visible:ring-brass-500 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
        data-testid="crop-stage"
      >
        {picture && view && stageSize > 0 && (
          <img
            src={picture.src}
            alt=""
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={{ left: stageSize / 2 - view.cx * s, top: stageSize / 2 - view.cy * s, width: w * s, height: h * s }}
          />
        )}
        {/* The square that is kept; everything outside it is dimmed. */}
        <div
          className="pointer-events-none absolute rounded-[10px] ring-2 ring-white"
          style={{ inset: margin, boxShadow: '0 0 0 9999px rgb(10 31 20 / 0.55)' }}
          data-testid="crop-square"
        >
          <span className="absolute inset-y-0 left-1/3 w-px bg-white/45" />
          <span className="absolute inset-y-0 left-2/3 w-px bg-white/45" />
          <span className="absolute inset-x-0 top-1/3 h-px bg-white/45" />
          <span className="absolute inset-x-0 top-2/3 h-px bg-white/45" />
        </div>
        {!picture && !error && <p className="absolute inset-0 flex items-center justify-center text-sm text-cream/80">Opening picture…</p>}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <IconButton size="sm" label="Zoom out" onClick={() => zoomBy(1 / 1.25)} disabled={!view || view.zoom <= 1}>
          <ZoomOut className="size-4" />
        </IconButton>
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={slider}
          disabled={!view || sliderMax <= 0}
          onChange={(e) => update((v) => ({ ...v, zoom: Math.exp((Number(e.target.value) / 1000) * sliderMax) }))}
          aria-label="Zoom"
          className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--color-brass-600)]"
          data-testid="crop-zoom"
        />
        <IconButton size="sm" label="Zoom in" onClick={() => zoomBy(1.25)} disabled={!view || view.zoom >= limit}>
          <ZoomIn className="size-4" />
        </IconButton>
        <IconButton
          size="sm"
          label={filled ? 'Show the whole picture' : 'Fill the square'}
          onClick={() => update((v) => ({ ...v, zoom: filled ? 1 : fillZoom(w, h) }))}
          disabled={!view || fillZoom(w, h) <= 1.0001}
        >
          <Maximize className="size-4" />
        </IconButton>
      </div>

      {/* How it will look: blended onto a snack card and onto a bill line. */}
      {picture && area && (
        <div className="mt-4 flex items-center gap-4 rounded-xl bg-sunken/60 px-4 py-3">
          <span className="label">Preview</span>
          <span className="flex items-center gap-3 rounded-xl bg-surface p-2 shadow-[0_0_0_1px_rgb(10_31_20/0.05)]">
            <CropPreview src={picture.src} w={w} h={h} area={area} size={52} />
            <CropPreview src={picture.src} w={w} h={h} area={area} size={36} />
          </span>
          <CropPreview src={picture.src} w={w} h={h} area={area} size={36} />
        </div>
      )}
      {error && <p className="mt-3 text-sm text-claret-700">{error}</p>}
    </Modal>
  )
}

/** The crop at a small size, blended (multiply) into whatever it sits on, as the app shows product images. */
function CropPreview({ src, w, h, area, size }: { src: string; w: number; h: number; area: CropArea; size: number }) {
  const k = size / area.size
  return (
    <span className="relative block shrink-0 overflow-hidden" style={{ width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.18)) }}>
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none absolute max-w-none mix-blend-multiply"
        style={{ left: -area.x * k, top: -area.y * k, width: w * k, height: h * k }}
      />
    </span>
  )
}
