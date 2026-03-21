'use client'

import type { ClientConfig } from '@chaosity/location-client'
import { GeoPlacesClient } from '@chaosity/location-client'
import debug from 'debug'
import type { ReactNode } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'

const log = debug('location-client-react:provider')

interface LocationClientContextValue {
  client: GeoPlacesClient | null
  getToken: () => string | undefined
  loading: boolean
  error: string | null
}

const LocationClientContext = createContext<
  LocationClientContextValue | undefined
>(undefined)

export interface LocationClientProviderProps {
  children: ReactNode
  getConfig: () => Promise<ClientConfig & { expiresAt?: number }>
  /** Seconds before expiry to proactively refresh (default: 60) */
  refreshBuffer?: number
}

export function LocationClientProvider({
  children,
  getConfig,
  refreshBuffer = 60,
}: LocationClientProviderProps) {
  const [client, setClient] = useState<GeoPlacesClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Refs hold live values without triggering re-renders
  const tokenRef = useRef<string | undefined>(undefined)
  const expiresAtRef = useRef<number | null>(null)
  const getConfigRef = useRef(getConfig)
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const ensureValidTokenRef = useRef<() => Promise<void>>(async () => {})

  // Keep getConfig ref current without recreating callbacks
  useEffect(() => {
    getConfigRef.current = getConfig
  }, [getConfig])

  // Stable token getter — passed into GeoPlacesClient so it always reads the live ref
  const getToken = useCallback((): string | undefined => tokenRef.current, [])

  // Returns true when the token is expired or within the refresh buffer window.
  // Treats unknown expiry as expired so we always refresh on first use.
  const isTokenExpired = useCallback((): boolean => {
    if (!expiresAtRef.current) return true
    return Date.now() >= expiresAtRef.current - refreshBuffer * 1000
  }, [refreshBuffer])

  // Refreshes the token exactly once even when called concurrently.
  // All concurrent callers await the same in-flight promise — same pattern as
  // server-side TokenProvider.tokenPromise deduplication.
  const ensureValidToken = useCallback(async (): Promise<void> => {
    if (!isTokenExpired()) return

    // Deduplicate: if a refresh is already in flight, wait for it instead of firing another
    if (refreshPromiseRef.current) {
      log('Token refresh already in progress, waiting...')
      return refreshPromiseRef.current
    }

    const timeUntilExpiry = expiresAtRef.current
      ? Math.floor((expiresAtRef.current - Date.now()) / 1000)
      : 0
    log(
      'Token expired or expiring soon (in %ds), refreshing...',
      timeUntilExpiry,
    )

    refreshPromiseRef.current = (async () => {
      const cfg = await getConfigRef.current()
      tokenRef.current = cfg.token
      expiresAtRef.current = cfg.expiresAt ?? Date.now() + 900_000
      const newExpiry = Math.floor((expiresAtRef.current - Date.now()) / 1000)
      log('Token refreshed (expires in %ds)', newExpiry)
    })()

    try {
      await refreshPromiseRef.current
    } catch (err) {
      log(
        'Token refresh failed: %s',
        err instanceof Error ? err.message : 'Unknown error',
      )
      setError(err instanceof Error ? err.message : 'Failed to refresh token')
    } finally {
      refreshPromiseRef.current = null
    }
  }, [isTokenExpired])

  // Keep ensureValidToken ref current so the send wrapper always uses the latest version
  useEffect(() => {
    ensureValidTokenRef.current = ensureValidToken
  }, [ensureValidToken])

  // Initial load — create the client once.
  // getToken is passed as a callback so the client always reads the live token ref.
  // ensureValidToken is called before each send so expiring tokens are refreshed
  // transparently without recreating the client or causing re-renders.
  useEffect(() => {
    log('Initializing LocationClientProvider')

    getConfigRef
      .current()
      .then((cfg) => {
        tokenRef.current = cfg.token
        expiresAtRef.current = cfg.expiresAt ?? Date.now() + 900_000

        // GeoPlacesClient.send() calls getToken() synchronously for the token value,
        // but token refresh is async. We create a thin send wrapper that:
        // 1. awaits ensureValidToken (via ref — always latest, race-safe)
        // 2. delegates to baseClient which reads the now-fresh token from getToken()
        // The client instance is created once and never recreated on token refresh.
        const baseClient = new GeoPlacesClient({
          apiUrl: cfg.apiUrl,
          token: cfg.token,
          getToken,
        })
        const wrappingClient = Object.create(baseClient) as GeoPlacesClient
        wrappingClient.send = (async (command: unknown) => {
          await ensureValidTokenRef.current()
          // @ts-ignore — generic <TInput, TOutput> can't be redeclared in a lambda; cast on next line handles it
          return baseClient.send(command)
        }) as typeof baseClient.send

        setClient(wrappingClient)

        const expiry = Math.floor((expiresAtRef.current - Date.now()) / 1000)
        log('Client initialized (token expires in %ds)', expiry)
        setLoading(false)
      })
      .catch((err) => {
        log(
          'Initialization failed: %s',
          err instanceof Error ? err.message : 'Unknown error',
        )
        setError(
          err instanceof Error ? err.message : 'Failed to initialize client',
        )
        setLoading(false)
      })
  }, [getToken])

  return (
    <LocationClientContext.Provider
      value={{ client, getToken, loading, error }}
    >
      {children}
    </LocationClientContext.Provider>
  )
}

export function useLocationClient() {
  const context = useContext(LocationClientContext)
  if (context === undefined) {
    throw new Error(
      'useLocationClient must be used within LocationClientProvider',
    )
  }
  return context
}
