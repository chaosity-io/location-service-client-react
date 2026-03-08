# @chaosity/location-client-react

React bindings for [@chaosity/location-client](https://www.npmjs.com/package/@chaosity/location-client) with automatic token refresh.

## Installation

```bash
npm install @chaosity/location-client-react @chaosity/location-client
```

## Quick Start

### 1. Create a Server Action to fetch config

```typescript
// app/actions/location.ts
'use server'

import { getClientConfig } from '@chaosity/location-client/server'

export async function getLocationConfig() {
  // Auto-reads LOCATION_API_URL, LOCATION_CLIENT_ID, LOCATION_CLIENT_SECRET
  return await getClientConfig()
}
```

### 2. Wrap your app with the provider

```tsx
// app/layout.tsx
'use client'

import { LocationClientProvider } from '@chaosity/location-client-react'
import { getLocationConfig } from './actions/location'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <LocationClientProvider getConfig={getLocationConfig}>
      {children}
    </LocationClientProvider>
  )
}
```

### 3. Use the client in any component

```tsx
import { useLocationClient } from '@chaosity/location-client-react'
import { SuggestCommand } from '@chaosity/location-client'

function SearchComponent() {
  const { client, loading, error } = useLocationClient()

  const searchPlaces = async (query: string) => {
    if (!client) return
    const response = await client.send(
      new SuggestCommand({ QueryText: query, MaxResults: 5 })
    )
    return response.ResultItems
  }

  if (loading) return <div>Loading...</div>
  if (error) return <div>Error: {error}</div>

  return <div>...</div>
}
```

## API Reference

### LocationClientProvider

Provides the location client and automatic token refresh to all child components.

```tsx
<LocationClientProvider
  getConfig={getLocationConfig}
  refreshBuffer={60}
>
  {children}
</LocationClientProvider>
```

**Props:**
- `getConfig` — Async function that returns `{ apiUrl: string, token: string, expiresAt?: number }`. Called on init and whenever the token needs refreshing.
- `refreshBuffer` (optional, default: `60`) — Seconds before token expiry to proactively refresh. Prevents mid-request expiration.
- `children` — Child components.

### useLocationClient

Hook to access the location client in any component.

```tsx
const { client, getToken, loading, error } = useLocationClient()
```

**Returns:**
- `client` (`GeoPlacesClient | null`) — The location client instance. Automatically refreshes the token before each `send()` call if needed.
- `getToken` (`() => string | undefined`) — Returns the current token. Useful for direct API calls (e.g., map style fetch).
- `loading` (`boolean`) — Whether the client is initializing.
- `error` (`string | null`) — Error message if initialization or token refresh failed.

**Throws:** Error if used outside `LocationClientProvider`.

## Token Refresh

The provider automatically handles token lifecycle:

1. Fetches an initial token via `getConfig` on mount
2. Before each `client.send()` call, checks if the token is expired or within the `refreshBuffer` window
3. If expired, calls `getConfig` again to get a fresh token
4. Concurrent refresh requests are deduplicated — multiple `send()` calls wait for the same refresh

No manual token management needed. The `client` always uses a valid token.

## Complete Example with MapLibre

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { useLocationClient } from '@chaosity/location-client-react'
import { GeoPlaces, createTransformRequest } from '@chaosity/location-client'
import maplibregl from 'maplibre-gl'
import MaplibreGeocoder from '@maplibre/maplibre-gl-geocoder'

const API_URL = process.env.NEXT_PUBLIC_LOCATION_API_URL!

export default function MapComponent() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const { client, getToken, loading, error } = useLocationClient()

  useEffect(() => {
    if (!mapContainer.current || map.current || loading || !client) return

    const token = getToken()
    if (!token) return

    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: `${API_URL}/maps/Standard/descriptor`,
      center: [-123.12, 49.28],
      zoom: 10,
      transformRequest: createTransformRequest(API_URL, getToken),
    })

    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right')

    // GeoPlaces adapter takes the client instance (not raw apiUrl/token)
    const geoPlaces = new GeoPlaces(client, mapInstance)
    const geocoder = new MaplibreGeocoder(geoPlaces, {
      maplibregl,
      showResultsWhileTyping: true,
      limit: 30,
    })
    mapInstance.addControl(geocoder, 'top-left')

    // The geocoder resolves places internally via searchByPlaceId.
    // The 'result' event fires with the resolved place feature.
    geocoder.on('result', (event: any) => {
      console.log('Selected place:', event.result)
    })

    map.current = mapInstance

    return () => {
      if (map.current) {
        map.current.remove()
        map.current = null
      }
    }
  }, [client, getToken, loading])

  if (error) return <div>Error: {error}</div>
  if (loading) return <div>Loading map...</div>

  return <div ref={mapContainer} style={{ width: '100%', height: '600px' }} />
}
```

## Available Commands

All AWS Location Service commands are available through the client:

```tsx
import {
  SuggestCommand,
  GeocodeCommand,
  ReverseGeocodeCommand,
  GetPlaceCommand,
  SearchTextCommand,
  SearchNearbyCommand,
} from '@chaosity/location-client'

function MyComponent() {
  const { client } = useLocationClient()

  const search = async () => {
    const response = await client!.send(
      new SuggestCommand({ QueryText: 'Vancouver', MaxResults: 5 })
    )
    return response.ResultItems
  }
}
```

## Logging

Enable debug logging with the `DEBUG` environment variable:

```bash
DEBUG=location-client-react:* npm run dev
```

## TypeScript Support

Full TypeScript support with types from AWS SDK:

```tsx
import type { SuggestCommandOutput } from '@aws-sdk/client-geo-places'

const { client } = useLocationClient()
const response: SuggestCommandOutput = await client!.send(
  new SuggestCommand({ QueryText: 'Vancouver' })
)
```

## License

MIT
