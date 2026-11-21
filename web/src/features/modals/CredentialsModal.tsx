import { useState } from 'react'
import { Lock } from 'lucide-react'
import { api } from '../../lib/client'
import { useUiStore } from '../../state/uiStore'

/** Modal shown when git asks for remote credentials (fetch/push/pull/clone). */
export default function CredentialsModal() {
  const req = useUiStore((s) => s.credentialsRequest)
  const setReq = useUiStore((s) => s.setCredentialsRequest)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  if (!req) return null

  const submit = () => {
    void api
      .credentialsResponse(req.opId, username, password)
      .catch(() => undefined)
      .finally(() => {
        setReq(null)
        setUsername('')
        setPassword('')
      })
  }

  const cancel = () => {
    void api.credentialsCancel(req.opId).catch(() => undefined)
    setReq(null)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-96 rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <Lock className="h-4 w-4 text-emerald-400" /> Remote credentials required
        </h2>
        <p className="mt-1 truncate text-xs text-zinc-500" title={req.remote}>
          {req.remote}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <input
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
            placeholder="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-emerald-600"
            placeholder="password / token"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700" onClick={cancel}>
            Cancel
          </button>
          <button className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500" onClick={submit}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}
