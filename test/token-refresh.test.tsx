import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocationClient } from '../src/provider/LocationClientProvider'
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
 * does — at request time, not at render time. The token lives on the
 * provider's `ConfigState`, not in React state, on purpose: a refresh must not
 * re-render the whole map tree, so asserting on rendered text would be
 * asserting the wrong thing.
 */
let readToken: () => string | undefined = () => undefined
let client: LocationClient | null = null

function TokenProbe() {
  const ctx = useLocationClient()
  readToken = ctx.getToken
  client = ctx.client
  return <span data-testid="error">{ctx.error ?? ''}</span>
}

let getConfig: ReturnType<typeof vi.fn>
let issued: number

/** A fresh token per call, as a server that mints on every ask would give. */
const issue = async () => {
  issued += 1
  return {
    apiUrl: 'https://api.test',
    token: `token-${issued}`,
    expiresAt: Date.now() + LIFETIME,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  issued = 0
  client = null
  getConfig = vi.fn(issue)
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
    // To the refresh point and no further: a retry follows within 1–2 s now
    // (#36), and would clear the error before it could be read.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIFETIME - 60_000)
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
      await vi.advanceTimersByTimeAsync(LIFETIME - 60_000)
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

/** Where the timer first refreshes: the token's expiry less the 60 s buffer. */
const REFRESH_POINT = LIFETIME - 60_000

/** A JWT whose `exp` is `secondsLeft` from now by this (the browser's) clock. */
const tokenExpiringIn = (secondsLeft: number, n = 0) =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsLeft, n }))}.s`

describe('a failed refresh is paced (#36)', () => {
  /**
   * After one failed refresh the token is past its buffer, so every
   * synchronous `getToken()` read found no refresh in flight and started one.
   * MapLibre reads it for every tile, glyph and sprite, so a map on screen
   * asked the application's token route as fast as that route could fail. An
   * idle page, the opposite: nothing rescheduled, so nothing retried.
   */
  const slowDown = () =>
    Object.assign(new Error('slow down'), { retryAfterMs: 45_000 })

  it('waits out retryAfterMs: 50 reads over the next 45 s ask once, when it has passed', async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    getConfig.mockImplementation(async () => {
      throw slowDown()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_POINT)
    })
    expect(getConfig).toHaveBeenCalledTimes(2)
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('slow down'),
    )

    // A map on screen: 50 reads spread over the next 43 s.
    for (let i = 0; i < 50; i++) {
      await act(async () => {
        readToken()
        await vi.advanceTimersByTimeAsync(860)
      })
    }
    expect(getConfig).toHaveBeenCalledTimes(2)

    getConfig.mockImplementation(issue)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(getConfig).toHaveBeenCalledTimes(3)
    expect(readToken()).toBe('token-2')
  })

  it.each([
    ['whatever the jitter draws', 0],
    ['and grows between attempts', 0.999],
  ])(
    'with no retryAfterMs it backs off, never faster than the base, %s',
    async (_, draw) => {
      vi.spyOn(Math, 'random').mockReturnValue(draw)
      renderProvider()
      await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

      const at: number[] = []
      getConfig.mockImplementation(async () => {
        at.push(Date.now())
        throw new Error('down')
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REFRESH_POINT)
      })

      // A map reading its token four times a second, for three minutes.
      for (let i = 0; i < 4 * 180; i++) {
        await act(async () => {
          readToken()
          await vi.advanceTimersByTimeAsync(250)
        })
      }

      const gaps = at.slice(1).map((t, i) => t - at[i])
      expect(gaps.length).toBeGreaterThan(3)
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1_000)
      if (draw > 0.5) {
        // Doubling each time: about 2 s, 4 s, 8 s, 16 s…
        for (let i = 1; i < 4; i++) {
          expect(gaps[i]).toBeGreaterThan(gaps[i - 1] * 1.9)
        }
        // …until the cap, where it stays.
        expect(Math.max(...gaps)).toBeGreaterThanOrEqual(29_000)
        expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000 + 250)
      }
    },
  )

  it("an idle page still retries, and a success schedules from the new token's expiry", async () => {
    // The lowest draw, so the retry comes exactly at the 1 s base and the
    // next refresh can be timed from it.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    getConfig.mockRejectedValueOnce(new Error('blip'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_POINT)
    })
    expect(getConfig).toHaveBeenCalledTimes(2)

    // No reads at all: the provider's own timer is what retries.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })
    expect(getConfig).toHaveBeenCalledTimes(3)
    expect(readToken()).toBe('token-2')
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(''),
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_POINT - 1_000)
    })
    expect(getConfig).toHaveBeenCalledTimes(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(getConfig).toHaveBeenCalledTimes(4)
  })

  it('a send during the wait goes out with the token in hand while it is before its exp', async () => {
    // The refresh point is 60 s before exp: the token is still one the API
    // accepts, and the map is sending it for every tile. A send refused here
    // while the tiles load would be the two paths disagreeing (Mehdi, 26 Sep).
    renderProvider()
    await waitFor(() => expect(client).not.toBeNull())

    getConfig.mockRejectedValueOnce(new Error('down'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_POINT)
    })
    expect(getConfig).toHaveBeenCalledTimes(2)

    await act(async () => {
      await expect(client!.send({})).resolves.toEqual({ ok: true })
    })
    expect(getConfig).toHaveBeenCalledTimes(2)
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('down'),
    )
  })

  it('past its exp, a send during the wait is refused with that failure, without asking again', async () => {
    renderProvider()
    await waitFor(() => expect(client).not.toBeNull())

    getConfig.mockRejectedValueOnce(
      Object.assign(new Error('slow down'), { retryAfterMs: 120_000 }),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_POINT)
    })
    expect(getConfig).toHaveBeenCalledTimes(2)

    // Past the token's own exp, still inside the server's Retry-After.
    vi.setSystemTime(Date.now() + 61_000)
    await act(async () => {
      await expect(client!.send({})).rejects.toThrow('slow down')
    })
    expect(getConfig).toHaveBeenCalledTimes(2)
  })

  it("a returning tab or network never overrides the server's Retry-After", async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    getConfig.mockRejectedValueOnce(slowDown())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_POINT)
    })
    expect(getConfig).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('online'))
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getConfig).toHaveBeenCalledTimes(2)
  })

  it('a returning network overrides our own backoff, which was only a guess', async () => {
    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    getConfig.mockRejectedValueOnce(new Error('offline'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_POINT)
    })
    expect(getConfig).toHaveBeenCalledTimes(2)

    await act(async () => {
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(getConfig).toHaveBeenCalledTimes(3)
    expect(readToken()).toBe('token-2')
  })
})

describe('a token that arrives already stale (#35)', () => {
  /**
   * The provider judges a token stale at `exp − 60 s` by the BROWSER's clock;
   * the documented server path hands back its cached token until `exp − 60 s`
   * by the SERVER's. With the browser ahead, the token is stale on arrival,
   * the refresh timer computed a delay of 0, and `getConfig` was asked again
   * as soon as it answered — 91 times in 2 s in the ticket's measurement.
   */
  it('a clock 30 s ahead: getConfig is asked a bounded number of times', async () => {
    // What a warm server-side cache returns: the same token, again and again.
    const token = tokenExpiringIn(30)
    getConfig = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { apiUrl: 'https://api.test', token }
    })

    renderProvider()
    // Two seconds, with a map reading its token as it draws.
    for (let i = 0; i < 40; i++) {
      await act(async () => {
        readToken()
        await vi.advanceTimersByTimeAsync(50)
      })
    }

    expect(getConfig.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(getConfig.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('a clock 15 minutes ahead: the rate stays bounded for as long as the tab is open', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    // Every token the server mints is at its exp already, by this clock.
    getConfig = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      issued += 1
      return { apiUrl: 'https://api.test', token: tokenExpiringIn(0, issued) }
    })

    renderProvider()
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))
    // Two minutes to reach the cap, then count ten more, reading every 2 s.
    const tick = async (seconds: number) => {
      for (let i = 0; i < seconds / 2; i++) {
        await act(async () => {
          readToken()
          await vi.advanceTimersByTimeAsync(2_000)
        })
      }
    }
    await tick(120)
    const warm = getConfig.mock.calls.length
    await tick(600)

    // At the cap, with this draw, one ask per 15 s: 40 in ten minutes.
    expect(getConfig.mock.calls.length - warm).toBeLessThanOrEqual(41)
  })

  it('a send in the meantime goes out with the token in hand', async () => {
    // The server handed this token back, so the server still accepts it; only
    // this browser's clock disagrees.
    const token = tokenExpiringIn(30)
    getConfig = vi.fn(async () => ({ apiUrl: 'https://api.test', token }))

    renderProvider()
    await waitFor(() => expect(client).not.toBeNull())
    expect(getConfig).toHaveBeenCalledTimes(1)

    await act(async () => {
      for (let i = 0; i < 5; i++) await client!.send({})
    })
    expect(getConfig).toHaveBeenCalledTimes(1)
  })
})
