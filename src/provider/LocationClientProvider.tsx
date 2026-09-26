'use client'

import type {
  ClientConfig,
  VerifyAddressResponse,
} from '@chaosity/location-client'
import {
  type AppConfigClaims,
  GeoPlacesClient,
  TOKEN_REFRESH_BUFFER_SECONDS,
  readTokenExpiry,
} from '@chaosity/location-client'
import debug from 'debug'
import type { ReactNode } from 'react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

const log = debug('location-client-react:provider')

/**
 * Per-request transport options.
 *
 * Declared structurally rather than imported, like `LocationClient` below. A
 * hand copy does not move when the core does — `overallTimeoutMs` reached the
 * core in 0.8.0 and not this copy (#26) — so `test/core-surface.test.ts` fails
 * while the core's `SendOptions` has a key this one lacks.
 */
export interface SendOptions {
  /** Caller cancellation. Aborting rejects with code `AbortedException`. */
  signal?: AbortSignal
  /** Per ATTEMPT, not for the whole call. */
  timeoutMs?: number
  /** The whole call: attempts and the waits between them. Core 0.8.0+. */
  overallTimeoutMs?: number
  /** `false` disables retries entirely. */
  retry?: false | { maxAttempts?: number }
}

/**
 * What the provider hands out.
 *
 * An interface rather than `GeoPlacesClient` because the provider wraps the
 * real client to refresh tokens first, and a class with private fields is not
 * structurally assignable — which is why this used to be an `Object.create`
 * prototype hack.
 *
 * It must carry every public member of the core client this package builds
 * with: `test/core-surface.test.ts` fails when the core gains one (#26).
 */
export interface LocationClient {
  readonly config: { serviceId: string }
  send<TInput, TOutput>(
    command: TInput,
    options?: SendOptions,
  ): Promise<TOutput>
  /**
   * Verify a PlaceId through `POST /address/verify`: the full place record plus
   * `verified`, the one Places result an integrator may store (#26). A
   * `verified: false` resolves; it is not an error. Refreshes a stale token
   * first, as `send` does.
   *
   * Needs @chaosity/location-client 0.10.0 or later, the peer range's floor.
   * `send(new VerifyAddressCommand({ PlaceId }))` is the same request.
   *
   * Billed per call, whether or not the address verifies: call it once per
   * chosen PlaceId, at submit.
   */
  verifyAddress(
    placeId: string,
    options?: SendOptions,
  ): Promise<VerifyAddressResponse>
  /**
   * This application's own configuration, read from the access token
   * (api#65). The fields are whatever the installed @chaosity/location-client
   * reads — its `AppConfigClaims` is the list, and this passes that client's
   * answer through unchanged. So a field the core adds appears here with no
   * change to this package, and is absent under a core too old to read it;
   * the peer range cannot say which.
   *
   * Here so a React app can SHOW its own settings: populate a country
   * selector with the markets it serves, label a settings screen. Being a
   * few minutes stale is cosmetic for that.
   *
   * It is not an entitlement check, and none of it may be used to shape or
   * refuse requests. The token is a snapshot; the API reads every setting
   * fresh from the application on every call. Injecting a stale country
   * scope turns a request that would have succeeded into a 400. See
   * `AppConfigClaims` in @chaosity/location-client for the measurement.
   */
  getAppConfig(): AppConfigClaims
}

interface LocationClientContextValue {
  client: LocationClient | null
  getToken: () => string | undefined
  /**
   * The API `client` talks to, from the same `getConfig` answer as the token
   * `getToken` returns (#14). Build a map's style and tile URLs from this
   * rather than restating the URL, so a map and its token cannot come from two
   * different configurations. `null` until a configuration has loaded, and
   * again while a new `configKey` loads.
   */
  apiUrl: string | null
  loading: boolean
  error: string | null
}

const LocationClientContext = createContext<
  LocationClientContextValue | undefined
>(undefined)

export interface LocationClientProviderProps {
  children: ReactNode
  getConfig: () => Promise<ClientConfig & { expiresAt?: number }>
  /**
   * What `getConfig` answers for: an organisation or application id.
   *
   * Changing it drops the old configuration's token, client and `apiUrl` in
   * the same render, and asks `getConfig` again, without remounting the
   * children (#14). A client or a `getToken` kept from before the change
   * refuses from then on, rather than pairing one configuration's token with
   * the other's URL.
   *
   * `getConfig`'s own identity is deliberately not such a signal: it is
   * usually an inline function, new on every render.
   */
  configKey?: string | number
}

const DEFAULT_LIFETIME_MS = 900_000

/** The backoff after an attempt that brought no usable token (#34, #35, #36). */
const RETRY_BASE_MS = 1_000
const RETRY_CAP_MS = 30_000

/**
 * When this token needs replacing.
 *
 * The `exp` claim first — it is the only value that cannot disagree with what
 * the API will accept, and the server-side TokenProvider reads the same one.
 * `expiresAt` is whatever `getConfig` chose to report, and the final fallback
 * is a guess used only when the token cannot be parsed at all.
 */
function expiryOf(cfg: ClientConfig & { expiresAt?: number }): number {
  return (
    readTokenExpiry(cfg.token) ??
    cfg.expiresAt ??
    Date.now() + DEFAULT_LIFETIME_MS
  )
}

/**
 * How long to wait after the `strikes`-th attempt in a row that brought no
 * usable token. Exponential and capped, with full jitter so that the tabs one
 * outage hit together do not all come back together, and never under the
 * base: a token route that fails fast is still asked at most once a second.
 */
function backoffMs(strikes: number): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** strikes)
  return Math.max(RETRY_BASE_MS, Math.random() * ceiling)
}

/**
 * The wait a failure asked for: the core's `LocationServiceException` carries
 * a 429's or 503's `Retry-After` as `retryAfterMs`.
 */
function retryAfterOf(err: unknown): number | undefined {
  const ms = (err as { retryAfterMs?: unknown } | null | undefined)
    ?.retryAfterMs
  return typeof ms === 'number' && ms > 0 ? ms : undefined
}

/** Why no new call to `getConfig` may start yet, and until when. */
interface Hold {
  until: number
  /**
   * The failure that set it. `null` when the last answer SUCCEEDED with a
   * token this browser already judges stale (#35): the server handed it back,
   * so the server still accepts it, and a send may go out with it.
   */
  error: unknown
  /** The server asked for this wait, so nothing overrides it. */
  retryAfter: boolean
}

/**
 * Who is asking for a token, which decides whether a hold stops them.
 *
 * - `scheduled`: a configuration's first load, and the provider's own timer.
 *   A hold sets that timer, so it never consults one: a timer can fire a
 *   millisecond before the instant it was set for (a browser truncates the
 *   delay to whole milliseconds), and one refused there would never be
 *   re-armed. The retries would stop for good.
 * - `auto`: a stale read, a send's pre-flight. Always waits. These are what
 *   used to ask as fast as `getConfig` could answer (#35, #36): a map reads
 *   its token for every tile.
 * - `user`: the tab or the network coming back. Overrides our own backoff,
 *   which was only a guess and is now out of date, but never `Retry-After`.
 * - `rejected`: the API refused the token (the core's `refreshToken`).
 *   Overrides #35's floor, because a 401 is the server's word where the floor
 *   is only this clock's. Never a failure: asking a failing token route once
 *   per request is #36 over again.
 */
type Trigger = 'scheduled' | 'auto' | 'user' | 'rejected'

function overrides(trigger: Trigger, hold: Hold): boolean {
  if (trigger === 'scheduled') return true
  if (hold.retryAfter) return false
  if (trigger === 'user') return true
  return trigger === 'rejected' && hold.error === null
}

type ConfigKey = LocationClientProviderProps['configKey']

/** A client, and the `apiUrl` it was built for. */
interface Session {
  client: LocationClient
  apiUrl: string
}

/**
 * Everything that belongs to ONE configuration: one `configKey`, answered with
 * one `apiUrl`.
 *
 * A new configuration is a new object, and nothing carries over (#14). That
 * is the point: the defect was per-configuration state that outlived a switch
 * because nothing reset it, so a field added here is reset by construction.
 * Only the installed object (`configRef.current`) is live. Code that awaits
 * compares the object it started with against the live one before it writes
 * anything, and every function handed out checks the same, so a late answer,
 * a kept client or a kept `getToken` of an old configuration does nothing.
 */
interface ConfigState {
  key: ConfigKey
  token: string | undefined
  expiresAt: number | null
  /** The one call to `getConfig` in flight, shared by everyone who asks. */
  attempt: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  hold: Hold | null
  /** Attempts in a row that brought no usable token; sets the backoff. */
  strikes: number
  session: Session | null
  /**
   * The map path's synchronous read, for as long as this configuration is
   * live. It exists before any token does, and it is the SAME function before
   * and after the first one arrives: a map keeps the `transformRequest` it
   * was built with (react-map-gl hands it to MapLibre's constructor once), so
   * one built at mount has to read the token with the function it got then.
   */
  getToken: () => string | undefined
}

type Refs = {
  config: { current: ConfigState | null }
  refresh: { current: (trigger: Trigger) => Promise<void> }
}

function isStale(state: ConfigState): boolean {
  if (!state.expiresAt) return true
  return Date.now() >= state.expiresAt - TOKEN_REFRESH_BUFFER_SECONDS * 1000
}

function newConfig(key: ConfigKey, refs: Refs): ConfigState {
  const state: ConfigState = {
    key,
    token: undefined,
    expiresAt: null,
    attempt: null,
    timer: null,
    hold: null,
    strikes: 0,
    session: null,
    /**
     * If the token is already stale — a timer that never fired because the
     * tab was backgrounded and throttled — this kicks off a refresh but cannot
     * wait for it. The current read still returns the stale value; the point
     * is that the NEXT one will not. While a hold stands, the refresh it asks
     * for is refused.
     */
    getToken: () => {
      if (refs.config.current !== state) return undefined
      // `state.token` guards the pre-initialisation window: until the first
      // config load lands there is no expiry to judge, and firing here would
      // race the initial fetch and request a second token nobody asked for.
      if (state.token && isStale(state) && !state.attempt) {
        void refs.refresh.current('auto').catch(() => {})
      }
      return state.token
    },
  }
  return state
}

const replacedError = () =>
  new Error(
    'This location client belongs to a configuration LocationClientProvider has since replaced or unmounted. Use the one useLocationClient() returns now.',
  )

export function LocationClientProvider({
  children,
  getConfig,
  configKey,
}: LocationClientProviderProps) {
  const getConfigRef = useRef(getConfig)
  // The installed configuration: null only between one being disposed and the
  // next installed, and after unmount.
  const configRef = useRef<ConfigState | null>(null)
  // `refresh` is reached from the timer, from each configuration's `getToken`
  // and from the functions every client is built with; a ref breaks the cycle
  // without recreating any of them.
  const refreshRef = useRef<(trigger: Trigger) => Promise<void>>(() =>
    Promise.resolve(),
  )
  const refs = useMemo<Refs>(
    () => ({ config: configRef, refresh: refreshRef }),
    [],
  )

  const [config, setConfig] = useState(() => newConfig(configKey, refs))
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // A new key is a new configuration in the very render that carries it, not
  // one render later from an effect: no child is handed the old client, and a
  // map built now gets the `getToken` that will read the new token. React's
  // pattern for adjusting state when a prop changes; `Object.is`, because
  // `NaN !== NaN` would loop forever.
  if (!Object.is(config.key, configKey)) {
    setConfig(newConfig(configKey, refs))
    setSession(null)
    setLoading(true)
    setError(null)
  }

  useEffect(() => {
    getConfigRef.current = getConfig
  }, [getConfig])

  /**
   * Arm the timer for the next attempt: ahead of expiry, or when a hold ends.
   *
   * Refreshing AHEAD of expiry is the whole fix for the map path. MapLibre's
   * `transformRequest` is synchronous by contract, so `getToken` cannot await
   * anything — the token it reads has to be valid already. Refresh used to
   * happen only inside the `send` wrapper, which the map never calls: it
   * requests tiles, glyphs and sprites directly. So after 15 minutes every map
   * request failed, for as long as the page stayed open, and no amount of
   * panning recovered it.
   */
  const schedule = useCallback((state: ConfigState, at: number) => {
    if (state.timer) clearTimeout(state.timer)
    const delay = Math.max(0, at - Date.now())
    log('Next attempt in %ds', Math.floor(delay / 1000))
    state.timer = setTimeout(() => {
      // Failures are already surfaced onto state by refresh; swallow here so
      // a failed background attempt cannot become an unhandled rejection.
      void refreshRef.current('scheduled').catch(() => {})
    }, delay)
  }, [])

  /**
   * The client for one configuration's `apiUrl`.
   *
   * Everything built here checks that its configuration is still the live one,
   * and refuses once it is not (#14). Reading the provider's token regardless
   * was the defect: a client kept across a switch sent the new configuration's
   * token to its old URL.
   */
  const build = useCallback((state: ConfigState, apiUrl: string): Session => {
    // `session` is declared at the end; these only run after it exists.
    const isLive = () =>
      configRef.current === state && state.session === session

    /**
     * The pre-send refresh. While #35's floor holds it resolves, and the send
     * goes out with the token the server has just handed back.
     *
     * When the refresh fails, or a failed one holds (#36), the send still goes
     * out with the token in hand for as long as that token is before its own
     * `exp`: the API accepts it, and the map is sending it for every tile, so
     * refusing a `send` then made the two paths disagree (Mehdi, 26 Sep 2026).
     * Past `exp` it rejects with the refresh error, so the consumer learns the
     * token endpoint is down rather than being told the API refused them.
     * That is the line the provider's old behaviour missed: it swallowed the
     * failure and sent whatever it held, expired or not.
     */
    const ready = async () => {
      if (!isLive()) throw replacedError()
      if (isStale(state)) {
        try {
          await refreshRef.current('auto')
        } catch (err) {
          // A replaced client is refused on the line after this block.
          const usable =
            state.token !== undefined &&
            state.expiresAt !== null &&
            Date.now() < state.expiresAt
          if (!usable) throw err
          log('Refresh failed; sending with the token in hand until its exp')
        }
      }
      if (!isLive()) throw replacedError()
    }

    const baseClient = new GeoPlacesClient({
      apiUrl,
      // No static `token`: the core falls back to it whenever `getToken` has
      // nothing, and here that means this client has been replaced.
      getToken: () => (isLive() ? state.getToken() : undefined),
      /**
       * The 401 escape hatch (#19).
       *
       * Covers what the timer cannot: a token revoked from the portal, or
       * minted against a client secret since rotated, is refused by the API
       * while still minutes from its own `exp` — so nothing on this side has
       * any reason to replace it, and every request fails until the buffer
       * finally comes around. `getToken` cannot help, being synchronous.
       *
       * The client awaits this after a 401 and retries the request once with
       * what it returns; the same token, or nothing, means no retry, so a
       * doomed request is never sent — or billed — twice.
       *
       * @chaosity/location-client 0.8.0 and later also calls it BEFORE the
       * first send when it holds no token at all. Here that means this client
       * has been replaced, which is refused below, or that `getConfig`
       * answered without a token, which is asked for again as after a 401.
       *
       * It REJECTS when the refresh itself fails, and that is left to
       * propagate out of `send` deliberately: the consumer learns the token
       * endpoint is down rather than being told the API rejected them. Unlike
       * the pre-flight path in `ready`, it never falls back to the token in
       * hand: the API has just refused that token.
       */
      refreshToken: async () => {
        if (!isLive()) throw replacedError()
        await refreshRef.current('rejected')
        if (!isLive()) throw replacedError()
        return state.token
      },
    })

    // A plain object, not Object.create(baseClient): the prototype hack was
    // opaque, and its `send` dropped the second argument entirely — so once
    // the client gained `signal`/`timeoutMs`, every option passed through
    // this provider would have been silently discarded.
    const client: LocationClient = {
      config: baseClient.config,
      async send<TInput, TOutput>(
        command: TInput,
        options?: SendOptions,
      ): Promise<TOutput> {
        await ready()
        return (
          baseClient.send as (c: TInput, o?: SendOptions) => Promise<TOutput>
        )(command, options)
      },
      // Behind the same pre-send refresh as `send`: forwarding it bare
      // would send a stale token that `send` would have replaced (#26).
      async verifyAddress(
        placeId: string,
        options?: SendOptions,
      ): Promise<VerifyAddressResponse> {
        await ready()
        return baseClient.verifyAddress(placeId, options)
      },
      // Reads whatever token the client currently holds. Deliberately not
      // awaiting a refresh: this is display data, callers expect it to be
      // synchronous, and a token that is minutes from expiry carries the
      // same application config as its replacement will. Once this client is
      // replaced it answers `{}`: the core reads through the bound `getToken`.
      getAppConfig(): AppConfigClaims {
        return baseClient.getAppConfig()
      },
    }

    const session: Session = { client, apiUrl }
    return session
  }, [])

  /**
   * The one place `getConfig` is called: the first load, every refresh and
   * every retry. Once at a time, however many callers ask at the same moment.
   *
   * REJECTS on failure. It used to swallow the error into state and resolve,
   * so `send` carried on with the token it already had — guaranteeing a 401 on
   * the very next call and reporting it as an API error rather than a refresh
   * failure.
   *
   * Every outcome now decides when the next attempt may start (see `Hold`).
   * Nothing used to: a failed first load scheduled no retry at all and left
   * `client` null for the rest of the page view (#34); a failed refresh let
   * every stale read ask again at once (#36); and a token already stale by
   * this clock was asked for again as soon as it arrived (#35). The first load
   * was also the only call that could build a client. Now whichever attempt
   * succeeds first builds it.
   */
  const refresh = useCallback(
    (trigger: Trigger): Promise<void> => {
      const state = configRef.current
      if (!state) return Promise.reject(replacedError())
      if (state.attempt) return state.attempt
      const { hold } = state
      if (hold && Date.now() < hold.until && !overrides(trigger, hold)) {
        return hold.error === null
          ? Promise.resolve()
          : Promise.reject(hold.error)
      }

      log('Asking getConfig (%s)', trigger)
      const attempt = (async () => {
        let cfg: ClientConfig & { expiresAt?: number }
        try {
          cfg = await getConfigRef.current()
        } catch (err) {
          if (configRef.current !== state) throw replacedError()
          state.strikes += 1
          const retryAfterMs = retryAfterOf(err)
          state.hold = {
            until: Date.now() + (retryAfterMs ?? backoffMs(state.strikes)),
            error: err,
            retryAfter: retryAfterMs !== undefined,
          }
          const message =
            err instanceof Error
              ? err.message
              : state.session
                ? 'Failed to refresh token'
                : 'Failed to initialize client'
          log(
            '%s failed: %s',
            state.session ? 'Token refresh' : 'Initialization',
            message,
          )
          setError(message)
          setLoading(false)
          schedule(state, state.hold.until)
          throw err
        }
        if (configRef.current !== state) throw replacedError()

        // An answer naming another API is another configuration (#14), even
        // under the same key: start it afresh, exactly as a `configKey` change
        // would. Its token is NOT taken here, because every map and client of
        // this configuration would pair it with the old URL until the switch
        // lands.
        if (state.session && state.session.apiUrl !== cfg.apiUrl) {
          log('getConfig moved to %s — starting afresh', cfg.apiUrl)
          state.session = null
          setConfig(newConfig(state.key, refs))
          setSession(null)
          setLoading(true)
          setError(null)
          return
        }

        state.token = cfg.token
        state.expiresAt = expiryOf(cfg)
        if (isStale(state)) {
          // Stale on arrival (#35): the server judges this token fresh by its
          // clock, this browser judges it stale by its own. Asking again at
          // once brings the same answer, as fast as `getConfig` can give it,
          // so wait — longer each time it happens again.
          state.strikes += 1
          state.hold = {
            until: Date.now() + backoffMs(state.strikes),
            error: null,
            retryAfter: false,
          }
          log('Token arrived already stale by this clock')
        } else {
          state.strikes = 0
          state.hold = null
        }

        if (!state.session) {
          state.session = build(state, cfg.apiUrl)
          setSession(state.session)
        }
        log(
          'Token refreshed (expires in %ds)',
          Math.floor((state.expiresAt - Date.now()) / 1000),
        )
        setError(null)
        setLoading(false)
        schedule(
          state,
          Math.max(
            state.expiresAt - TOKEN_REFRESH_BUFFER_SECONDS * 1000,
            state.hold?.until ?? 0,
          ),
        )
      })()

      state.attempt = attempt
      // Clears only its own slot: the next configuration has its own.
      const settle = () => {
        if (state.attempt === attempt) state.attempt = null
      }
      attempt.then(settle, settle)
      return attempt
    },
    [build, refs, schedule],
  )

  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  /**
   * The tab or the network coming back.
   *
   * A backgrounded tab has its timers throttled, so the scheduled refresh can
   * be arbitrarily late: refresh on the way back in, before the user touches
   * the map. And a first load that failed gets its retry now, rather than when
   * the backoff comes round (#34).
   */
  useEffect(() => {
    if (typeof document === 'undefined') return
    const retry = () => {
      const state = configRef.current
      if (!state || (state.token && !isStale(state))) return
      log('Back, with no fresh token — asking now')
      void refreshRef.current('user').catch(() => {})
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') retry()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', retry)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', retry)
    }
  }, [])

  // One configuration at a time, installed here and disposed with it.
  useEffect(() => {
    log('Initializing LocationClientProvider')
    configRef.current = config
    void refresh('scheduled').catch(() => {})
    return () => {
      // An answer still in flight finds the configuration gone, and writes
      // nothing; every client and `getToken` of it refuses from now on.
      if (config.timer) clearTimeout(config.timer)
      configRef.current = null
    }
  }, [config, refresh])

  const value = useMemo<LocationClientContextValue>(
    () => ({
      client: session?.client ?? null,
      getToken: config.getToken,
      apiUrl: session?.apiUrl ?? null,
      loading,
      error,
    }),
    [config, session, loading, error],
  )

  return (
    <LocationClientContext.Provider value={value}>
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
