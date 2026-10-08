import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { authConfigured, supabase } from './supabase'

export interface SessionState {
  /** null = signed out, undefined = still checking */
  session: Session | null | undefined
  userId: string | null
  email: string | null
}

export function useSession(): SessionState {
  const [session, setSession] = useState<Session | null | undefined>(
    authConfigured ? undefined : null,
  )

  useEffect(() => {
    if (!authConfigured) return
    let cancelled = false

    // getSession reads from storage first, so this resolves offline too.
    supabase()
      .auth.getSession()
      .then(({ data }) => {
        if (!cancelled) setSession(data.session)
      })
      .catch(() => {
        if (!cancelled) setSession(null)
      })

    const { data: sub } = supabase().auth.onAuthStateChange((_event, next) => {
      setSession(next)
    })

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  return {
    session,
    userId: session?.user.id ?? null,
    email: session?.user.email ?? null,
  }
}

export async function signIn(email: string, password: string) {
  const { error } = await supabase().auth.signInWithPassword({ email, password })
  if (error) throw new Error(friendly(error.message))
}

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase().auth.signUp({ email, password })
  if (error) throw new Error(friendly(error.message))
  // When email confirmation is on, no session comes back and the person has to
  // click a link first. Saying so beats a form that silently does nothing.
  return { needsConfirmation: !data.session }
}

export async function signOut() {
  await supabase().auth.signOut()
}

function friendly(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login')) return 'Wrong email or password.'
  if (m.includes('already registered')) return 'That email already has an account — sign in instead.'
  if (m.includes('password should be')) return 'Password must be at least 6 characters.'
  if (m.includes('failed to fetch') || m.includes('network')) {
    return 'Could not reach the server. Check your connection.'
  }
  return message
}
