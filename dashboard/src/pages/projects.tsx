import { useCallback, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

import {
  createProject,
  deleteProject,
  emptyProject,
  getOAuthStatus,
  getProjects,
  type LinearProject,
  type Project,
  searchLinearProjects,
  updateProject,
} from '../lib/api'
import { formatQueryError, formatJson, nilIfBlank } from '../lib/helpers'
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  Combobox,
  type ComboboxOption,
  ErrorPanel,
  FeedbackBanner,
  Field,
  Input,
  LoadingPanel,
  Select,
  Textarea,
} from '../components/ui'

type ProjectDraft = ReturnType<typeof emptyProject>

function normalizeProjectDraft(project: ProjectDraft): ProjectDraft {
  return {
    name: project.name.trim(),
    linear_project_slug: nilIfBlank(project.linear_project_slug),
    linear_organization_slug: nilIfBlank(project.linear_organization_slug),
    linear_filter_by: project.linear_filter_by ?? 'project',
    linear_label_name: nilIfBlank(project.linear_label_name),
    github_repo: nilIfBlank(project.github_repo),
    workspace_root: nilIfBlank(project.workspace_root),
    env_vars: nilIfBlank(project.env_vars),
  }
}

function projectToDraft(project: Project): ProjectDraft {
  return {
    name: project.name,
    linear_project_slug: project.linear_project_slug,
    linear_organization_slug: project.linear_organization_slug,
    linear_filter_by: project.linear_filter_by,
    linear_label_name: project.linear_label_name,
    github_repo: project.github_repo,
    workspace_root: project.workspace_root,
    env_vars: project.env_vars,
  }
}

function LinearProjectPicker({
  onSelect,
  selectedLabel,
}: {
  onSelect: (project: LinearProject) => void
  selectedLabel: string | null
}) {
  const [searchResults, setSearchResults] = useState<LinearProject[]>([])
  const [loading, setLoading] = useState(false)

  const handleSearch = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const result = await searchLinearProjects(query)
      setSearchResults(result.projects)
    } catch {
      setSearchResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const options: ComboboxOption<LinearProject>[] = searchResults.map((project) => ({
    value: project,
    label: project.name,
    description: [project.organization_slug, project.state].filter(Boolean).join(' · '),
  }))

  return (
    <Combobox
      options={options}
      onSearch={handleSearch}
      onSelect={(option) => onSelect(option.value)}
      placeholder="Search Linear projects..."
      searchPlaceholder="Type to search projects..."
      loading={loading}
      emptyMessage="No projects found."
      value={selectedLabel}
    />
  )
}

export function ProjectsView() {
  const queryClient = useQueryClient()
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  })

  const oauthQuery = useQuery({
    queryKey: ['oauth-status'],
    queryFn: getOAuthStatus,
  })

  const oauthConnected = oauthQuery.data?.status === 'connected'

  const [draft, setDraft] = useState<ProjectDraft>(emptyProject)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [selectedProjectName, setSelectedProjectName] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: (values: { id: number | null; body: ProjectDraft }) =>
      values.id === null ? createProject(values.body) : updateProject(values.id, values.body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      setFeedback(editingId === null ? 'Project created.' : 'Project updated.')
      setDraft(emptyProject())
      setEditingId(null)
      setSelectedProjectName(null)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      setFeedback('Project deleted.')
      setDraft(emptyProject())
      setEditingId(null)
      setSelectedProjectName(null)
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  function handleLinearProjectSelect(project: LinearProject) {
    setSelectedProjectName(project.name)
    setDraft((current) => ({
      ...current,
      name: current.name || project.name,
      linear_project_slug: project.slug,
      linear_organization_slug: project.organization_slug ?? current.linear_organization_slug,
    }))
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-th-text-1">Projects</h1>
        <p className="mt-1 text-sm text-th-text-3">
          Map Linear projects to GitHub repos and per-project workspace defaults.
        </p>
      </div>

      {feedback ? <FeedbackBanner message={feedback} /> : null}

      <div className="grid gap-6 xl:grid-cols-[1.2fr,0.8fr]">
        <Card className="space-y-5">
          <CardHeader>
            <CardTitle>{editingId === null ? 'New project' : 'Edit project'}</CardTitle>
            <CardDescription>
              Configure the connection between a Linear project and a GitHub repository.
            </CardDescription>
          </CardHeader>

          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              setFeedback(null)
              void saveMutation.mutateAsync({ id: editingId, body: normalizeProjectDraft(draft) })
            }}
          >
            {oauthConnected ? (
              <Field label="Linear project">
                <LinearProjectPicker
                  onSelect={handleLinearProjectSelect}
                  selectedLabel={selectedProjectName}
                />
              </Field>
            ) : null}

            <Field label="Project name">
              <Input
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                placeholder="Agent Workflow"
                required
                value={draft.name}
              />
            </Field>

            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Linear project slug or URL">
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, linear_project_slug: event.target.value }))
                  }
                  placeholder="agent-workflow"
                  value={draft.linear_project_slug ?? ''}
                />
              </Field>

              <Field label="Linear organization slug">
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, linear_organization_slug: event.target.value }))
                  }
                  placeholder="marko-la"
                  value={draft.linear_organization_slug ?? ''}
                />
              </Field>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Field label="Filter mode">
                <Select
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, linear_filter_by: event.target.value }))
                  }
                  value={draft.linear_filter_by ?? 'project'}
                >
                  <option value="project">Project</option>
                  <option value="label">Label</option>
                </Select>
              </Field>

              <Field label="Label name">
                <Input
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, linear_label_name: event.target.value }))
                  }
                  placeholder="symphony"
                  value={draft.linear_label_name ?? ''}
                />
              </Field>
            </div>

            <Field label="GitHub repo">
              <Input
                onChange={(event) => setDraft((current) => ({ ...current, github_repo: event.target.value }))}
                placeholder="markoinla/symphony"
                value={draft.github_repo ?? ''}
              />
            </Field>

            <Field label="Workspace root">
              <Input
                onChange={(event) =>
                  setDraft((current) => ({ ...current, workspace_root: event.target.value }))
                }
                placeholder="~/code/symphony-workspaces"
                value={draft.workspace_root ?? ''}
              />
            </Field>

            <Field label="Environment variables">
              <Textarea
                onChange={(event) => setDraft((current) => ({ ...current, env_vars: event.target.value }))}
                placeholder="NAME=value"
                value={draft.env_vars ?? ''}
              />
            </Field>

            <div className="flex items-center gap-3">
              <Button disabled={saveMutation.isPending} type="submit">
                {editingId === null ? 'Create project' : 'Save changes'}
              </Button>
              {editingId !== null ? (
                <Button
                  onClick={() => {
                    setDraft(emptyProject())
                    setEditingId(null)
                    setSelectedProjectName(null)
                    setFeedback(null)
                  }}
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        </Card>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-th-text-2">Current mappings</h3>

          {projectsQuery.isPending ? <LoadingPanel title="Loading projects" compact /> : null}
          {projectsQuery.isError ? (
            <ErrorPanel detail={formatQueryError(projectsQuery.error)} title="Projects unavailable" />
          ) : null}

          {projectsQuery.data?.projects.map((project: Project) => (
            <Card className="space-y-3 p-4" key={project.id}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-th-text-1">{project.name}</div>
                  <div className="mt-1 break-all text-xs text-th-text-3">
                    {project.github_repo ?? 'No repo configured'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    onClick={() => {
                      setDraft(projectToDraft(project))
                      setEditingId(project.id)
                      setSelectedProjectName(null)
                      setFeedback(null)
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Edit
                  </Button>
                  <Button
                    aria-label="Delete project"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      setFeedback(null)
                      void deleteMutation.mutateAsync(project.id)
                    }}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-th-danger" />
                  </Button>
                </div>
              </div>
              <div className="whitespace-pre-wrap break-words rounded-lg bg-th-inset px-3 py-2 font-mono text-xs leading-5 text-th-text-4">
                {formatJson({
                  linear_project_slug: project.linear_project_slug,
                  linear_organization_slug: project.linear_organization_slug,
                  linear_filter_by: project.linear_filter_by,
                  linear_label_name: project.linear_label_name,
                  workspace_root: project.workspace_root,
                })}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
