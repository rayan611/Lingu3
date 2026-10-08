import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The publishable key is meant to be in the browser — it grants nothing on its
 * own. Every table has row-level security scoped to `auth.uid()`, so what a
 * signed-in person can read and write is decided by the database, not by this
 * key. Never put the service-role key here.
 */
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** True when the app was built with Supabase credentials. */
export const authConfigured = Boolean(url && key)

let client: SupabaseClient | null = null

export function supabase(): SupabaseClient {
  if (!client) {
    if (!url || !key) {
      throw new Error(
        'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.',
      )
    }
    client = createClient(url, key, {
      auth: {
        // The session is kept in localStorage and refreshed in the background,
        // so reloading the app offline keeps you signed in. That matters here:
        // reviewing must work on a train.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  }
  return client
}
