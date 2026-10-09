import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The publishable key is meant to be in the browser — it grants nothing on its
 * own. Every table has row-level security scoped to `auth.uid()`, so what a
 * signed-in person can read and write is decided by the database, not by this
 * key. Never put the service-role key here.
 */
/**
 * Read through a guard: the check scripts import this module's dependents
 * under plain Node, where `import.meta.env` does not exist at all. Reaching
 * straight through it threw on import and took three unrelated checks with it.
 */
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {}
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY

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
