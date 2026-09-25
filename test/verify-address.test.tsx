import { VerifyAddressCommand } from '@chaosity/location-client'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LocationClient,
  SendOptions,
} from '../src/provider/LocationClientProvider'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * Address verification through the provider (#26).
 *
 * `POST /address/verify` is the one Places result an integrator may store, and
 * the core reaches it two ways: `send(new VerifyAddressCommand({ PlaceId }))`
 * and `verifyAddress(placeId)`. Both have to go through the provider's
 * pre-send refresh, or a verify made after the token went stale is sent with
 * the stale token.
 *
 * Like token-retry-on-401.test.tsx, this does NOT mock the core: the claim is
 * about what reaches the wire, so the real client runs and `fetch` is mocked.
 * Only `Date` is faked. Moving it past the refresh point leaves the scheduled
 * refresh timer unfired, so the one thing that can put a new token on the
 * request is the refresh the provider's wrapper awaits before it sends.
 */

const LIFETIME_S = 900
const PLACE_ID = 'AQAAAHQAexample-unit-place-id'

const jwt = (n: number) =>
  `h.${btoa(
    JSON.stringify({ exp: Math.floor(Date.now() / 1000) + LIFETIME_S, n }),
  )}.s`

const UNIT = {
  PlaceId: PLACE_ID,
  PlaceType: 'SecondaryAddress',
  Title: '1/100 Example St',
  verified: true,
}

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

let fetchMock: ReturnType<typeof vi.fn>
let getConfig: ReturnType<typeof vi.fn>
let issued: string[]
let client: LocationClient | null = null

function Probe() {
  client = useLocationClient().client
  return null
}

async function mount() {
  render(
    <LocationClientProvider getConfig={getConfig}>
      <Probe />
    </LocationClientProvider>,
  )
  await waitFor(() => expect(client).not.toBeNull())
}

/** Past the refresh point (exp minus the 60 s buffer), timers untouched. */
const letTheTokenGoStale = () =>
  vi.setSystemTime(Date.now() + (LIFETIME_S - 30) * 1000)

const request = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit]
  return {
    url,
    body: init.body,
    auth: (init.headers as Record<string, string>).Authorization,
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  client = null
  issued = []
  getConfig = vi.fn(async () => {
    const token = jwt(issued.length + 1)
    issued.push(token)
    return { apiUrl: 'https://api.test', token }
  })
  fetchMock = vi.fn().mockImplementation(async () => answer(UNIT))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe.each([
  [
    'client.verifyAddress(placeId)',
    (c: LocationClient, o?: SendOptions) => c.verifyAddress(PLACE_ID, o),
  ],
  [
    'client.send(new VerifyAddressCommand({ PlaceId }))',
    (c: LocationClient, o?: SendOptions) =>
      c.send(new VerifyAddressCommand({ PlaceId: PLACE_ID }), o),
  ],
])('%s', (_form, verify) => {
  it('passes its options through to the core', async () => {
    // An already-aborted signal is refused before any request is sent, so it
    // reaches the core only if the provider forwards `options`. This file's
    // own history: the provider's `send` once dropped its second argument.
    await mount()
    const controller = new AbortController()
    controller.abort()

    await act(async () => {
      await expect(
        verify(client!, { signal: controller.signal, retry: false }),
      ).rejects.toMatchObject({ code: 'AbortedException' })
    })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes a stale token first, then verifies with the new one', async () => {
    await mount()
    letTheTokenGoStale()

    let result: unknown
    await act(async () => {
      result = await verify(client!)
    })

    expect(getConfig).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const sent = request(0)
    expect(sent.url).toBe('https://api.test/address/verify')
    expect(sent.auth).toBe(`Bearer ${issued[1]}`)
    expect(sent.body).toBe(JSON.stringify({ PlaceId: PLACE_ID }))
    expect(result).toEqual(UNIT)
  })

  it('rejects with the refresh error when the refresh fails, and sends nothing', async () => {
    await mount()
    letTheTokenGoStale()
    getConfig.mockRejectedValueOnce(new Error('token endpoint unavailable'))

    await act(async () => {
      await expect(verify(client!)).rejects.toThrow(
        'token endpoint unavailable',
      )
    })

    // Not a 401 from the API: the stale token was never sent.
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('heals a revoked token: refresh, and one retry', async () => {
    fetchMock
      .mockResolvedValueOnce(answer({ message: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(answer(UNIT))
    await mount()

    await act(async () => {
      await verify(client!)
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(request(0).auth).toBe(`Bearer ${issued[0]}`)
    expect(request(1).auth).toBe(`Bearer ${issued[1]}`)
  })

  it('resolves verified: false — a "no" is an answer', async () => {
    const locality = { PlaceType: 'Locality', verified: false }
    fetchMock.mockResolvedValue(answer(locality))
    await mount()

    let result: unknown
    await act(async () => {
      result = await verify(client!)
    })

    expect(result).toEqual(locality)
  })
})
