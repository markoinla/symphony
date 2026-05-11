import { useState, type FormEvent } from 'react'

import { authClient } from '../lib/auth-client'
import { Button, Card, Input } from '../components/ui'

// Org-onboarding page. Hit when a signed-in user has no active
// organization yet — e.g. after social sign-up via GitHub, which
// doesn't pass through the email setup form. Creating an org sets it
// active on the session and unblocks the rest of the dashboard.
export function CreateOrganizationView() {
  const session = authClient.useSession()
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // If the user already has an active org on the session, bounce home.
  if (session.data?.session.activeOrganizationId) {
    window.location.href = '/dashboard/'
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const slug = slugify(name)
      const { data: orgData, error: createError } = await authClient.organization.create({
        name,
        slug,
      })
      if (createError || !orgData) {
        setError(createError?.message ?? 'Could not create organization')
        return
      }
      await authClient.organization.setActive({ organizationId: orgData.id })
      window.location.href = '/dashboard/'
    } catch {
      setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-th-bg p-4">
      <Card className="w-full max-w-sm gap-0 p-8">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-th-accent">
              <svg className="h-5 w-5 text-white" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1l2.5 5h5L11 9.5l1.5 5.5L8 12l-4.5 3 1.5-5.5L0.5 6h5z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-th-text-1">
              Create your organization
            </h1>
            <p className="text-center text-sm text-th-text-3">
              Projects, integrations, and agent runs are scoped to an
              organization. Give yours a name to get started.
            </p>
          </div>
          <Input
            autoFocus
            name="name"
            onChange={(e) => setName(e.target.value)}
            placeholder="Organization name"
            type="text"
            value={name}
          />
          {error && <p className="text-sm text-th-danger">{error}</p>}
          <Button disabled={loading || !name} type="submit">
            {loading ? 'Creating...' : 'Create organization'}
          </Button>
        </form>
      </Card>
    </div>
  )
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}
