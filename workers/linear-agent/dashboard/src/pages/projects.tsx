import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as Collapsible from '@radix-ui/react-collapsible'
import { ChevronRight, FolderKanban, Github, Plus, Trash2 } from 'lucide-react'

import {
  createProject,
  deleteProject,
  emptyProject,
  getGitHubOAuthStatus,
  getOAuthStatus,
  getProjects,
  type GitHubRepo,
  type LinearProject,
  type Project,
  searchGitHubRepos,
  searchLinearProjects,
  updateProject,
} from '../lib/api'
import { formatQueryError, nilIfBlank } from '../lib/helpers'
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui'
import {
  EmptyState,
  ErrorPanel,
  FeedbackBanner,
  LoadingPanel,
} from '../components/feedback'
import { Field } from '../components/field'
import { Textarea } from '../components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/dialog'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '../components/ui/combobox'

type ProjectDraft = ReturnType<typeof emptyProject>

function normalizeProjectDraft(project: ProjectDraft): ProjectDraft {
  return {
    name: project.name.trim(),
    linear_project_slug: nilIfBlank(project.linear_project_slug),
    linear_organization_slug: nilIfBlank(project.linear_organization_slug),
    linear_filter_by: project.linear_filter_by ?? 'project',
    linear_label_name: nilIfBlank(project.linear_label_name),
    github_repo: nilIfBlank(project.github_repo),
    github_branch: nilIfBlank(project.github_branch),
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
    github_branch: project.github_branch,
    workspace_root: project.workspace_root,
    env_vars: project.env_vars,
  }
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

function LinearProjectPicker({
  onSelect,
  selectedLabel,
}: {
  onSelect: (project: LinearProject) => void
  selectedLabel: string | null
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['linear-projects'],
    queryFn: () => searchLinearProjects(''),
    staleTime: 60_000,
  })
  const items = data?.projects ?? []
  const selectedItem = selectedLabel
    ? (items.find((p) => p.name === selectedLabel) ?? null)
    : null

  return (
    <Combobox<LinearProject>
      items={items}
      value={selectedItem}
      onValueChange={(project) => {
        if (project) onSelect(project)
      }}
      itemToStringLabel={(p) => p.name}
    >
      <ComboboxInput
        placeholder={
          isLoading ? 'Loading projects…' : 'Search Linear projects…'
        }
      />
      <ComboboxContent>
        <ComboboxEmpty>No projects found.</ComboboxEmpty>
        <ComboboxList>
          {(project) => (
            <ComboboxItem key={project.id} value={project}>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{project.name}</span>
                <span className="text-xs text-muted-foreground">
                  {[project.organization_slug, project.state]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function GitHubRepoPicker({
  onSelect,
  selectedLabel,
}: {
  onSelect: (repo: GitHubRepo) => void
  selectedLabel: string | null
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['github-repos'],
    queryFn: () => searchGitHubRepos(''),
    staleTime: 60_000,
  })
  const items = data?.repos ?? []
  const selectedItem = selectedLabel
    ? (items.find((r) => r.full_name === selectedLabel) ?? null)
    : null

  return (
    <Combobox<GitHubRepo>
      items={items}
      value={selectedItem}
      onValueChange={(repo) => {
        if (repo) onSelect(repo)
      }}
      itemToStringLabel={(r) => r.full_name}
    >
      <ComboboxInput
        placeholder={isLoading ? 'Loading repos…' : 'Search GitHub repos…'}
      />
      <ComboboxContent>
        <ComboboxEmpty>No repos found.</ComboboxEmpty>
        <ComboboxList>
          {(repo) => (
            <ComboboxItem key={repo.id} value={repo}>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">{repo.full_name}</span>
                <span className="text-xs text-muted-foreground">
                  {repo.description ?? (repo.private ? 'Private' : 'Public')}
                </span>
              </div>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

// ---------------------------------------------------------------------------
// Project form dialog
// ---------------------------------------------------------------------------

function ProjectFormDialog({
  open,
  onOpenChange,
  editingProject,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editingProject: Project | null
  onSaved: (message: string) => void
}) {
  const queryClient = useQueryClient()

  const oauthQuery = useQuery({ queryKey: ['oauth-status'], queryFn: getOAuthStatus })
  const githubOauthQuery = useQuery({
    queryKey: ['github-oauth-status'],
    queryFn: getGitHubOAuthStatus,
  })

  const linearConnected =
    oauthQuery.data?.status === 'connected' || oauthQuery.data?.status === 'expired'
  const githubConnected =
    githubOauthQuery.data?.status === 'connected' || githubOauthQuery.data?.status === 'expired'

  const isEditing = editingProject !== null
  const [draft, setDraft] = useState<ProjectDraft>(emptyProject)
  const [selectedLinearName, setSelectedLinearName] = useState<string | null>(null)
  const [selectedGitHubName, setSelectedGitHubName] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset form when dialog opens with new data
  const [lastEditId, setLastEditId] = useState<number | null | undefined>(undefined)
  const editId = editingProject?.id ?? null
  if (open && editId !== lastEditId) {
    setLastEditId(editId)
    setError(null)
    if (editingProject) {
      setDraft(projectToDraft(editingProject))
      setSelectedLinearName(editingProject.linear_project_slug)
      setSelectedGitHubName(editingProject.github_repo)
      // Show advanced if any advanced fields are populated
      setShowAdvanced(
        editingProject.linear_filter_by === 'label' ||
          !!editingProject.linear_label_name ||
          !!editingProject.workspace_root ||
          !!editingProject.env_vars,
      )
    } else {
      setDraft(emptyProject())
      setSelectedLinearName(null)
      setSelectedGitHubName(null)
      setShowAdvanced(false)
    }
  }
  if (!open && lastEditId !== undefined) {
    // Will reset on next open
    setLastEditId(undefined)
  }

  const saveMutation = useMutation({
    mutationFn: (values: { id: number | null; body: ProjectDraft }) =>
      values.id === null ? createProject(values.body) : updateProject(values.id, values.body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      onSaved(isEditing ? 'Project updated.' : 'Project created.')
    },
    onError: (err: unknown) => setError(formatQueryError(err)),
  })

  function handleLinearProjectSelect(project: LinearProject) {
    setSelectedLinearName(project.name)
    setDraft((current) => ({
      ...current,
      name: current.name || project.name,
      // Worker stores this as linear_team_id (the routing key matched against
      // Linear webhook payloads). The field is misnamed at the dashboard
      // layer; carry the team UUID here, not the project slug.
      linear_project_slug: project.team_id ?? project.slug,
      linear_organization_slug: project.organization_slug ?? current.linear_organization_slug,
    }))
  }

  function handleGitHubRepoSelect(repo: GitHubRepo) {
    setSelectedGitHubName(repo.full_name)
    setDraft((current) => ({
      ...current,
      github_repo: repo.full_name,
      github_branch: repo.default_branch,
    }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={false}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit project' : 'New project'}</DialogTitle>
          <DialogDescription>
            Connect a Linear project to a GitHub repository.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            setError(null)
            void saveMutation.mutateAsync({
              id: editingProject?.id ?? null,
              body: normalizeProjectDraft(draft),
            })
          }}
        >
          <Field label="Project name">
            <Input
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Agent Workflow"
              required
              value={draft.name}
            />
          </Field>

          {linearConnected ? (
            <Field label="Linear project">
              <LinearProjectPicker
                onSelect={handleLinearProjectSelect}
                selectedLabel={selectedLinearName}
              />
            </Field>
          ) : null}

          {githubConnected ? (
            <Field label="GitHub repository">
              <GitHubRepoPicker
                onSelect={handleGitHubRepoSelect}
                selectedLabel={selectedGitHubName}
              />
            </Field>
          ) : (
            <Field label="GitHub repository" hint="Connect GitHub in Settings for autocomplete">
              <Input
                onChange={(event) =>
                  setDraft((current) => ({ ...current, github_repo: event.target.value }))
                }
                placeholder="owner/repo"
                value={draft.github_repo ?? ''}
              />
            </Field>
          )}

          <Field label="Branch" hint="Leave blank to use the repository default branch">
            <Input
              onChange={(event) =>
                setDraft((current) => ({ ...current, github_branch: event.target.value }))
              }
              placeholder="main"
              value={draft.github_branch ?? ''}
            />
          </Field>

          <Collapsible.Root open={showAdvanced} onOpenChange={setShowAdvanced}>
            <Collapsible.Trigger className="group flex w-full items-center gap-1.5 rounded-md py-1.5 text-xs font-medium text-th-text-3 transition hover:text-th-text-1">
              <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
              Advanced settings
            </Collapsible.Trigger>

            <Collapsible.Content className="mt-3 grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Linear project slug">
                  <Input
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        linear_project_slug: event.target.value,
                      }))
                    }
                    placeholder="agent-workflow-abc123"
                    value={draft.linear_project_slug ?? ''}
                  />
                </Field>
                <Field label="Organization slug">
                  <Input
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        linear_organization_slug: event.target.value,
                      }))
                    }
                    placeholder="marko-la"
                    value={draft.linear_organization_slug ?? ''}
                  />
                </Field>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Filter mode">
                  <Select
                    value={draft.linear_filter_by ?? 'project'}
                    onValueChange={(value) =>
                      setDraft((current) => ({ ...current, linear_filter_by: value }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="project">Project</SelectItem>
                      <SelectItem value="label">Label</SelectItem>
                    </SelectContent>
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
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, env_vars: event.target.value }))
                  }
                  placeholder="NAME=value"
                  value={draft.env_vars ?? ''}
                />
              </Field>
            </Collapsible.Content>
          </Collapsible.Root>

          {error ? <FeedbackBanner message={error} variant="error" /> : null}

          <div className="flex items-center justify-end gap-3 pt-1">
            <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={saveMutation.isPending} type="submit">
              {isEditing ? 'Save changes' : 'Create project'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Project card
// ---------------------------------------------------------------------------

function ProjectCard({
  project,
  onEdit,
  onDelete,
  deleting,
}: {
  project: Project
  onEdit: (project: Project) => void
  onDelete: (id: number) => void
  deleting: boolean
}) {
  const hasLinear = !!project.linear_project_slug
  const hasGitHub = !!project.github_repo
  const hasMetadata =
    project.linear_filter_by === 'label' || project.workspace_root

  return (
    <div className="session-card rounded-xl border border-th-border bg-th-surface p-4 transition-shadow hover:shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-2.5">
          <h3 className="text-sm font-semibold text-th-text-1">{project.name}</h3>

          <div className="space-y-1.5">
            {hasLinear ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex shrink-0 items-center rounded bg-th-accent-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-th-accent">
                  Linear
                </span>
                <span className="truncate text-xs text-th-text-2">
                  {project.linear_project_slug}
                  {project.linear_organization_slug ? (
                    <span className="text-th-text-4"> · {project.linear_organization_slug}</span>
                  ) : null}
                </span>
              </div>
            ) : null}

            {hasGitHub ? (
              <div className="flex items-center gap-2">
                <span className="inline-flex shrink-0 items-center gap-1 rounded bg-th-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-th-text-3">
                  <Github className="h-2.5 w-2.5" />
                </span>
                <span className="truncate text-xs text-th-text-2">
                  {project.github_repo}
                  {project.github_branch ? (
                    <span className="text-th-text-4"> @ {project.github_branch}</span>
                  ) : null}
                </span>
              </div>
            ) : null}

            {!hasLinear && !hasGitHub ? (
              <span className="text-xs text-th-text-4">No integrations configured</span>
            ) : null}
          </div>

          {hasMetadata ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-th-text-4">
              {project.linear_filter_by === 'label' && project.linear_label_name ? (
                <span>label: {project.linear_label_name}</span>
              ) : null}
              {project.workspace_root ? <span>{project.workspace_root}</span> : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button onClick={() => onEdit(project)} size="sm" type="button" variant="ghost">
            Edit
          </Button>
          <Button
            aria-label="Delete project"
            disabled={deleting}
            onClick={() => onDelete(project.id)}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 className="h-3.5 w-3.5 text-th-danger" />
          </Button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function ProjectsView() {
  const queryClient = useQueryClient()
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: getProjects })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      setFeedback('Project deleted.')
    },
    onError: (error: unknown) => setFeedback(formatQueryError(error)),
  })

  function handleCreate() {
    setEditingProject(null)
    setDialogOpen(true)
    setFeedback(null)
  }

  function handleEdit(project: Project) {
    setEditingProject(project)
    setDialogOpen(true)
    setFeedback(null)
  }

  function handleSaved(message: string) {
    setDialogOpen(false)
    setEditingProject(null)
    setFeedback(message)
  }

  const projects = projectsQuery.data?.projects ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-th-text-1">Projects</h1>
          <p className="mt-1 text-sm text-th-text-3">
            Map Linear projects to GitHub repos and per-project workspace defaults.
          </p>
        </div>
        <Button className="shrink-0" onClick={handleCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New project
        </Button>
      </div>

      {feedback ? <FeedbackBanner message={feedback} /> : null}

      {projectsQuery.isPending ? <LoadingPanel title="Loading projects" compact /> : null}
      {projectsQuery.isError ? (
        <ErrorPanel detail={formatQueryError(projectsQuery.error)} title="Projects unavailable" />
      ) : null}

      {projectsQuery.isSuccess && projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-5 w-5 text-th-text-4" />}
          title="No projects yet"
          description="Create your first project to start mapping Linear issues to GitHub repos."
        />
      ) : null}

      <div className="grid gap-3">
        {projects.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            onEdit={handleEdit}
            onDelete={(id) => {
              setFeedback(null)
              void deleteMutation.mutateAsync(id)
            }}
            deleting={deleteMutation.isPending}
          />
        ))}
      </div>

      <ProjectFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditingProject(null)
        }}
        editingProject={editingProject}
        onSaved={handleSaved}
      />
    </div>
  )
}
