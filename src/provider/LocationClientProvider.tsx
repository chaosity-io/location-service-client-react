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

/**
 * Per-request transport options.
 *
 * Declared structurally rather than imported so this package builds against the
 * currently published client; it matches `SendOptions` there exactly.
 */
export interface SendOptions {
  signal?: AbortSignal
  timeoutMs?: number
  retry?: false | { maxAttempts?: number }
}

/**
 * What the provider hands out.
 *
 * An interface rather than `GeoPlacesClient` because the provider wraps the
 * real client to refresh tokens first, and a class with private fields is not
 * structurally assignable — which is why this used to be an `Object.create`
 * prototype hack.
 */
export interface LocationClient {
  readonly config: { serviceId: string }
  send<TInput, TOutput>(
    command: TInput,
    options?: SendOptions,
  ): Promise<TOutput>
}

interface LocationClientContextValue {
  client: LocationClient | null
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

const DEFAULT_LIFETIME_MS = 900_000

export function LocationClientProvider({
  children,
  getConfig,
  refreshBuffer = 60,
}: LocationClientProviderProps) {
  const [client, setClient] = useState<LocationClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const tokenRef = useRef<string | undefined>(undefined)
  const expiresAtRef = useRef<number | null>(null)
  const getConfigRef = useRef(getConfig)
  const refreshPromiseRef = useRef<Promise<void> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    getConfigRef.current = getConfig
  }, [getConfig])

  const isTokenExpired = useCallback((): boolean => {
    if (!expiresAtRef.current) return true
    return Date.now() >= expiresAtRef.current - refreshBuffer * 1000
  }, [refreshBuffer])

  /**
   * Refresh once, however many callers ask at the same moment.
   *
   * REJECTS on failure. It used to swallow the error into state and resolve,
   * so `send` carried on with the token it already had — guaranteeing a 401 on
   * the very next call and reporting it as an API error rather than a refresh
   * failure.
   */
  const refreshToken = useCallback(async (): Promise<void> => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current

    refreshPromiseRef.current = (async () => {
      const cfg = await getConfigRef.current()
      tokenRef.current = cfg.token
      expiresAtRef.current = cfg.expiresAt ?? Date.now() + DEFAULT_LIFETIME_MS
      log(
        'Token refreshed (expires in %ds)',
        Math.floor((expiresAtRef.current - Date.now()) / 1000),
      )
      if (mountedRef.current) setError(null)
    })()

    try {
      await refreshPromiseRef.current
      scheduleRefreshRef.current()
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to refresh token'
      log('Token refresh failed: %s', message)
      if (mountedRef.current) setError(message)
      throw err
    } finally {
      refreshPromiseRef.current = null
    }
  }, [])

  /**
   * Refresh AHEAD of expiry, on a timer.
   *
   * This is the whole fix for the map path. MapLibre's `transformRequest` is
   * synchronous by contract, so `getToken` cannot await anything — the token it
   * reads has to be valid already. Refresh used to happen only inside the `send`
   * wrapper, which the map never calls: it requests tiles, glyphs and sprites
   * directly. So after 15 minutes every map request failed, for as long as the
   * page stayed open, and no amount of panning recovered it.
   */
  const scheduleRefresh = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (!expiresAtRef.current) return

    const delay = Math.max(
      0,
      expiresAtRef.current - refreshBuffer * 1000 - Date.now(),
    )
    log('Next refresh in %ds', Math.floor(delay / 1000))
    timerRef.current = setTimeout(() => {
      // Errors are already surfaced onto state by refreshToken; swallow here so
      // a failed background refresh cannot become an unhandled rejection.
      void refreshToken().catch(() => {})
    }, delay)
  }, [refreshBuffer, refreshToken])

  // refreshToken and scheduleRefresh reference each other; a ref breaks the cycle
  // without recreating either callback on every render.
  const scheduleRefreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    scheduleRefreshRef.current = scheduleRefresh
  }, [scheduleRefresh])

  /**
   * Synchronous read for the map path.
   *
   * If the token is already stale — a timer that never fired because the tab was
   * backgrounded and throttled — this kicks off a refresh but cannot wait for it.
   * The current read still returns the stale value; the point is that the NEXT
   * one will not.
   */
  const getToken = useCallback((): string | undefined => {
    // `tokenRef.current` guards the pre-initialisation window: until the first
    // config load lands there is no expiry to judge, and firing here would race
    // the initial fetch and request a second token nobody asked for.
    if (tokenRef.current && isTokenExpired() && !refreshPromiseRef.current) {
      log('Stale token read — refreshing in the background')
      void refreshToken().catch(() => {})
    }
    return tokenRef.current
  }, [isTokenExpired, refreshToken])

  const ensureValidToken = useCallback(async (): Promise<void> => {
    if (!isTokenExpired()) return
    await refreshToken()
  }, [isTokenExpired, refreshToken])

  const ensureValidTokenRef = useRef(ensureValidToken)
  useEffect(() => {
    ensureValidTokenRef.current = ensureValidToken
  }, [ensureValidToken])

  /**
   * A backgrounded tab has its timers throttled, so the scheduled refresh can be
   * arbitrarily late. Refresh on the way back in, before the user touches the map.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        tokenRef.current &&
        isTokenExpired()
      ) {
        log('Tab visible again with a stale token — refreshing')
        void refreshToken().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [isTokenExpired, refreshToken])

  useEffect(() => {
    mountedRef.current = true
    log('Initializing LocationClientProvider')

    getConfigRef
      .current()
      .then((cfg) => {
        if (!mountedRef.current) return
        tokenRef.current = cfg.token
        expiresAtRef.current = cfg.expiresAt ?? Date.now() + DEFAULT_LIFETIME_MS

        const baseClient = new GeoPlacesClient({
          apiUrl: cfg.apiUrl,
          token: cfg.token,
          getToken,
        })

        // A plain object, not Object.create(baseClient): the prototype hack was
        // opaque, and its `send` dropped the second argument entirely — so once
        // the client gained `signal`/`timeoutMs`, every option passed through
        // this provider would have been silently discarded.
        const refreshing: LocationClient = {
          config: baseClient.config,
          async send<TInput, TOutput>(
            command: TInput,
            options?: SendOptions,
          ): Promise<TOutput> {
            await ensureValidTokenRef.current()
            return (
              baseClient.send as (
                c: TInput,
                o?: SendOptions,
              ) => Promise<TOutput>
            )(command, options)
          },
        }

        setClient(refreshing)
        scheduleRefreshRef.current()
        log(
          'Client initialized (token expires in %ds)',
          Math.floor((expiresAtRef.current - Date.now()) / 1000),
        )
        setLoading(false)
      })
      .catch((err) => {
        if (!mountedRef.current) return
        const message =
          err instanceof Error ? err.message : 'Failed to initialize client'
        log('Initialization failed: %s', message)
        setError(message)
        setLoading(false)
      })

    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
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
