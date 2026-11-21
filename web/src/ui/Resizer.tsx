import { useCallback, useEffect, useRef } from 'react'

/**
 * Thin drag handle to resize a flex panel. side="left" grows the panel to the
 * right (right-side drawer), side="right" grows to the left (left sidebar).
 */
export default function Resizer({
  side,
  currentWidth,
  onResize,
}: {
  side: 'left' | 'right'
  currentWidth: number
  onResize: (w: number) => void
}) {
  const dragging = useRef(false)
  const startX = useRef(0)
  const startW = useRef(0)

  const onMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging.current) return
      const dx = e.clientX - startX.current
      onResize(side === 'left' ? startW.current + dx : startW.current - dx)
    },
    [onResize, side],
  )

  const onUp = useCallback(() => {
    dragging.current = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  useEffect(() => {
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onMove, onUp])

  return (
    <div
      className={`absolute top-0 bottom-0 z-10 w-1 cursor-col-resize transition-colors hover:bg-emerald-500/40 ${
        side === 'left' ? '-right-0.5' : '-left-0.5'
      }`}
      onMouseDown={(e) => {
        dragging.current = true
        startX.current = e.clientX
        startW.current = currentWidth
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      data-testid={`resizer-${side}`}
    />
  )
}
