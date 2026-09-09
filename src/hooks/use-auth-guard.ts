'use client'

/**
 * Auth guard hook — verifies the dashboard session, redirects to /login
 * when unauthenticated, and returns the admin identity.
 */
import { useEffect, useState } from 'react'
import { apiGet } from '@/lib/client-api'

export interface AdminIdentity {
  adminUserId: string
  email: string
  name: string
  role: string
}

export interface AuthState {
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'bootstrapping'
  admin: AdminIdentity | null
}

export function useAuthGuard(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading', admin: null })

  useEffect(() => {
    apiGet<{ authenticated: boolean; bootstrapped: boolean; admin?: AdminIdentity }>('/api/admin/auth/me')
      .then((data) => {
        if (data.authenticated) {
          setState({ status: 'authenticated', admin: data.admin ?? null })
        } else if (!data.bootstrapped) {
          setState({ status: 'bootstrapping', admin: null })
        } else {
          setState({ status: 'unauthenticated', admin: null })
          window.location.href = '/login'
        }
      })
      .catch(() => {
        setState({ status: 'unauthenticated', admin: null })
        window.location.href = '/login'
      })
  }, [])

  return state
}
