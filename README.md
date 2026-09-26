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
      new SuggestCommand({
        QueryText: query,
        MaxResults: 5,
        // Suggest takes exactly one of BiasPosition, Filter.BoundingBox or Filter.Circle.
        BiasPosition: [-123.1207, 49.2827],
      }),
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

React hook that keeps map label language in sync. Automatically reapplies after `map.setStyle()` calls (e.g. when switching color schemes).

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

- `getConfig` — Async function that returns `{ apiUrl: string, token: string, expiresAt?: number }`. Called on mount, whenever the token needs refreshing, and to retry a call that failed (see [Token Refresh](#token-refresh)).
- `configKey` — Optional. What `getConfig` answers for, such as an organisation or application id. When it changes, the provider drops the old client, token and `apiUrl`, calls `getConfig` again and hands out a new client, without remounting its children.
- `children` — Child components.

There is no `refreshBuffer` prop. It was removed in `0.3.0` — a value shorter
than the server's own re-mint window made the client judge a token stale that
the server would not yet replace, and the two spun against each other. Both
sides now apply the same buffer to the token's own `exp`. Passing it does
nothing.

#### Switching organisation or application

Either of these is correct:

```tsx
// Keeps the children mounted: only the client is replaced.
<LocationClientProvider configKey={orgId} getConfig={getLocationConfig}>

// Remounts everything below the provider, and its state with it.
<LocationClientProvider key={orgId} getConfig={getLocationConfig}>
```

Without either, the provider goes on using the old configuration until its
next token refresh, up to 14 minutes later. A new `getConfig` function is not
a signal on its own, because it is usually a new function on every render.

After a switch, a client or `getToken` kept from before it refuses: `send()`
and `verifyAddress()` reject, `getToken()` returns `undefined`, and
`getAppConfig()` answers `{}`. So one configuration's token never reaches
another's URL. Build anything that holds
on to them, such as a MapLibre map or a geocoder, from the context's current
values, and rebuild it when `client`, `getToken` or `apiUrl` changes, as the
[complete example](#complete-example-with-maplibre) does. The same happens
without a `configKey` when `getConfig` starts answering with a different
`apiUrl`.

### useLocationClient

Hook to access the location client in any component.

```tsx
const { client, getToken, apiUrl, loading, error } = useLocationClient()
```

**Returns:**

- `client` (`LocationClient | null`) — The location client. Not a bare `GeoPlacesClient`: the provider wraps it so `send()` and `verifyAddress()` refresh the token first when they need to, and retry once if the API rejects it.
- `getToken` (`() => string | undefined`) — Returns the current token, for requests the client does not make itself, such as a map's style, tiles and glyphs. It is available before the first token arrives and stays the same function afterwards, so a map built early reads the token once it lands. It returns `undefined` once `configKey` changes.
- `apiUrl` (`string | null`) — The API `client` talks to, from the same `getConfig` answer as the token. Build map URLs from it rather than restating the URL. `null` until a configuration has loaded.
- `loading` (`boolean`) — Whether the client is initializing. `true` again while a new `configKey` loads.
- `error` (`string | null`) — Error message if initialization or a token refresh failed. The provider keeps retrying, and `error` returns to `null` on the first success (see [Token Refresh](#token-refresh)).

**Throws:** Error if used outside `LocationClientProvider`.

## Token Refresh

The provider owns the token lifecycle. There is nothing to manage manually.

1. `getConfig` is called on mount for the initial token.
2. A timer refreshes **ahead of expiry**, 60 seconds before the token's own
   `exp`. This is what keeps a map alive: MapLibre requests tiles, glyphs and
   sprites directly, never through `send()`, so a refresh that happened only
   inside `send()` would never fire for them.
3. `send()` and `verifyAddress()` check too, and refresh first if the token is
   inside that window.
4. Returning to a backgrounded tab refreshes immediately — a throttled tab's
   timer can be arbitrarily late.
5. If the API rejects a token **before** its `exp` — revoked from the portal, or
   minted against a client secret since rotated — the 401 triggers a refresh and
   the request is retried once with the new token. Nothing on this side has any
   other reason to replace that token, so without this the failures continue
   until the timer next comes around: for a token with 14 minutes left, 14
   minutes of a broken page. The core added this in 0.7.0, so every core this
   package's peer range admits has it.
6. Concurrent refreshes are deduplicated — everything waiting shares one call to
   `getConfig`.
7. A failed `getConfig` is retried on the provider's own timer, backing off
   exponentially from 1 to 30 seconds, with jitter. When `getConfig` rejects
   with an error that has `retryAfterMs` (milliseconds), it waits that long
   instead. Until then nothing else asks, neither a map reading its token for
   every tile nor a `send()`. The tab coming back into view, or the browser
   coming back online, retries at once, unless the wait was a `retryAfterMs`.

   A Server Action, as in the Quick Start, cannot pass `retryAfterMs` on:
   React sends a thrown error to the browser without its own fields. To honour
   a token route's `Retry-After`, call the route from the browser and throw it
   there:

   ```ts
   async function getConfig() {
     const res = await fetch('/api/location-token')
     if (!res.ok) {
       const retryAfter = Number(res.headers.get('retry-after'))
       throw Object.assign(new Error(`token route answered ${res.status}`), {
         retryAfterMs: retryAfter > 0 ? retryAfter * 1000 : undefined,
       })
     }
     return res.json()
   }
   ```

8. That includes the first call. A page whose first `getConfig` fails gets its
   client when a retry succeeds, without a reload.
9. A token that arrives already stale by the browser's clock, because that
   clock runs ahead of the server's, is not asked for again at once: the
   server would hand back the same one. The provider waits, longer each time,
   and sends with the token it has. A 401 still replaces it straight away.

A refresh that fails is reported as `error` from `useLocationClient()` until a
retry succeeds. Meanwhile every request goes out with the token in hand for as
long as that token is before its own expiry: `send()`, `verifyAddress()` and a
map's tiles alike, because the API still accepts it. Once it has expired,
`send()` and `verifyAddress()` reject with the refresh error rather than a 401,
so the cause reads as the token endpoint being unreachable, not as the API
refusing you. A token the API refuses (a 401) is never sent again: that
request rejects with the refresh error too.

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

export default function MapComponent() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)
  const [language, setLanguage] = useState('en')
  const { client, getToken, apiUrl, loading, error } = useLocationClient()

  // Keeps map labels in sync with language — reapplies after every setStyle() call
  useMapLanguage(mapInstance, language)

  useEffect(() => {
    if (!mapContainer.current || map.current || loading || !client || !apiUrl)
      return
    ;(async () => {
      // Fetch the style with the language baked into the descriptor. The URL
      // comes from the context with the token, so the two always belong together.
      const style = await fetchMapStyle(apiUrl, 'Standard', getToken, {
        colorScheme: 'Light',
        language,
      })

      const instance = new maplibregl.Map({
        container: mapContainer.current!,
        style,
        center: [-123.12, 49.28],
        zoom: 10,
        transformRequest: createTransformRequest(apiUrl, getToken),
      })
      // Held at once, so the catch and the cleanup below can remove it
      map.current = instance

      instance.addControl(
        new maplibregl.NavigationControl({ visualizePitch: true }),
        'top-right',
      )

      const geoPlaces = new GeoPlaces(client, instance)
      const geocoder = new MaplibreGeocoder(geoPlaces, {
        maplibregl,
        showResultsWhileTyping: true,
        limit: 30,
      })
      instance.addControl(geocoder, 'top-left')

      setMapInstance(instance)
    })().catch((err: unknown) => {
      // A refused style request lands here, and its message says why — for
      // an option outside the application's plan, it names the feature.
      // Anything that failed after the map was built removes it too.
      map.current?.remove()
      map.current = null
      setMapError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      if (map.current) {
        map.current.remove()
        map.current = null
        setMapInstance(null)
      }
    }
  }, [client, getToken, apiUrl, loading])

  if (error) return <div>Error: {error}</div>
  if (mapError) return <div>Map unavailable: {mapError}</div>
  if (loading) return <div>Loading map...</div>

  return <div ref={mapContainer} style={{ width: '100%', height: '600px' }} />
}
```

Some map options are features of the application's plan, and a plan without
one refuses the style request with 403 `FeatureNotEntitledException`, which the
`catch` above puts on screen. 3D terrain and buildings need the `terrain` and `buildings` plan features:

```tsx
const style = await fetchMapStyle(apiUrl, 'Standard', getToken, {
  colorScheme: 'Light',
  terrain: 'Terrain3D',
  buildings: 'Buildings3D',
  language,
})

// …then `maxPitch: 85` on the map, and a control to toggle the terrain. The
// descriptor names its own elevation source, so read it rather than typing it:
instance.addControl(
  new maplibregl.TerrainControl({ source: style.terrain!.source }),
  'top-right',
)
```

`@chaosity/location-client`'s README lists every plan feature and what asks
for it.

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
      new SuggestCommand({
        QueryText: 'Vancouver',
        MaxResults: 5,
        // Suggest takes exactly one of BiasPosition, Filter.BoundingBox or Filter.Circle.
        BiasPosition: [-123.1207, 49.2827],
      }),
    )
    return response.ResultItems
  }
}
```

## Verifying an address

`POST /address/verify` resolves the PlaceId a person chose — a building, or a
unit from its `SecondaryAddresses` — to the full place record plus `verified`.
It is the one Places result you may store; the core package's README has the
whole flow. **Needs `@chaosity/location-client` 0.10.0 or later**, which is this
package's peer range from the release that adds `verifyAddress`.

```tsx
import { useLocationClient } from '@chaosity/location-client-react'

function useVerifyOnSubmit() {
  const { client } = useLocationClient()

  // Call it from the submit handler, once per chosen PlaceId.
  return async (placeId: string) => {
    const answer = await client!.verifyAddress(placeId)
    return answer.verified ? answer : undefined // `answer` is what you may keep
  }
}
```

The same request as a command, through `send`:

```tsx
import {
  VerifyAddressCommand,
  type VerifyAddressResponse,
} from '@chaosity/location-client'

const answer: VerifyAddressResponse = await client!.send(
  new VerifyAddressCommand({ PlaceId: placeId }),
)
```

Either form goes through the provider's pre-send refresh and its 401 retry,
exactly as `send` does. A `verified: false` resolves; it is not an error.

**Every verify is billed, whether or not the address verifies.** That is why
there is no `useVerifyAddress` hook. A hook keyed on a PlaceId would call on
every pick, including picks nobody submits, so the call belongs in your submit
handler instead. Keeping one answer per PlaceId is up to you: a verify result
may be stored, so keep it for as long as your form lives.

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
  new SuggestCommand({
    QueryText: 'Vancouver',
    // Suggest takes exactly one of BiasPosition, Filter.BoundingBox or Filter.Circle.
    BiasPosition: [-123.1207, 49.2827],
  }),
)
```

## License

MIT
