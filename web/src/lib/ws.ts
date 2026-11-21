import { useEffect, useRef } from 'react'
import type { ServerEvent } from './types'

/**
 * Repo event stream: one WebSocket per open repo.
 * The server pushes debounced change events (refs/index/worktree), op
 * progress, and credential requests. Reconnects with backoff; the server
 * re-broadcasts a changed event on lag so we never miss updates.
 */
export function useRepoEvents(
  path: string | null,
  onEvent: (ev: ServerEvent) => void,
): void {
  const cbRef = useRef(onEvent)
  cbRef.current = onEvent

  useEffect(() => {
    if (!path) return
    let ws: WebSocket | null = null
    let closed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws?path=${encodeURIComponent(path)}`)
      ws.onmessage = (m) => {
        try {
          cbRef.current(JSON.parse(m.data) as ServerEvent)
        } catch {
          /* ignore malformed */
        }
      }
      ws.onclose = () => {
        if (closed) return
        retry = Math.min(retry + 1, 6)
        timer = setTimeout(connect, 300 * 2 ** (retry - 1))
      }
      ws.onopen = () => {
        retry = 0
      }
    }
    connect()

    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [path])
}
