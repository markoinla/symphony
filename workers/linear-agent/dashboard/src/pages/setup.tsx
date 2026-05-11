import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Github } from 'lucide-react'

import { ApiError, setupAccount } from '../lib/api'
import { authClient } from '../lib/auth-client'
import { Button, Card, Input } from '../components/ui'

// Setup = email/password signup + create the first organization.
// We do them sequentially so the new user lands on the dashboard with
// an active org context already set. Email verification is off — the
// session is issued immediately after signUp.email succeeds.
export function SetupView() {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [orgName, setOrgName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)

    try {
      await setupAccount(email, password, name || undefined)

      // Better Auth's signUp returns the new session; auto-create the
      // first org so the user has a tenant context for everything that
      // follows.
      const slug = slugify(orgName || `${name || email.split('@')[0]}-team`)
      const { data: orgData, error: orgError } = await authClient.organization.create({
        name: orgName || `${name || email.split('@')[0]}'s Team`,
        slug,
      })
      if (orgError || !orgData) {
        setError(orgError?.message ?? 'Could not create organization')
        setLoading(false)
        return
      }

      // Explicitly set the new org active on the session — relying on
      // the plugin's auto-set behavior has been flaky.
      await authClient.organization.setActive({ organizationId: orgData.id })

      window.location.href = '/dashboard/'
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('An account with this email already exists')
        setTimeout(() => {
          window.location.href = '/dashboard/login'
        }, 1500)
      } else if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('Something went wrong')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleGithub = async () => {
    setError('')
    setLoading(true)
    try {
      // For social signup, we direct the user back to /create-organization
      // since GitHub OAuth doesn't collect an org name.
      await authClient.signIn.social({
        provider: 'github',
        callbackURL: '/dashboard/create-organization',
      })
    } catch {
      setError('GitHub sign-up failed')
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
            <h1 className="text-lg font-semibold text-th-text-1">Linear Agent</h1>
            <p className="text-sm text-th-text-3">Create your account</p>
          </div>
          <Input
            autoFocus
            name="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            value={email}
          />
          <Input
            name="name"
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name (optional)"
            type="text"
            value={name}
          />
          <Input
            name="orgName"
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="Organization name"
            type="text"
            value={orgName}
          />
          <Input
            name="password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password (8+ characters)"
            type="password"
            value={password}
          />
          <Input
            name="confirm"
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Confirm password"
            type="password"
            value={confirm}
          />
          {error && <p className="text-sm text-th-danger">{error}</p>}
          <Button
            disabled={loading || !email || !password || !confirm || !orgName}
            type="submit"
          >
            {loading ? 'Setting up...' : 'Create account'}
          </Button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-th-border" />
          <span className="text-xs text-th-text-4">or</span>
          <div className="h-px flex-1 bg-th-border" />
        </div>

        <Button
          type="button"
          variant="secondary"
          onClick={handleGithub}
          disabled={loading}
          className="w-full"
        >
          <Github className="mr-2 h-4 w-4" />
          Continue with GitHub
        </Button>

        <p className="mt-5 text-center text-[13px] text-th-text-4">
          Already have an account?{' '}
          <Link
            to="/login"
            className="font-medium text-th-accent hover:underline"
          >
            Sign in
          </Link>
        </p>
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
