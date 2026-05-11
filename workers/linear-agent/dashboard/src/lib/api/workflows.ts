// TanStack Query hooks for the workflows + triggers REST surface.
//
// All hooks talk to `/api/v1/*` paths (the contract Agent 2 is shipping),
// but go through `mockOrFetch` — a thin wrapper that returns in-memory
// fixtures while `USE_MOCK_WORKFLOWS_API` is true. Once Agent 2 lands,
// flip the flag in `workflow-mocks.ts` and the dashboard switches over
// without any call-site change here.

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
} from '@tanstack/react-query'

import { ApiError } from '../api'
import { mockApi, USE_MOCK_WORKFLOWS_API } from './workflow-mocks'
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

// ── Fetch helpers ──────────────────────────────────────────────────

async function realFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
    // ignore — non-JSON body
  }
  if (!response.ok) {
    const message =
      (payload as { error?: { message?: string } } | null)?.error?.message ??
      'Request failed'
    throw new ApiError(response.status, payload as never, message)
  }
  return payload as T
}

// Dispatch each REST call either to the mock store or to the real
// fetcher based on the `USE_MOCK_WORKFLOWS_API` flag.
// TODO(track-2): remove the mock branch once the real routes ship.
async function mockOrFetch<T>(
  path: string,
  init: RequestInit | undefined,
  mockImpl: () => T | Promise<T>,
): Promise<T> {
  if (USE_MOCK_WORKFLOWS_API) {
    // Simulate a tiny bit of latency so the spinners actually appear.
    await new Promise((resolve) => setTimeout(resolve, 50))
    return mockImpl()
  }
  return realFetch<T>(path, init)
}

// ── Query keys ─────────────────────────────────────────────────────

export const workflowKeys = {
  all: ['workflows'] as const,
  list: () => [...workflowKeys.all, 'list'] as const,
  detail: (id: string) => [...workflowKeys.all, 'detail', id] as const,
  triggers: (id: string) => [...workflowKeys.all, 'triggers', id] as const,
}

// ── Hooks ──────────────────────────────────────────────────────────

export function useWorkflows() {
  return useQuery({
    queryKey: workflowKeys.list(),
    queryFn: () =>
      mockOrFetch<{ workflows: Workflow[] }>(
        '/api/v1/workflows',
        undefined,
        () => ({ workflows: mockApi.listWorkflows() }),
      ).then((r) => r.workflows),
  })
}

export function useWorkflow(id: string | undefined) {
  return useQuery({
    enabled: !!id,
    queryKey: id ? workflowKeys.detail(id) : ['workflows', 'detail', 'none'],
    queryFn: () =>
      mockOrFetch<{ workflow: Workflow }>(
        `/api/v1/workflows/${id}`,
        undefined,
        () => ({ workflow: mockApi.getWorkflow(id!) }),
      ).then((r) => r.workflow),
  })
}

export function useCreateWorkflow(
  options?: UseMutationOptions<Workflow, Error, WorkflowCreateBody>,
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body) =>
      mockOrFetch<{ workflow: Workflow }>(
        '/api/v1/workflows',
        { method: 'POST', body: JSON.stringify(body) },
        () => ({ workflow: mockApi.createWorkflow(body) }),
      ).then((r) => r.workflow),
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
      mockOrFetch<{ workflow: Workflow }>(
        `/api/v1/workflows/${id}`,
        { method: 'PUT', body: JSON.stringify(body) },
        () => ({ workflow: mockApi.updateWorkflow(id, body) }),
      ).then((r) => r.workflow),
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
      mockOrFetch<{ ok: true }>(
        `/api/v1/workflows/${id}`,
        { method: 'DELETE' },
        () => {
          mockApi.deleteWorkflow(id)
          return { ok: true }
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list() })
    },
  })
}

export function usePublishWorkflow(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      mockOrFetch<{ workflow: Workflow }>(
        `/api/v1/workflows/${id}/publish`,
        { method: 'POST' },
        () => ({ workflow: mockApi.publishWorkflow(id) }),
      ).then((r) => r.workflow),
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
      mockOrFetch<{ workflow: Workflow }>(
        `/api/v1/workflows/${id}/duplicate`,
        { method: 'POST' },
        () => ({ workflow: mockApi.duplicateWorkflow(id) }),
      ).then((r) => r.workflow),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.list() })
    },
  })
}

export function usePreviewWorkflow(id: string) {
  return useMutation({
    mutationFn: (body: WorkflowPreviewRequest) =>
      mockOrFetch<WorkflowPreviewResponse>(
        `/api/v1/workflows/${id}/preview`,
        { method: 'POST', body: JSON.stringify(body) },
        () => mockApi.previewWorkflow(id, body),
      ),
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
      mockOrFetch<{ triggers: Trigger[] }>(
        `/api/v1/workflows/${workflowId}/triggers`,
        undefined,
        () => ({ triggers: mockApi.listTriggers(workflowId!) }),
      ).then((r) => r.triggers),
  })
}

export function useCreateTrigger(workflowId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TriggerCreateBody) =>
      mockOrFetch<{ trigger: Trigger }>(
        `/api/v1/workflows/${workflowId}/triggers`,
        { method: 'POST', body: JSON.stringify(body) },
        () => ({ trigger: mockApi.createTrigger(body) }),
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
      mockOrFetch<{ trigger: Trigger }>(
        `/api/v1/triggers/${args.id}`,
        { method: 'PUT', body: JSON.stringify(args.body) },
        () => ({ trigger: mockApi.updateTrigger(args.id, args.body) }),
      ).then((r) => r.trigger),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.triggers(workflowId) })
    },
  })
}

export function useDeleteTrigger(workflowId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      mockOrFetch<{ ok: true }>(
        `/api/v1/triggers/${id}`,
        { method: 'DELETE' },
        () => {
          mockApi.deleteTrigger(id)
          return { ok: true }
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workflowKeys.triggers(workflowId) })
    },
  })
}
