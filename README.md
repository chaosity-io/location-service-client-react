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
import {
  SuggestCommand,
  type SuggestCommandOutput,
} from '@chaosity/location-client'

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
    const map = new maplibregl.Map({/* ... */})
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
<LocationClientProvider getConfig={getLocationConfig}>
  {children}
</LocationClientProvider>
```

**Props:**

- `getConfig` — Async function that returns `{ apiUrl: string, token: string, expiresAt?: number }`. Called on init and whenever the token needs refreshing.
- `children` — Child components.

There is no `refreshBuffer` prop. It was removed in `0.3.0` — a value shorter
than the server's own re-mint window made the client judge a token stale that
the server would not yet replace, and the two spun against each other. Both
sides now apply the same buffer to the token's own `exp`. Passing it does
nothing.

### useLocationClient

Hook to access the location client in any component.

```tsx
const { client, getToken, loading, error } = useLocationClient()
```

**Returns:**

- `client` (`LocationClient | null`) — The location client. Not a bare `GeoPlacesClient`: the provider wraps it so `send()` refreshes the token first when it needs to, and retries once if the API rejects it.
- `getToken` (`() => string | undefined`) — Returns the current token. Useful for direct API calls (e.g., map style fetch).
- `loading` (`boolean`) — Whether the client is initializing.
- `error` (`string | null`) — Error message if initialization or token refresh failed.

**Throws:** Error if used outside `LocationClientProvider`.

## Token Refresh

The provider owns the token lifecycle. There is nothing to manage manually.

1. `getConfig` is called on mount for the initial token.
2. A timer refreshes **ahead of expiry**, 60 seconds before the token's own
   `exp`. This is what keeps a map alive: MapLibre requests tiles, glyphs and
   sprites directly, never through `send()`, so a refresh that happened only
   inside `send()` would never fire for them.
3. `send()` checks too, and refreshes first if the token is inside that window.
4. Returning to a backgrounded tab refreshes immediately — a throttled tab's
   timer can be arbitrarily late.
5. If the API rejects a token **before** its `exp` — revoked from the portal, or
   minted against a client secret since rotated — the 401 triggers a refresh and
   the request is retried once with the new token. Nothing on this side has any
   other reason to replace that token, so without this the failures continue
   until the timer next comes around: for a token with 14 minutes left, 14
   minutes of a broken page. Needs `@chaosity/location-client` 0.7.0 or later;
   on older versions the other five steps still work.
6. Concurrent refreshes are deduplicated — everything waiting shares one call to
   `getConfig`.

A refresh that fails is reported as `error` from `useLocationClient()`, and
rejects the `send()` that triggered it — with the refresh error rather than a
401, so the cause reads as the token endpoint being unreachable and not as the
API refusing you.

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
import {
  SuggestCommand,
  type SuggestCommandOutput,
} from '@chaosity/location-client'

const { client } = useLocationClient()
const response: SuggestCommandOutput = await client!.send(
  new SuggestCommand({ QueryText: 'Vancouver' }),
)
```

## License

MIT
