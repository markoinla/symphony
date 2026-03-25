import { useState, type FormEvent } from 'react'

import { ApiError, setupPassword } from '../lib/api'
import { Button, Card, Input } from '../components/ui'

export function SetupView() {
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
      await setupPassword(password)
      window.location.href = '/'
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('Password already configured')
        setTimeout(() => { window.location.href = '/login' }, 2000)
      } else {
        setError('Something went wrong')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-th-bg p-4">
      <Card className="w-full max-w-sm p-8">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="flex flex-col items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-th-accent">
              <svg className="h-5 w-5 text-white" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1l2.5 5h5L11 9.5l1.5 5.5L8 12l-4.5 3 1.5-5.5L0.5 6h5z" />
              </svg>
            </div>
            <h1 className="text-lg font-semibold text-th-text-1">Symphony</h1>
            <p className="text-sm text-th-text-3">Set your password</p>
          </div>
          <Input
            autoFocus
            name="password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
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
          <Button disabled={loading || !password || !confirm} type="submit">
            {loading ? 'Setting up...' : 'Set password'}
          </Button>
        </form>
      </Card>
    </div>
  )
}
