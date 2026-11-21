import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import type { StashEntry } from '../lib/types'

/**
 * Server-state hooks. TanStack Query caches + dedupes + gives us
 * invalidation-driven refresh — replacing ungit's JSON.stringify
 * payload-diffing and manual debounce layers.
 */

export function useRefs(path: string | null) {
  return useQuery({
    queryKey: ['refs', path],
    queryFn: () => api.refs(path!),
    enabled: !!path,
    // cheap endpoint; refetch on revision bumps via invalidation
    staleTime: Infinity,
  })
}

export function useStatus(path: string | null) {
  return useQuery({
    queryKey: ['status', path],
    queryFn: () => api.status(path!),
    enabled: !!path,
    staleTime: Infinity,
  })
}

/** The stash stack — invalidated alongside status (every stash op touches the worktree). */
export function useStash(path: string | null) {
  return useQuery<StashEntry[]>({
    queryKey: ['stash', path],
    queryFn: () => api.stashList(path!),
    enabled: !!path,
    staleTime: Infinity,
  })
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => api.config(), staleTime: Infinity })
}
