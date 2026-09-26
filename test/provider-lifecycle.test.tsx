import { SuggestCommand } from '@chaosity/location-client'
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { StrictMode, memo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * The provider's failure and boundary paths (#3 / T35), its configuration
 * lifecycle (#14), and a failed first load (#34).
 *
 * The happy path is well covered by token-refresh.test.tsx. What was not: what
 * consumers see when `getConfig` REJECTS, and what happens when the hook is used
 * outside a provider. Both matter more than they look — a provider that swallows
 * an initialization failure leaves the app rendering a permanently empty map
 * with nothing in the console to explain it.
 *
 * Like token-retry-on-401.test.tsx, this file does NOT mock
 * `@chaosity/location-client`. #14's claims are about which token reaches which
 * URL after a configuration change, and the core's own fallbacks (`getToken`,
 * then `token`, then `refreshToken`) are where an old and a new configuration
 * could mix. A fake client would prove only what the fake does, so the real
 * client runs and `fetch` is what gets mocked.
 */

const jwt = (n = 0) =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900, n }))}.s`

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

// What API Gateway itself returns for a token the authorizer rejected.
const unauthorized = () =>
  new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })

const suggest = () => new SuggestCommand({ QueryText: 'flinders street' })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Late = ReturnType<typeof deferred<{ apiUrl: string; token: string }>>

let fetchMock: ReturnType<typeof vi.fn>

/** The URL and bearer of the `i`-th request that reached `fetch`. */
function sent(i: number) {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit]
  const headers = init?.headers as Record<string, string> | undefined
  return { url: String(url), auth: headers?.Authorization }
}

const Show = () => {
  const { loading, error, client } = useLocationClient()
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="error">{error ?? ''}</span>
      <span data-testid="client">{client ? 'ready' : 'none'}</span>
    </div>
  )
}

/** The whole context, as the last render saw it. */
let ctx: ReturnType<typeof useLocationClient>

function Probe() {
  ctx = useLocationClient()
  return null
}

beforeEach(() => {
  fetchMock = vi.fn(async () => ok({ ResultItems: [] }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('when getConfig rejects', () => {
  it('surfaces the message and stops loading', async () => {
    // Not silently: a provider stuck on loading, or loading:false with no error,
    // leaves the app showing an empty map and nothing to explain it.
    render(
      <LocationClientProvider
        getConfig={() => Promise.reject(new Error('no credentials'))}
      >
        <Show />
      </LocationClientProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('no credentials'),
    )
    expect(screen.getByTestId('loading').textContent).toBe('false')
    expect(screen.getByTestId('client').textContent).toBe('none')
  })

  it('copes with a rejection that is not an Error', async () => {
    render(
      <LocationClientProvider getConfig={() => Promise.reject('just a string')}>
        <Show />
      </LocationClientProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'Failed to initialize client',
      ),
    )
  })

  it('does not set state after unmount', async () => {
    // A slow rejection landing after the component is gone is the classic React
    // warning. Unmounting replaces the provider's per-configuration state, and
    // an answer that finds a different state object writes nothing.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let reject: (e: unknown) => void = () => {}
    const { unmount } = render(
      <LocationClientProvider
        getConfig={() => new Promise((_, r) => (reject = r))}
      >
        <Show />
      </LocationClientProvider>,
    )

    unmount()
    reject(new Error('too late'))
    await new Promise((r) => setTimeout(r, 10))

    expect(err.mock.calls.some((c) => String(c[0]).includes('unmounted'))).toBe(
      false,
    )
    err.mockRestore()
  })
})

describe('a failed first load is retried (#34)', () => {
  /**
   * The first `getConfig` used to be the only one: a rejection there set
   * `error`, scheduled nothing, and left `client` null for the rest of the page
   * view. Suggestions, verify and the map stayed dead until a reload.
   */
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  const config = () => ({ apiUrl: 'https://api.test', token: jwt() })

  it('brings the client up without a remount, and clears the error', async () => {
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => config())

    render(
      <LocationClientProvider getConfig={getConfig}>
        <Show />
      </LocationClientProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('offline'),
    )
    expect(screen.getByTestId('client').textContent).toBe('none')

    // Past the backoff's 30 s cap, whatever the jitter drew.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })

    expect(screen.getByTestId('client').textContent).toBe('ready')
    expect(screen.getByTestId('error').textContent).toBe('')
    expect(screen.getByTestId('loading').textContent).toBe('false')
    expect(getConfig).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying when the backoff is not a whole number of milliseconds', async () => {
    // A timer's delay is truncated to whole milliseconds, so the retry fires a
    // fraction early. When the timer consulted the hold it had itself been set
    // by, that fraction was enough to refuse the retry — and nothing re-armed
    // the timer, so the retries stopped for good after the first.
    vi.spyOn(Math, 'random').mockReturnValue(0.6123)
    const getConfig = vi.fn().mockRejectedValue(new Error('down'))
    render(
      <LocationClientProvider getConfig={getConfig}>
        <Show />
      </LocationClientProvider>,
    )
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    // 1224.6 ms, 2449.2 ms, 4898.4 ms, 9796.8 ms: four retries inside 31 s.
    expect(getConfig).toHaveBeenCalledTimes(5)
  })

  it("does not let the old configuration's retry ask the new one", async () => {
    // A's retry timer outlives the switch unless it is cleared, and when it
    // fires it asks for whichever configuration is installed, past any hold:
    // here B's server has asked for 45 s of quiet.
    const getConfig = {
      a: vi.fn().mockRejectedValue(new Error('a down')),
      b: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('slow down'), { retryAfterMs: 45_000 }),
        ),
    }
    function Org({ org }: { org: 'a' | 'b' }) {
      return (
        <LocationClientProvider configKey={org} getConfig={getConfig[org]}>
          <Show />
        </LocationClientProvider>
      )
    }
    const { rerender } = render(<Org org="a" />)
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('a down'),
    )

    rerender(<Org org="b" />)
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('slow down'),
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(getConfig.a).toHaveBeenCalledTimes(1)
    expect(getConfig.b).toHaveBeenCalledTimes(1)
  })

  it('stops retrying once the provider unmounts', async () => {
    const getConfig = vi.fn().mockRejectedValue(new Error('down'))
    const { unmount } = render(
      <LocationClientProvider getConfig={getConfig}>
        <Show />
      </LocationClientProvider>,
    )
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(1))

    // It is retrying — otherwise the assertion below would prove nothing.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })
    const calls = getConfig.mock.calls.length
    expect(calls).toBeGreaterThan(1)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000)
    })
    expect(getConfig).toHaveBeenCalledTimes(calls)
  })

  it.each([
    [
      'the tab comes back',
      () => document.dispatchEvent(new Event('visibilitychange')),
    ],
    ['the network comes back', () => window.dispatchEvent(new Event('online'))],
  ])('retries at once when %s', async (_, fire) => {
    const getConfig = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => config())
    render(
      <LocationClientProvider getConfig={getConfig}>
        <Show />
      </LocationClientProvider>,
    )
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('offline'),
    )

    // No waitFor from here: it lets real time pass, and enough of it would let
    // the backoff's own timer do the retry this test is about.
    await act(async () => {
      fire()
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('client').textContent).toBe('ready')
    expect(screen.getByTestId('error').textContent).toBe('')
  })
})

describe('a configuration switch (#14)', () => {
  /**
   * An organisation or application switch used to change nothing: the init
   * effect ran once per mount, `getConfig` was only a ref, and the client kept
   * the first config's `apiUrl`. The token swapped silently at the next
   * scheduled refresh, up to 14 minutes later, and from then on the new
   * configuration's bearer went to the old configuration's URL.
   */
  type Org = 'a' | 'b'
  const urls: Record<Org, string> = {
    a: 'https://a.test',
    b: 'https://b.test',
  }

  function Switchable({
    org,
    getConfig,
  }: {
    org: Org
    getConfig: Record<Org, () => Promise<{ apiUrl: string; token: string }>>
  }) {
    return (
      <LocationClientProvider configKey={org} getConfig={getConfig[org]}>
        <Probe />
      </LocationClientProvider>
    )
  }

  it('rebuilds the client: send carries the new token to the new apiUrl', async () => {
    const tokens = { a: jwt(1), b: jwt(2) }
    const getConfig = {
      a: async () => ({ apiUrl: urls.a, token: tokens.a }),
      b: async () => ({ apiUrl: urls.b, token: tokens.b }),
    }
    const { rerender } = render(<Switchable org="a" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const first = ctx.client

    rerender(<Switchable org="b" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    // Whatever the provider does with a switch, it has had the time to do it.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      await ctx.client!.send(suggest())
    })

    expect(sent(0).url).toMatch(/^https:\/\/b\.test\//)
    expect(sent(0).auth).toBe(`Bearer ${tokens.b}`)
    expect(ctx.apiUrl).toBe(urls.b)
    expect(ctx.client).not.toBe(first)
  })

  it('drops a refresh the old configuration started', async () => {
    const tokens = { a1: jwt(1), a2: jwt(2), b: jwt(3) }
    const late = deferred<{ apiUrl: string; token: string }>()
    const getConfig = {
      a: vi
        .fn()
        .mockResolvedValueOnce({ apiUrl: urls.a, token: tokens.a1 })
        .mockReturnValueOnce(late.promise),
      b: vi.fn(async () => ({ apiUrl: urls.b, token: tokens.b })),
    }
    const { rerender } = render(<Switchable org="a" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const old = ctx.client!

    // A 401 under A starts a refresh that has not answered by the switch.
    fetchMock.mockResolvedValueOnce(unauthorized())
    const outcome = old.send(suggest()).then(
      () => 'resolved',
      (e: unknown) => e,
    )
    await waitFor(() => expect(getConfig.a).toHaveBeenCalledTimes(2))

    rerender(<Switchable org="b" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.getToken()).toBe(tokens.b))

    // A's refresh answers now, after the switch.
    late.resolve({ apiUrl: urls.a, token: tokens.a2 })
    const settled = await outcome
    expect(settled).toBeInstanceOf(Error)
    expect(String(settled)).toMatch(/replaced/)

    expect(ctx.getToken()).toBe(tokens.b)
    expect(ctx.apiUrl).toBe(urls.b)
    // The old request was not retried, with either configuration's token.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a client kept across the switch refuses, rather than send the new token to its old URL', async () => {
    const tokens = { a: jwt(1), b: jwt(2) }
    const getConfig = {
      a: async () => ({ apiUrl: urls.a, token: tokens.a }),
      b: async () => ({ apiUrl: urls.b, token: tokens.b }),
    }
    const { rerender } = render(<Switchable org="a" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const old = ctx.client!
    // What a map's transformRequest holds on to.
    const oldGetToken = ctx.getToken

    rerender(<Switchable org="b" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.apiUrl).toBe(urls.b))

    // Every member the client has, not the ones this test thought of: the
    // core gains members, and core-surface.test.ts makes the provider forward
    // each one. A request-sending member refuses; the one synchronous read
    // (getAppConfig) finds no token to read.
    const members = Object.entries(old).filter(
      (entry): entry is [string, (...args: unknown[]) => unknown] =>
        typeof entry[1] === 'function',
    )
    expect(members.map(([name]) => name)).toEqual(
      expect.arrayContaining(['send', 'verifyAddress', 'getAppConfig']),
    )
    for (const [name, member] of members) {
      const answer = member.call(old, suggest())
      if (answer instanceof Promise) {
        await expect(answer, name).rejects.toThrow(/replaced/)
      } else {
        expect(answer, name).toEqual({})
      }
    }
    expect(oldGetToken()).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()

    expect(ctx.getToken()).toBe(tokens.b)
  })

  it.each([
    [
      'answers',
      (late: Late) => late.resolve({ apiUrl: urls.a, token: jwt(9) }),
    ],
    ['fails', (late: Late) => late.reject(new Error('old route down'))],
  ])(
    'leaves the new configuration alone when the old one %s late',
    async (_, land) => {
      const late = deferred<{ apiUrl: string; token: string }>()
      const next = deferred<{ apiUrl: string; token: string }>()
      const getConfig = {
        a: vi
          .fn()
          .mockResolvedValueOnce({ apiUrl: urls.a, token: jwt(1) })
          .mockReturnValueOnce(late.promise),
        b: () => next.promise,
      }
      const { rerender } = render(<Switchable org="a" getConfig={getConfig} />)
      await waitFor(() => expect(ctx.client).not.toBeNull())

      fetchMock.mockResolvedValueOnce(unauthorized())
      const outcome = ctx.client!.send(suggest()).catch((e: unknown) => e)
      await waitFor(() => expect(getConfig.a).toHaveBeenCalledTimes(2))

      rerender(<Switchable org="b" getConfig={getConfig} />)
      await act(async () => {
        land(late)
        await outcome
      })

      // B has not answered: nothing A said may mark it loaded, or failed.
      expect(ctx.loading).toBe(true)
      expect(ctx.error).toBeNull()
      expect(ctx.client).toBeNull()

      const tokenB = jwt(2)
      await act(async () => {
        next.resolve({ apiUrl: urls.b, token: tokenB })
      })
      await waitFor(() => expect(ctx.getToken()).toBe(tokenB))
    },
  )

  it('also rebuilds between two applications on the same API', async () => {
    // The common case: one API host, two applications. Only the token tells
    // them apart, so nothing about the answer itself says "new client".
    const tokens = { a: jwt(1), b: jwt(2) }
    const getConfig = {
      a: async () => ({ apiUrl: urls.a, token: tokens.a }),
      b: async () => ({ apiUrl: urls.a, token: tokens.b }),
    }
    const { rerender } = render(<Switchable org="a" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const old = ctx.client!

    rerender(<Switchable org="b" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.getToken()).toBe(tokens.b))
    expect(ctx.client).not.toBeNull()
    expect(ctx.client).not.toBe(old)

    await act(async () => {
      await ctx.client!.send(suggest())
    })
    expect(sent(0).auth).toBe(`Bearer ${tokens.b}`)
    // The application the old client was built for is no longer the one
    // configured, so it may not bill the new one.
    await expect(old.send(suggest())).rejects.toThrow(/replaced/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a client kept after the provider unmounts refuses too', async () => {
    const getConfig = vi.fn(async () => ({ apiUrl: urls.a, token: jwt(1) }))
    const { unmount } = render(
      <LocationClientProvider getConfig={getConfig}>
        <Probe />
      </LocationClientProvider>,
    )
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const old = ctx.client!
    const oldGetToken = ctx.getToken

    unmount()

    await expect(old.send(suggest())).rejects.toThrow(/replaced or unmounted/)
    expect(oldGetToken()).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getConfig).toHaveBeenCalledTimes(1)
  })

  it('a getToken taken before the client exists returns the token once it arrives', async () => {
    // A map built at mount keeps the transformRequest it was built with —
    // react-map-gl hands it to MapLibre's constructor and never replaces it —
    // so the getToken it captured before any token existed has to be the one
    // that later reads it. @chaosity/address-form's Map does exactly this.
    // Across a switch, the same holds for the new configuration.
    const tokens = { a: jwt(1), b: jwt(2) }
    const answers = {
      a: deferred<{ apiUrl: string; token: string }>(),
      b: deferred<{ apiUrl: string; token: string }>(),
    }
    const getConfig = { a: () => answers.a.promise, b: () => answers.b.promise }
    const { rerender } = render(<Switchable org="a" getConfig={getConfig} />)
    const earlyA = ctx.getToken

    await act(async () => {
      answers.a.resolve({ apiUrl: urls.a, token: tokens.a })
    })
    await waitFor(() => expect(ctx.client).not.toBeNull())
    expect(earlyA()).toBe(tokens.a)

    rerender(<Switchable org="b" getConfig={getConfig} />)
    const earlyB = ctx.getToken
    await act(async () => {
      answers.b.resolve({ apiUrl: urls.b, token: tokens.b })
    })
    await waitFor(() => expect(ctx.apiUrl).toBe(urls.b))
    expect(earlyB()).toBe(tokens.b)
    expect(earlyA()).toBeUndefined()
  })

  it('shows no client while the new configuration loads', async () => {
    const pending = deferred<{ apiUrl: string; token: string }>()
    const getConfig = {
      a: async () => ({ apiUrl: urls.a, token: jwt(1) }),
      b: () => pending.promise,
    }
    const { rerender } = render(<Switchable org="a" getConfig={getConfig} />)
    await waitFor(() => expect(ctx.client).not.toBeNull())

    rerender(<Switchable org="b" getConfig={getConfig} />)
    // In the very render that carries the new key, not one render later.
    expect(ctx.client).toBeNull()
    expect(ctx.apiUrl).toBeNull()
    expect(ctx.loading).toBe(true)
    expect(ctx.getToken()).toBeUndefined()

    await act(async () => {
      pending.resolve({ apiUrl: urls.b, token: jwt(2) })
    })
    await waitFor(() => expect(ctx.apiUrl).toBe(urls.b))
    expect(ctx.loading).toBe(false)
  })

  it('a refresh that answers with another apiUrl rebuilds the client', async () => {
    // A getConfig that follows the current organisation on its own, with no
    // configKey: the switch surfaces at its next refresh, and must not pair
    // the new token with the old URL when it does.
    const tokens = { a: jwt(1), b: jwt(2) }
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ apiUrl: urls.a, token: tokens.a })
      .mockResolvedValue({ apiUrl: urls.b, token: tokens.b })
    render(
      <LocationClientProvider getConfig={getConfig}>
        <Probe />
      </LocationClientProvider>,
    )
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const old = ctx.client!

    fetchMock.mockResolvedValueOnce(unauthorized())
    const settled = await old.send(suggest()).then(
      () => 'resolved',
      (e: unknown) => e,
    )
    expect(settled).toBeInstanceOf(Error)
    expect(String(settled)).toMatch(/replaced/)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(ctx.apiUrl).toBe(urls.b))
    await act(async () => {
      await ctx.client!.send(suggest())
    })
    expect(sent(1).url).toMatch(/^https:\/\/b\.test\//)
    expect(sent(1).auth).toBe(`Bearer ${tokens.b}`)
  })

  it('hands consumers the same context value while nothing in it changes', async () => {
    // It used to be a new object on every render, so every consumer re-rendered
    // whenever anything above the provider did.
    let renders = 0
    const Consumer = memo(function Consumer() {
      ctx = useLocationClient()
      renders += 1
      return null
    })
    let bump = () => {}
    function Parent() {
      const [, setN] = useState(0)
      bump = () => setN((n) => n + 1)
      return (
        <LocationClientProvider
          getConfig={async () => ({ apiUrl: urls.a, token: jwt() })}
        >
          <Consumer />
        </LocationClientProvider>
      )
    }

    render(<Parent />)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const before = renders

    act(() => bump())

    expect(renders).toBe(before)
  })
})

describe('when it succeeds', () => {
  it('exposes a client and clears loading', async () => {
    render(
      <LocationClientProvider
        getConfig={async () => ({ apiUrl: 'https://api.test', token: jwt() })}
      >
        <Show />
      </LocationClientProvider>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('client').textContent).toBe('ready'),
    )
    expect(screen.getByTestId('loading').textContent).toBe('false')
    expect(screen.getByTestId('error').textContent).toBe('')
  })
})

describe('under StrictMode', () => {
  it('comes up with one getConfig call and a client that sends', async () => {
    // Next.js runs development under StrictMode, which mounts every effect,
    // disposes it and mounts it again. The second run installs the same
    // configuration the first one did, so the answer already on its way is
    // kept, not thrown away and asked for twice.
    const token = jwt()
    const getConfig = vi.fn(async () => ({ apiUrl: 'https://api.test', token }))
    render(
      <StrictMode>
        <LocationClientProvider getConfig={getConfig}>
          <Probe />
        </LocationClientProvider>
      </StrictMode>,
    )
    await waitFor(() => expect(ctx.client).not.toBeNull())

    await act(async () => {
      await ctx.client!.send(suggest())
    })
    expect(sent(0).auth).toBe(`Bearer ${token}`)
    expect(ctx.getToken()).toBe(token)
    expect(getConfig).toHaveBeenCalledTimes(1)
  })
})

describe('using the hook outside a provider', () => {
  it('throws a message that says what to do', () => {
    // The default failure would be a destructure of undefined, several frames
    // from the actual mistake.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useLocationClient())).toThrow(
      /must be used within LocationClientProvider/,
    )
    err.mockRestore()
  })
})
