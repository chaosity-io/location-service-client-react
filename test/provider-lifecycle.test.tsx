import {
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * The provider's failure and boundary paths (#3 / T35).
 *
 * The happy path is well covered by token-refresh.test.tsx. What was not: what
 * consumers see when `getConfig` REJECTS, and what happens when the hook is used
 * outside a provider. Both matter more than they look — a provider that swallows
 * an initialization failure leaves the app rendering a permanently empty map
 * with nothing in the console to explain it.
 */

vi.mock('@chaosity/location-client', () => ({
  TOKEN_REFRESH_BUFFER_SECONDS: 60,
  readTokenExpiry: () => Date.now() + 900_000,
  GeoPlacesClient: class {
    config = { serviceId: 'Geo Places' }
    constructor(public cfg: unknown) {}
    async send() {
      return { ok: true }
    }
  },
}))

const jwt = () =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 900 }))}.s`

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

afterEach(cleanup)

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
    // warning; mountedRef is what prevents it.
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
