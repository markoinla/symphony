import { useEffect, useEffectEvent } from 'react'

// SSE streams from the linear-agent Worker.
//
// `/dashboard/api/sessions/live` emits `session_update` events as a JSON
// payload per running session (see src/routes/dashboard.ts). The dashboard
// uses these to refresh the orchestrator/state view, so we treat any
// incoming event as a "state changed" signal and let TanStack Query
// re-fetch from the snapshot endpoints.
//
// The Worker doesn't currently expose a per-session timeline SSE, so
// `useSessionStream` is a no-op until that route lands. Callers still
// receive an unsubscribe to keep React happy.

export function useDashboardStream(
  onStateChanged: () => void,
  enabled = true,
  onAgentsChanged?: () => void,
) {
  const handleStateChanged = useEffectEvent(onStateChanged)
  const handleAgentsChanged = useEffectEvent(onAgentsChanged ?? (() => {}))

  useEffect(() => {
    if (!enabled) return

    const stream = new EventSource('/dashboard/api/sessions/live')

    const onMessage = () => {
      handleStateChanged()
    }

    // The Worker emits unnamed `data:` events (default `message` event).
    // Treat each one as a "something changed" tick.
    stream.addEventListener('message', onMessage)
    stream.onerror = () => {
      // EventSource auto-reconnects; ignore transient errors but keep
      // the agents-changed signal flowing so consumers can rebuild.
      handleAgentsChanged()
    }

    return () => {
      stream.removeEventListener('message', onMessage)
      stream.close()
    }
  }, [enabled])
}

export function useSessionStream(
  _issueId: string | null | undefined,
  _onMessage: (payload: unknown) => void,
  _onMessageUpdate: (payload: unknown) => void,
) {
  // TODO: wire to a Worker SSE timeline once /dashboard/api/sessions/:id/stream
  // exists. For now the session view will fall back to a one-shot fetch.
  useEffect(() => {
    return () => {}
  }, [])
}
