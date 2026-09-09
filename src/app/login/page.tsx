'use client'

/**
 * Login / first-run bootstrap page (Section 9).
 */
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Gamepad2, Loader2, KeyRound, ShieldCheck, Sparkles } from 'lucide-react'
import { apiGet, apiPost, isApiError } from '@/lib/client-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { toast } from '@/sonner-bridge'

interface SsoConnectionPublic {
  id: string
  name: string
}

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<'loading' | 'login' | 'bootstrap'>('loading')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [ssoConnections, setSsoConnections] = useState<SsoConnectionPublic[]>([])

  useEffect(() => {
    apiGet<{ authenticated: boolean; bootstrapped: boolean }>('/api/admin/auth/me')
      .then((data) => {
        if (data.authenticated) {
          router.replace('/')
        } else {
          setMode(data.bootstrapped ? 'login' : 'bootstrap')
        }
      })
      .catch(() => setMode('login'))
  }, [router])

  // SSO buttons for active enterprise connections (public endpoint)
  useEffect(() => {
    if (mode !== 'login') return
    apiGet<{ connections: SsoConnectionPublic[] }>('/api/auth/sso/connections')
      .then((data) => setSsoConnections(data.connections ?? []))
      .catch(() => setSsoConnections([]))
  }, [mode])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const path = mode === 'bootstrap' ? '/api/admin/auth/bootstrap' : '/api/admin/auth/login'
      const res = await apiPost<{ ok?: boolean }>(path, { email, password, name })
      if (isApiError(res)) {
        toast.error(res.error.message, { description: res.error.fix })
        return
      }
      toast.success(mode === 'bootstrap' ? 'Welcome to GamificationOG!' : 'Welcome back!')
      router.replace('/')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 bg-gradient-to-b from-primary/5 via-background to-background p-4">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Gamepad2 className="h-7 w-7 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">GamificationOG</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            The universal, configuration-first, event-driven engagement platform
          </p>
        </div>
      </div>

      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            {mode === 'bootstrap' ? (
              <><Sparkles className="h-4 w-4 text-primary" /> Create owner account</>
            ) : (
              <><ShieldCheck className="h-4 w-4 text-primary" /> Sign in</>
            )}
          </CardTitle>
          <CardDescription>
            {mode === 'bootstrap'
              ? 'First run: set up the platform owner. After this, login is required for everyone.'
              : 'Enter your dashboard credentials.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {mode === 'bootstrap' && (
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" autoComplete="name" />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete={mode === 'bootstrap' ? 'new-password' : 'current-password'} />
              {mode === 'bootstrap' && (
                <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              {mode === 'bootstrap' ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          {mode === 'login' && ssoConnections.length > 0 && (
            <>
              <div className="relative my-4">
                <div className="absolute inset-0 flex items-center"><span className="w-full border-t" /></div>
                <div className="relative flex justify-center text-xs uppercase"><span className="bg-card px-2 text-muted-foreground">or</span></div>
              </div>
              <div className="space-y-2">
                {ssoConnections.map((c) => (
                  <a
                    key={c.id}
                    href={`/api/auth/sso/authorize?connection=${encodeURIComponent(c.id)}`}
                    className="flex w-full items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
                  >
                    <KeyRound className="h-4 w-4" />
                    Sign in with {c.name}
                  </a>
                ))}
                <p className="text-[11px] text-muted-foreground text-center pt-1">
                  Single sign-on via your organization&rsquo;s identity provider (OIDC).
                </p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground/60 text-center max-w-md">
        GamificationOG — events in, decisions out. Rules, challenges, streaks, economies and
        leaderboards as configuration, not code.
      </p>
    </div>
  )
}
