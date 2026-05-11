import { useEffect, useState, useRef, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { Github } from 'lucide-react'

import { ApiError, getAuthStatus, login } from '../lib/api'
import { authClient } from '../lib/auth-client'
import { Button, Card, Input } from '../components/ui'

type ConnectionState = 'checking' | 'connected' | 'disconnected'

function useBackendStatus() {
  const [state, setState] = useState<ConnectionState>('checking')
  const retryRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    async function check() {
      try {
        const status = await getAuthStatus()
        if (cancelled) return
        setState('connected')
        retryRef.current = 0
        if (status.authenticated) {
          window.location.href = '/dashboard/'
        }
      } catch {
        if (cancelled) return
        setState('disconnected')
        const delay = Math.min(1000 * 2 ** retryRef.current, 5_000)
        retryRef.current++
        setTimeout(check, delay)
      }
    }

    check()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

export function LoginView() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const backendStatus = useBackendStatus()

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await login(email, password)
      window.location.href = '/dashboard/'
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Invalid email or password')
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
      await authClient.signIn.social({
        provider: 'github',
        callbackURL: '/dashboard/',
      })
    } catch {
      setError('GitHub sign-in failed')
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
            {backendStatus === 'disconnected' ? (
              <p className="text-sm text-th-warning">Connecting to server...</p>
            ) : (
              <p className="text-sm text-th-text-3">Sign in to your dashboard</p>
            )}
          </div>
          <Input
            autoComplete="email"
            autoFocus
            disabled={backendStatus !== 'connected'}
            name="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
            value={email}
          />
          <Input
            autoComplete="current-password"
            disabled={backendStatus !== 'connected'}
            name="password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            value={password}
          />
          {error && <p className="text-sm text-th-danger">{error}</p>}
          <Button
            disabled={
              loading ||
              !email ||
              !password ||
              backendStatus !== 'connected'
            }
            type="submit"
          >
            {loading ? 'Signing in...' : 'Sign in'}
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
          disabled={loading || backendStatus !== 'connected'}
          className="w-full"
        >
          <Github className="mr-2 h-4 w-4" />
          Continue with GitHub
        </Button>

        <p className="mt-5 text-center text-[13px] text-th-text-4">
          Don&apos;t have an account?{' '}
          <Link
            to="/setup"
            className="font-medium text-th-accent hover:underline"
          >
            Create one
          </Link>
        </p>
      </Card>
    </div>
  )
}
