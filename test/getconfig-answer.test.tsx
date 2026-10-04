import { SuggestCommand } from '@chaosity/location-client'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * What `getConfig` is told, and what the provider accepts from it.
 *
 * #43: after a 401 the provider asked `getConfig` again with nothing, and the
 * documented server action returns `getClientConfig()`, which hands back the
 * one token it caches per application: the token the API had just refused.
 * The same token means no retry, so the page stayed broken until the server's
 * cache came round on its own (583 s, measured). The provider now names the
 * refused token, so the server can replace exactly that one.
 *
 * #39: an answer without a `token` or an `apiUrl` (a token route's error body
 * passed through `res.json()`) was installed as a configuration. It is now a
 * failure like a rejection: the same hold, the same backoff, and an `error`
 * that names the missing field.
 *
 * Like token-retry-on-401.test.tsx, the real core runs and `fetch` is mocked.
 */

const jwt = (n: number) =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900, n }))}.s`

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const unauthorized = () =>
  new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })

const suggest = () => new SuggestCommand({ QueryText: 'flinders street' })

let fetchMock: ReturnType<typeof vi.fn>
let ctx: ReturnType<typeof useLocationClient>

function Probe() {
  ctx = useLocationClient()
  return (
    <div>
      <span data-testid="error">{ctx.error ?? ''}</span>
      <span data-testid="client">{ctx.client ? 'ready' : 'none'}</span>
      <span data-testid="loading">{String(ctx.loading)}</span>
    </div>
  )
}

const mount = (getConfig: (...args: unknown[]) => Promise<unknown>) =>
  render(
    <LocationClientProvider
      getConfig={
        getConfig as Parameters<typeof LocationClientProvider>[0]['getConfig']
      }
    >
      <Probe />
    </LocationClientProvider>,
  )

const authOf = (call: number) =>
  (
    (fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.headers as
      Record<string, string> | undefined
  )?.Authorization

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('after a 401, getConfig is told which token was refused (#43)', () => {
  it('passes { refusedToken } with the token the API refused', async () => {
    const issued: string[] = []
    const getConfig = vi.fn(async () => {
      issued.push(jwt(issued.length + 1))
      return { apiUrl: 'https://api.test', token: issued.at(-1)! }
    })
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ ResultItems: [] }))
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())

    await act(async () => {
      await ctx.client!.send(suggest())
    })

    expect(getConfig.mock.calls[0]).toEqual([])
    expect(getConfig.mock.calls[1]).toEqual([{ refusedToken: issued[0] }])
  })

  it('recovers from a server that caches, by replacing only the refused token', async () => {
    // The documented server action: `getClientConfig()` caches one token, and
    // `forceRefresh` is asked for only when the cached one was refused.
    let minted = 0
    let cached = jwt(++minted)
    const getConfig = vi.fn(async (request?: { refusedToken?: string }) => {
      if (request?.refusedToken === cached) cached = jwt(++minted)
      return { apiUrl: 'https://api.test', token: cached }
    })
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ ResultItems: [] }))
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const refused = cached

    let result: unknown
    await act(async () => {
      result = await ctx.client!.send(suggest())
    })

    expect(result).toEqual({ ResultItems: [] })
    expect(authOf(0)).toBe(`Bearer ${refused}`)
    expect(authOf(1)).toBe(`Bearer ${cached}`)
    expect(cached).not.toBe(refused)
  })

  it('names no token on a refresh the API did not ask for', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const getConfig = vi.fn(async () => ({
      apiUrl: 'https://api.test',
      token: jwt(getConfig.mock.calls.length),
    }))
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())

    // Past the scheduled refresh: 60 s before a 900 s token's exp.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(845_000)
    })

    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(getConfig.mock.calls[1]).toEqual([])
  })
})

describe('an answer without a token or an apiUrl is a failure (#39)', () => {
  it('names the missing token, and builds no client', async () => {
    mount(async () => ({ error: 'token route failed' }))

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'getConfig resolved without a token',
      ),
    )
    expect(screen.getByTestId('client').textContent).toBe('none')
    expect(screen.getByTestId('loading').textContent).toBe('false')
  })

  it('names the missing apiUrl', async () => {
    mount(async () => ({ token: jwt(1) }))

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'getConfig resolved without an apiUrl',
      ),
    )
    expect(screen.getByTestId('client').textContent).toBe('none')
  })

  it('is retried after the backoff, and comes up when the answer is whole', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ error: 'token route failed' })
      .mockImplementation(async () => ({
        apiUrl: 'https://api.test',
        token: jwt(2),
      }))
    mount(getConfig)
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'getConfig resolved without a token',
      ),
    )

    // Past the backoff's 30 s cap, whatever the jitter drew.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000)
    })

    expect(screen.getByTestId('client').textContent).toBe('ready')
    expect(screen.getByTestId('error').textContent).toBe('')
    expect(getConfig).toHaveBeenCalledTimes(2)
  })

  it('keeps the token in hand when a later answer has none', async () => {
    const good = jwt(1)
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ apiUrl: 'https://api.test', token: good })
      .mockResolvedValue({ error: 'token route failed' })
    fetchMock.mockResolvedValue(unauthorized())
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())

    await act(async () => {
      await expect(ctx.client!.send(suggest())).rejects.toThrow(
        'getConfig resolved without a token',
      )
    })

    expect(ctx.getToken()).toBe(good)
    expect(ctx.apiUrl).toBe('https://api.test')
  })
})
