import {
  fetchMapStyle,
  refreshTokenOnUnauthorized,
} from '@chaosity/location-client'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * The context's `refreshToken` (#47).
 *
 * The core's map helpers recover from a refused token when handed
 * `{ getToken, refreshToken }` (core #72), and `refreshTokenOnUnauthorized`
 * reloads the refused tiles once `getToken` returns a different token. Under
 * the provider only the provider can change what `getToken` returns, and the
 * context offered no way to ask it, so a map stayed broken until a reload.
 *
 * Like getconfig-answer.test.tsx, the real core runs and `fetch` is mocked.
 */

const API = 'https://api.test'

const jwt = (n: number) =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900, n }))}.s`

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const unauthorized = () =>
  new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })

let fetchMock: ReturnType<typeof vi.fn>
let ctx: ReturnType<typeof useLocationClient>

function Probe() {
  ctx = useLocationClient()
  return null
}

const mount = (
  getConfig: (...args: unknown[]) => Promise<unknown>,
  configKey?: string,
) =>
  render(
    <LocationClientProvider
      configKey={configKey}
      getConfig={
        getConfig as Parameters<typeof LocationClientProvider>[0]['getConfig']
      }
    >
      <Probe />
    </LocationClientProvider>,
  )

/** A `getConfig` that hands out a new token on every call. */
const minting = () => {
  const issued: string[] = []
  const getConfig = vi.fn(async () => {
    issued.push(jwt(issued.length + 1))
    return { apiUrl: API, token: issued.at(-1)! }
  })
  return { getConfig, issued }
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the context refreshToken (#47)', () => {
  it('names the token in hand to getConfig, and resolves to the new one', async () => {
    const { getConfig, issued } = minting()
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())

    let got: string | undefined
    await act(async () => {
      got = await ctx.refreshToken()
    })

    expect(getConfig.mock.calls[1]).toEqual([{ refusedToken: issued[0] }])
    expect(got).toBe(issued[1])
    expect(ctx.getToken()).toBe(issued[1])
  })

  it('shares a refresh already in flight', async () => {
    let release!: () => void
    const issued = [jwt(1), jwt(2)]
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ apiUrl: API, token: issued[0] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ apiUrl: API, token: issued[1] })
          }),
      )
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())

    let pending!: Promise<(string | undefined)[]>
    act(() => {
      pending = Promise.all([ctx.refreshToken(), ctx.refreshToken()])
    })
    await waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2))
    let both: (string | undefined)[] = []
    await act(async () => {
      release()
      both = await pending
    })

    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(both).toEqual([issued[1], issued[1]])
  })

  it('is the same function for the life of a configuration', async () => {
    const { getConfig } = minting()
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const first = ctx.refreshToken

    await act(async () => {
      await ctx.refreshToken()
    })

    expect(ctx.refreshToken).toBe(first)
  })

  it('rejects with the refresh’s own error when the refresh fails', async () => {
    const getConfig = vi
      .fn()
      .mockResolvedValueOnce({ apiUrl: API, token: jwt(1) })
      .mockRejectedValueOnce(new Error('token route answered 503'))
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())

    let failure: unknown
    await act(async () => {
      failure = await ctx.refreshToken().catch((err: unknown) => err)
    })

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('token route answered 503')
  })

  it('rejects once its configuration is replaced', async () => {
    const { getConfig } = minting()
    const { rerender } = mount(getConfig, 'org-a')
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const kept = ctx.refreshToken

    rerender(
      <LocationClientProvider
        configKey="org-b"
        getConfig={
          getConfig as Parameters<typeof LocationClientProvider>[0]['getConfig']
        }
      >
        <Probe />
      </LocationClientProvider>,
    )
    await waitFor(() => expect(ctx.refreshToken).not.toBe(kept))

    await expect(kept()).rejects.toThrow('has since replaced or unmounted')
  })
})

describe('with core 0.13.0, a map under the provider recovers (#47, core #72)', () => {
  it('fetchMapStyle retries a refused descriptor with the provider’s new token', async () => {
    const { getConfig, issued } = minting()
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const tokens = { getToken: ctx.getToken, refreshToken: ctx.refreshToken }
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ version: 8, sources: {}, layers: [] }))

    let style: unknown
    await act(async () => {
      style = await fetchMapStyle(API, 'Standard', tokens)
    })

    expect(style).toMatchObject({ version: 8 })
    const auth = fetchMock.mock.calls.map(([, init]) =>
      new Headers((init as RequestInit).headers).get('Authorization'),
    )
    expect(auth).toEqual([`Bearer ${issued[0]}`, `Bearer ${issued[1]}`])
    expect(getConfig.mock.calls[1]).toEqual([{ refusedToken: issued[0] }])
  })

  it('refreshTokenOnUnauthorized reloads a refused tile once the provider has a new token', async () => {
    const { getConfig, issued } = minting()
    mount(getConfig)
    await waitFor(() => expect(ctx.client).not.toBeNull())
    const tokens = { getToken: ctx.getToken, refreshToken: ctx.refreshToken }
    const listeners: ((e: unknown) => void)[] = []
    const map = {
      on: (_: 'error', fn: (e: unknown) => void) => void listeners.push(fn),
      off: vi.fn(),
      refreshTiles: vi.fn(),
    }
    refreshTokenOnUnauthorized(
      map as unknown as Parameters<typeof refreshTokenOnUnauthorized>[0],
      API,
      tokens,
    )

    act(() => {
      listeners.forEach((fn) =>
        fn({
          error: { status: 401, url: `${API}/maps/tiles/vector.basemap/3/6/4` },
          sourceId: 'basemap',
          tile: { tileID: { canonical: { x: 6, y: 4, z: 3 } } },
        }),
      )
    })
    await waitFor(() => expect(map.refreshTiles).toHaveBeenCalled())

    expect(map.refreshTiles).toHaveBeenCalledWith('basemap', [
      { x: 6, y: 4, z: 3 },
    ])
    expect(ctx.getToken()).toBe(issued[1])
    expect(getConfig.mock.calls[1]).toEqual([{ refusedToken: issued[0] }])
  })
})
