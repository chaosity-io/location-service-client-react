import { SuggestCommand } from '@chaosity/location-client'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocationClient } from '../src/provider/LocationClientProvider'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * A token the API stops accepting BEFORE its `exp` (#19).
 *
 * The timer covers expiry. It does not cover revocation from the portal, or a
 * client secret rotated out from under a token still minutes from expiring —
 * there the token looks perfectly fresh to every clock on this side, and every
 * request 401s until the refresh buffer finally comes around.
 *
 * `getToken` cannot fix it: it is synchronous by contract, because MapLibre's
 * `transformRequest` is, so it can only ever hand back the token already in
 * hand. `refreshToken` is the async escape hatch the core added in 0.7.0.
 *
 * These tests deliberately do NOT `vi.mock('@chaosity/location-client')`, which
 * every other file here does. The whole claim under test is that the provider's
 * refresh reaches the core's real 401 handler, and a hand-written fake client
 * would prove only that the fake retries. So the real client runs and `fetch`
 * is what gets mocked — which is also the layer the failure actually arrives at.
 */

const jwt = (n: number) =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900, n }))}.s`

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

// What API Gateway itself returns for a token the authorizer rejected.
const unauthorized = () =>
  new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 })

let fetchMock: ReturnType<typeof vi.fn>
let getConfig: ReturnType<typeof vi.fn>
/** Every token `getConfig` has handed out, in order. */
let issued: string[]
let client: LocationClient | null = null
let readToken: () => string | undefined = () => undefined

function authHeader(call: number): string | undefined {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined
  return (init?.headers as Record<string, string> | undefined)?.Authorization
}

function Probe() {
  const ctx = useLocationClient()
  client = ctx.client
  readToken = ctx.getToken
  return <span data-testid="error">{ctx.error ?? ''}</span>
}

async function mount() {
  render(
    <LocationClientProvider getConfig={getConfig}>
      <Probe />
    </LocationClientProvider>,
  )
  await waitFor(() => expect(client).not.toBeNull())
}

const suggest = () => new SuggestCommand({ QueryText: 'flinders street' })

beforeEach(() => {
  client = null
  issued = []
  getConfig = vi.fn(async () => {
    const token = jwt(issued.length + 1)
    issued.push(token)
    return { apiUrl: 'https://api.test', token }
  })
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a revoked token heals itself', () => {
  it('refreshes and retries once, and the retry carries the new token', async () => {
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ ResultItems: [] }))

    await mount()

    let result: unknown
    await act(async () => {
      result = await client!.send(suggest())
    })

    expect(result).toEqual({ ResultItems: [] })
    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(authHeader(0)).toBe(`Bearer ${issued[0]}`)
    expect(authHeader(1)).toBe(`Bearer ${issued[1]}`)
  })

  it('leaves the new token where the map path will read it', async () => {
    // The refresh has to land in the provider's own ref, not just on the
    // retried request: `getToken` is what MapLibre reads for tiles and glyphs,
    // and it never goes near `send`.
    fetchMock
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ ResultItems: [] }))

    await mount()
    expect(readToken()).toBe(issued[0])

    await act(async () => {
      await client!.send(suggest())
    })

    expect(readToken()).toBe(issued[1])
  })
})

describe('it does not send a doomed request twice', () => {
  it('does not retry when the refresh hands back the same token', async () => {
    // A warm server-side config cache returns the token it already minted. The
    // second attempt would fail identically, and be billed identically.
    const token = jwt(1)
    getConfig = vi.fn(async () => ({ apiUrl: 'https://api.test', token }))
    fetchMock.mockResolvedValue(unauthorized())

    await mount()

    await act(async () => {
      await expect(client!.send(suggest())).rejects.toMatchObject({
        statusCode: 401,
      })
    })

    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('a failed refresh reports itself', () => {
  it('surfaces the refresh error, not the 401 that triggered it', async () => {
    // Deliberate, and the same answer the provider already gives on the
    // pre-flight path: the refresh REJECTS rather than resolving with a stale
    // token, so the consumer is told the token endpoint is down instead of
    // being told the API rejected them.
    fetchMock.mockResolvedValue(unauthorized())
    await mount()
    getConfig.mockRejectedValueOnce(new Error('token endpoint unavailable'))

    await act(async () => {
      await expect(client!.send(suggest())).rejects.toThrow(
        'token endpoint unavailable',
      )
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'token endpoint unavailable',
      ),
    )
  })
})
