import type { SessionRow } from "./api";

export interface SSESessionEvent {
  type: "session_update";
  session: SessionRow;
}

export function connectSessionsSSE(
  onEvent: (event: SSESessionEvent) => void,
  onError?: (error: Event) => void,
): () => void {
  const es = new EventSource("/dashboard/api/sessions/live");

  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as SSESessionEvent;
      onEvent(data);
    } catch {
      // ignore malformed events
    }
  };

  es.onerror = (event) => {
    onError?.(event);
  };

  return () => es.close();
}
