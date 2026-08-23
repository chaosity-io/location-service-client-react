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

const renderProvider = (buffer = 60) =>
  render(
    <LocationClientProvider getConfig={getConfig} refreshBuffer={buffer}>
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
