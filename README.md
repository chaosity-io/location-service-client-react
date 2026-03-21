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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
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
import { SuggestCommand, type SuggestCommandOutput } from '@chaosity/location-client'

function SearchComponent() {
  const { client, loading, error } = useLocationClient()

  const searchPlaces = async (query: string) => {
    if (!client) return
    const response: SuggestCommandOutput = await client.send(
      new SuggestCommand({ QueryText: query, MaxResults: 5 }),
    )
    return response.ResultItems
  }

  if (loading) return <div>Loading...</div>
  if (error) return <div>Error: {error}</div>

  return <div>...</div>
}
```

## Map Utilities

### useMapLanguage

React hook that keeps map label language in sync. Automatically reapplies after `map.setStyle()` calls (e.g. when switching color schemes or terrain).

```tsx
import { useMapLanguage } from '@chaosity/location-client-react'

function MapComponent() {
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null)
  const [language, setLanguage] = useState('en')

  // Keeps labels in sync — zero API calls for language changes
  useMapLanguage(mapInstance, language)

  useEffect(() => {
    const map = new maplibregl.Map({
      /* ... */
    })
    map.once('load', () => setMapInstance(map))
    return () => map.remove()
  }, [])

  return (
    <>
      <select value={language} onChange={(e) => setLanguage(e.target.value)}>
        <option value="en">English</option>
        <option value="fr">Français</option>
        <option value="de">Deutsch</option>
        <option value="ja">日本語</option>
      </select>
      <div ref={mapContainer} />
    </>
  )
}
```

## API Reference

### LocationClientProvider

Provides the location client and automatic token refresh to all child components.

```tsx
<LocationClientProvider getConfig={getLocationConfig} refreshBuffer={60}>
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

import { useEffect, useRef, useState } from 'react'
import {
  useLocationClient,
  useMapLanguage,
} from '@chaosity/location-client-react'
import {
  GeoPlaces,
  fetchMapStyle,
  createTransformRequest,
} from '@chaosity/location-client'
import maplibregl from 'maplibre-gl'
import MaplibreGeocoder from '@maplibre/maplibre-gl-geocoder'

const API_URL = process.env.NEXT_PUBLIC_LOCATION_API_URL!

export default function MapComponent() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null)
  const [language, setLanguage] = useState('en')
  const { client, getToken, loading, error } = useLocationClient()

  // Keeps map labels in sync with language — reapplies after every setStyle() call
  useMapLanguage(mapInstance, language)

  useEffect(() => {
    if (!mapContainer.current || map.current || loading || !client) return
    ;(async () => {
      // Fetch style with terrain, 3D buildings, and language baked into the descriptor
      const style = await fetchMapStyle(API_URL, 'Standard', getToken, {
        colorScheme: 'Light',
        terrain: 'Terrain3D',
        buildings: 'Buildings3D',
        language,
      })

      const instance = new maplibregl.Map({
        container: mapContainer.current!,
        style,
        center: [-123.12, 49.28],
        zoom: 10,
        maxPitch: 85,
        transformRequest: createTransformRequest(API_URL, getToken),
      })

      instance.addControl(
        new maplibregl.NavigationControl({ visualizePitch: true }),
        'top-right',
      )
      instance.addControl(
        new maplibregl.TerrainControl({ source: 'amazon' }),
        'top-right',
      )

      const geoPlaces = new GeoPlaces(client, instance)
      const geocoder = new MaplibreGeocoder(geoPlaces, {
        maplibregl,
        showResultsWhileTyping: true,
        limit: 30,
      })
      instance.addControl(geocoder, 'top-left')

      map.current = instance
      setMapInstance(instance)
    })()

    return () => {
      if (map.current) {
        map.current.remove()
        map.current = null
        setMapInstance(null)
      }
    }
  }, [client, getToken, loading])

  if (error) return <div>Error: {error}</div>
  if (loading) return <div>Loading map...</div>

  return <div ref={mapContainer} style={{ width: '100%', height: '600px' }} />
}
```

### useMapLanguage

Hook that keeps map labels in the specified language. Registers a persistent `style.load` listener so language is automatically reapplied after `map.setStyle()` calls.

```tsx
useMapLanguage(map: MapLike | null, language: string): void
```

**Parameters:**

- `map` — MapLibre Map instance, or `null` while the map is initializing.
- `language` — ISO 639-1 language code (e.g. `'en'`, `'fr'`, `'de'`, `'ja'`, `'zh'`, `'ar'`).

## Available Commands

All AWS Location Service commands are available through the client:

```tsx
import {
  SuggestCommand,
  type SuggestCommandOutput,
  GeocodeCommand,
  ReverseGeocodeCommand,
  GetPlaceCommand,
  SearchTextCommand,
  SearchNearbyCommand,
} from '@chaosity/location-client'

function MyComponent() {
  const { client } = useLocationClient()

  const search = async () => {
    const response: SuggestCommandOutput = await client!.send(
      new SuggestCommand({ QueryText: 'Vancouver', MaxResults: 5 }),
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
import { SuggestCommand, type SuggestCommandOutput } from '@chaosity/location-client'

const { client } = useLocationClient()
const response: SuggestCommandOutput = await client!.send(
  new SuggestCommand({ QueryText: 'Vancouver' }),
)
```

## License

MIT
