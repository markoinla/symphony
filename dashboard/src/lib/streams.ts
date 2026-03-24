import { useEffect, useEffectEvent } from 'react'

export function useDashboardStream(
  onStateChanged: () => void,
  enabled = true,
  onAgentsChanged?: () => void,
) {
  const handleStateChanged = useEffectEvent(onStateChanged)
  const handleAgentsChanged = useEffectEvent(onAgentsChanged ?? (() => {}))

  useEffect(() => {
    if (!enabled) {
      return
    }

    const stream = new EventSource('/api/v1/stream/dashboard')

    const stateListener = () => {
      handleStateChanged()
    }

    const agentsListener = () => {
      handleAgentsChanged()
    }

    stream.addEventListener('state_changed', stateListener)
    stream.addEventListener('agents_changed', agentsListener)

    return () => {
      stream.removeEventListener('state_changed', stateListener)
      stream.removeEventListener('agents_changed', agentsListener)
      stream.close()
    }
  }, [enabled])
}

export function useSessionStream(
  issueId: string | null | undefined,
  onMessage: (payload: unknown) => void,
  onMessageUpdate: (payload: unknown) => void,
) {
  const handleMessage = useEffectEvent(onMessage)
  const handleMessageUpdate = useEffectEvent(onMessageUpdate)

  useEffect(() => {
    if (!issueId) {
      return
    }

    const stream = new EventSource(`/api/v1/stream/session/${encodeURIComponent(issueId)}`)

    const messageListener = (event: MessageEvent) => {
      handleMessage(JSON.parse(event.data))
    }

    const updateListener = (event: MessageEvent) => {
      handleMessageUpdate(JSON.parse(event.data))
    }

    stream.addEventListener('message', messageListener)
    stream.addEventListener('message_update', updateListener)

    return () => {
      stream.removeEventListener('message', messageListener)
      stream.removeEventListener('message_update', updateListener)
      stream.close()
    }
  }, [issueId])
}
