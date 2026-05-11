// TanStack Query hooks for the workflows + triggers REST surface at
// /api/v1/*. Types come from `./workflow-types`, which re-exports the
// Worker's Zod schemas via the `@server/*` path alias — so request and
// response shapes are always in lockstep with the route handlers.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'

import { ApiError } from '../api'
import type {
  Trigger,
  TriggerCreateBody,
  TriggerUpdateBody,
  Workflow,
  WorkflowCreateBody,
  WorkflowPreviewRequest,
  WorkflowPreviewResponse,
  WorkflowUpdateBody,
} from './workflow-types'

// ── Fetch helper ───────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    credentials: 'same-origin',
    ...init,
  })
  if (response.status === 204) return null as T
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // non-JSON body — leave payload null
  }
  if (!response.ok) {
    const message =
      (payload as { error?: string | { message?: string } } | null)?.error
        ?.toString?.() ?? 'Request failed'
    throw new ApiError(response.status, payload as never, message)
  }
  return payload as T
}

// ── Query keys ─────────────────────────────────────────────────────

export const workflowKeys = {
  all: ['workflows'] as const,
  list: () => [...workflowKeys.all, 'list'] as const,
  detail: (id: string) => [...workflowKeys.all, 'detail', id] as const,
  triggers: (id: string) => [...workflowKeys.all, 'triggers', id] as const,
}

// ── Workflows ──────────────────────────────────────────────────────

export function useWorkflows() {
  return useQuery({
    queryKey: workflowKeys.list(),
    queryFn: () =>
      apiFetch<{ workflows: Workflow[] }>('/api/v1/workflows').then(
        (r) => r.workflows,
      ),
  })
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    enabled: !!id,
    queryKey: id ? workflowKeys.detail(id) : ['workflows', 'detail', 'none'],
    queryFn: () =>
      apiFetch<{ workflow: Workflow }>(`/api/v1/workflows/${id}`).then(
        (r) => r.workflow,
      ),
  })
}

export function useCreateWorkflow(
  options?: UseMutationOptions<Workflow, Error, WorkflowCreateBody>,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body) =>
      apiFetch<{ workflow: Workflow }>('/api/v1/workflows', {
        method: 'POST',
        body: JSON.stringify(body),
      }).then((r) => r.workflow),
    onSuccess: (...args) => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list() })
      options?.onSuccess?.(...args)
    },
    ...options,
  })
}

export function useUpdateWorkflow(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: WorkflowUpdateBody) =>
      apiFetch<{ workflow: Workflow }>(`/api/v1/workflows/${id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }).then((r) => r.workflow),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.detail(id) })
      void qc.invalidateQueries({ queryKey: workflowKeys.list() })
    },
  })
}

export function useDeleteWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`/api/v1/workflows/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list() })
    },
  })
}

export function usePublishWorkflow(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiFetch<{ workflow: Workflow }>(`/api/v1/workflows/${id}/publish`, {
        method: 'POST',
      }).then((r) => r.workflow),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.detail(id) })
      void qc.invalidateQueries({ queryKey: workflowKeys.list() })
    },
  })
}

export function useDuplicateWorkflow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ workflow: Workflow }>(`/api/v1/workflows/${id}/duplicate`, {
        method: 'POST',
      }).then((r) => r.workflow),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list() })
    },
  })
}

export function usePreviewWorkflow(id: string) {
  return useMutation({
    mutationFn: (body: WorkflowPreviewRequest) =>
      apiFetch<WorkflowPreviewResponse>(`/api/v1/workflows/${id}/preview`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  })
}

// ── Triggers ───────────────────────────────────────────────────────

export function useTriggers(workflowId: string | undefined) {
  return useQuery({
    enabled: !!workflowId,
    queryKey: workflowId
      ? workflowKeys.triggers(workflowId)
      : ['workflows', 'triggers', 'none'],
    queryFn: () =>
      apiFetch<{ triggers: Trigger[] }>(
        `/api/v1/workflows/${workflowId}/triggers`,
      ).then((r) => r.triggers),
  })
}

export function useCreateTrigger(workflowId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TriggerCreateBody) =>
      apiFetch<{ trigger: Trigger }>(
        `/api/v1/workflows/${workflowId}/triggers`,
        { method: 'POST', body: JSON.stringify(body) },
      ).then((r) => r.trigger),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.triggers(workflowId) })
    },
  })
}

export function useUpdateTrigger(workflowId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { id: string; body: TriggerUpdateBody }) =>
      apiFetch<{ trigger: Trigger }>(`/api/v1/triggers/${args.id}`, {
        method: 'PUT',
        body: JSON.stringify(args.body),
      }).then((r) => r.trigger),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.triggers(workflowId) })
    },
  })
}

export function useDeleteTrigger(workflowId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ ok: true }>(`/api/v1/triggers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.triggers(workflowId) })
    },
  })
}
