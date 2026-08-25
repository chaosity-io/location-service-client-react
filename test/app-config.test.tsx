import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LocationClientProvider,
  useLocationClient,
} from '../src/provider/LocationClientProvider'

/**
 * An application's own config reaches React consumers (api#65).
 *
 * The provider hands out a hand-built `LocationClient` rather than the real
 * `GeoPlacesClient`, so anything the client gains has to be forwarded
 * deliberately or it is simply unreachable from React. `getAppConfig` was
 * exactly that gap: the claim shipped in @chaosity/location-client 0.3.0 and
 * no React app could read it.
 *
 * What it is FOR: showing an application its own settings — a country
 * selector listing the markets it serves, a settings label. What it is NOT
 * for: shaping requests. The token is a snapshot and the API reads the scope
 * fresh per call, so injecting a stale `countries` turns a request that would
 * have succeeded into a 400.
 */

const CLAIMS = { biasDecimals: 5, countries: ['AU', 'NZ'] }
const getAppConfig = vi.fn(() => CLAIMS)

vi.mock('@chaosity/location-client', () => ({
  TOKEN_REFRESH_BUFFER_SECONDS: 60,
  readTokenExpiry: () => Date.now() + 15 * 60 * 1000,
  GeoPlacesClient: class {
    config = { serviceId: 'Geo Places' }
    constructor(public cfg: unknown) {}
    async send() {
      return { ok: true }
    }
    getAppConfig() {
      return getAppConfig()
    }
  },
}))

afterEach(() => {
  cleanup()
  getAppConfig.mockClear()
})

function Show() {
  const { client } = useLocationClient()
  if (!client) return <span>loading</span>
  const cfg = client.getAppConfig()
  return (
    <span data-testid="cfg">
      {cfg.biasDecimals}|{(cfg.countries ?? []).join(',')}
    </span>
  )
}

const renderWithProvider = () =>
  render(
    <LocationClientProvider
      getConfig={async () => ({
        apiUrl: 'https://example.invalid',
        token: 'a.b.c',
      })}
    >
      <Show />
    </LocationClientProvider>,
  )

describe('getAppConfig reaches React consumers', () => {
  it('forwards the claims through the provider wrapper', async () => {
    renderWithProvider()
    await waitFor(() =>
      expect(screen.getByTestId('cfg').textContent).toBe('5|AU,NZ'),
    )
  })

  it('reads from the underlying client rather than a copy', async () => {
    // The provider wraps the client to refresh tokens; a snapshot taken at
    // construction would go stale the first time the token rotated.
    renderWithProvider()
    await waitFor(() => expect(getAppConfig).toHaveBeenCalled())
  })

  it('is synchronous, because it renders', async () => {
    // Callers put this straight into JSX. Returning a promise would force
    // every consumer into an effect for what is display data.
    renderWithProvider()
    await waitFor(() => expect(screen.getByTestId('cfg')).toBeDefined())
    expect(screen.getByTestId('cfg').textContent).not.toContain('[object')
  })
})
