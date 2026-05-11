import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { getProjects, getSessions } from '../lib/api'
import { formatQueryError } from '../lib/helpers'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui'
import { EmptyState, ErrorPanel, LoadingPanel } from '../components/feedback'
import { Field } from '../components/field'
import { HistoryCard } from './dashboard'

const ALL_PROJECTS = '__all__'

export function HistoryView() {
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  })
  const sessionsQuery = useQuery({
    queryKey: ['sessions', 'history', selectedProjectId],
    queryFn: () => getSessions({ limit: 100, projectId: selectedProjectId ?? undefined }),
  })

  if (sessionsQuery.isPending) {
    return <LoadingPanel title="Loading session history" />
  }

  if (sessionsQuery.isError) {
    return <ErrorPanel title="History unavailable" detail={formatQueryError(sessionsQuery.error)} />
  }

  const payload = sessionsQuery.data
  const projects = projectsQuery.data?.projects ?? []
  const selectedProject = projects.find((project) => project.id === selectedProjectId)

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-th-text-1">History</h1>
        <p className="mt-1 text-sm text-th-text-3">
          Past sessions and their timelines.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Filter by project</CardTitle>
          <CardDescription className="text-[13px]">
            Narrow completed sessions to a single configured project.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="max-w-xs">
            <Field label="Project">
              <Select
                value={selectedProjectId === null ? ALL_PROJECTS : String(selectedProjectId)}
                onValueChange={(value) => {
                  setSelectedProjectId(value === ALL_PROJECTS ? null : Number(value))
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={String(project.id)}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          {projectsQuery.isPending ? (
            <p className="text-xs text-th-text-4">Loading available projects...</p>
          ) : null}

          {projectsQuery.isError ? (
            <p className="text-xs text-th-text-4">
              Project list unavailable. Showing all history until project data loads again.
            </p>
          ) : null}
        </CardContent>
      </Card>

      {payload.sessions.length === 0 ? (
        <EmptyState
          icon={
            <svg className="h-5 w-5 text-th-text-4" fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
              <path d="M9 12h6M9 16h6M5 8h14M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" strokeLinecap="round" />
            </svg>
          }
          title={selectedProject ? `No sessions for ${selectedProject.name} yet` : 'No sessions yet'}
          description={selectedProject ? 'Try another project or switch back to all history.' : 'Completed sessions will appear here.'}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {payload.sessions.map((session, index) => (
          <HistoryCard key={session.id} index={index} session={session} />
        ))}
      </div>
    </div>
  )
}
