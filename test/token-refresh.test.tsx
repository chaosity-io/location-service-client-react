import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * The map path must survive token expiry (#4).
 *
 * MapLibre's `transformRequest` is synchronous by contract, so `getToken` cannot
 * await a refresh. Refresh used to happen ONLY inside the `send` wrapper — which
 * the map never calls, because it requests tiles, glyphs and sprites directly.
 * So fifteen minutes after load every map request failed, for as long as the page
 * stayed open, and no amount of panning recovered it.
 *
 * Every test below therefore refreshes WITHOUT calling send.
 */

vi.mock('@chaosity/location-client', () => ({
  TOKEN_REFRESH_BUFFER_SECONDS: 60,
  // Mirrors the real implementation: read `exp` out of the JWT.
  readTokenExpiry: (token?: string) => {
    if (!token) return undefined
    try {
      const exp = JSON.parse(atob(token.split('.')[1])).exp
      return typeof exp === 'number' ? exp * 1000 : undefined
    } catch {
      return undefined
    }
  },
  GeoPlacesClient: class {
    config = { serviceId: 'Geo Places' }
    constructor(public cfg: { getToken?: () => string | undefined }) {}
    async send(_c: unknown, _o?: unknown) {
      return { ok: true }
    }
  },
}))

const LIFETIME = 900_000

/**
 * Captures the provider's `getToken` so a test can call it the way MapLibre
 * does — at request time, not at render time. `tokenRef` is a ref on purpose:
 * a refresh must not re-render the whole map tree, so asserting on rendered
 * text would be asserting the wrong thing.
 */
let readToken: () => string | undefined = () => undefined

function TokenProbe() {
  const { getToken, error } = useLocationClient()
  readToken = getToken
  return <span data-testid="error">{error ?? ''}</span>
}

let getConfig: ReturnType<typeof vi.fn>
let issued: number

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  issued = 0
  getConfig = vi.fn(async () => {
    issued += 1
    return {
      apiUrl: 'https://api.test',
      token: `token-${issued}`,
      expiresAt: Date.now() + LIFETIME,
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const renderProvider = () =>
  render(
    <LocationClientProvider getConfig={getConfig}>
      <TokenProbe />
    </LocationClientProvider>,
  )

describe('proactive refresh (the map path)', () => {
  it('refreshes before expiry with no send ever called', async () => {
    renderProvider()
    await waitFor(() => expect(readToken()).toBe('token-1'))
    expect(getConfig).toHaveBeenCalledTimes(1)

    // Walk past the refresh point: expiry minus the 60 s buffer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME - 60_000 + 1_000)
    })

    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2))
    expect(readToken()).toBe('token-2')
  })

  it('keeps refreshing — the map stays alive across several lifetimes', async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    for (let i = 2; i <= 4; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIFETIME - 60_000 + 1_000)
      })
      await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(i))
    }

    expect(readToken()).toBe('token-4')
  })

  it('recovers when a throttled background tab misses its timer', async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    // Simulate a suspended tab: jump past expiry without timers firing.
    vi.setSystemTime(Date.now() + LIFETIME + 60_000)
    expect(getConfig).toHaveBeenCalledTimes(1)

    // The next synchronous read kicks off a refresh even though it cannot await one.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })

    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2))
  })
})

describe('refresh failure is not hidden', () => {
  it('surfaces the error instead of carrying on with a stale token', async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    getConfig.mockRejectedValueOnce(new Error('token endpoint unavailable'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME - 60_000 + 1_000)
    })

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'token endpoint unavailable',
      ),
    )
  })

  it('clears the error once a later refresh succeeds', async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    getConfig.mockRejectedValueOnce(new Error('transient'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME - 60_000 + 1_000)
    })
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('transient'),
    )

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(''),
    )
  })
})

describe('single-flight', () => {
  it('does not fire a second refresh while one is in flight', async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    vi.setSystemTime(Date.now() + LIFETIME + 1_000)

    // Several reads and a visibility change at once must still produce ONE fetch.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })

    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2))
    expect(getConfig).not.toHaveBeenCalledTimes(3)
  })
})

describe('it cannot out-run the server (the 0.2.0 spin)', () => {
  /**
   * 0.2.0 shipped with a settable `refreshBuffer`. A consumer passing 800s
   * against a 900s token judged it stale after 100s — but `getClientConfig` on
   * the server only re-mints within 60s of expiry, so it returned the SAME
   * token, which the client judged stale again, immediately. Roughly 110
   * requests per second from an idle page, observed 2026-08-23.
   *
   * The prop is gone and both sides now apply TOKEN_REFRESH_BUFFER_SECONDS to
   * the token's own `exp`, so they cannot reach different answers.
   */
  it('does not re-ask when the server returns the same still-valid token', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = `h.${btoa(JSON.stringify({ exp }))}.s`
    // Always the same token, as a warm server-side cache would return.
    getConfig = vi.fn(async () => ({ apiUrl: 'https://api.test', token }))

    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    await act(async () => {
      for (let i = 0; i < 50; i++) readToken()
      await vi.advanceTimersByTimeAsync(120_000)
    })

    expect(getConfig).toHaveBeenCalledTimes(1)
  })

  it('takes the expiry from the token, not from what getConfig claims', async () => {
    // A wildly wrong expiresAt must not matter: `exp` wins. Against the old
    // provider this test hangs, because it spun on the bogus value.
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = `h.${btoa(JSON.stringify({ exp }))}.s`
    getConfig = vi.fn(async () => ({
      apiUrl: 'https://api.test',
      token,
      expiresAt: Date.now() - 60_000,
    }))

    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    await act(async () => {
      for (let i = 0; i < 20; i++) readToken()
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(getConfig).toHaveBeenCalledTimes(1)
  })
})
