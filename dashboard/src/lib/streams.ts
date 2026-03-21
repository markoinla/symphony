import { useEffect, useEffectEvent } from 'react'

export function useDashboardStream(onStateChanged: () => void, enabled = true) {
  const handleStateChanged = useEffectEvent(onStateChanged)

  useEffect(() => {
    if (!enabled) {
      return
    }

    const stream = new EventSource('/api/v1/stream/dashboard')

    const listener = () => {
      handleStateChanged()
    }

    stream.addEventListener('state_changed', listener)

    return () => {
      stream.removeEventListener('state_changed', listener)
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
