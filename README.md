# @chaosity/location-client-react

React bindings for [@chaosity/location-client](https://www.npmjs.com/package/@chaosity/location-client) - AWS Location Service compatible client.

## Installation

```bash
npm install @chaosity/location-client-react @chaosity/location-client
```

## Quick Start

```tsx
import { LocationClientProvider, useLocationClient } from '@chaosity/location-client-react'
import { SuggestCommand } from '@chaosity/location-client'

// 1. Wrap your app with the provider
function App() {
  return (
    <LocationClientProvider getConfig={getLocationConfig}>
      <MapComponent />
    </LocationClientProvider>
  )
}

// 2. Use the client in any component
function MapComponent() {
  const { client, config, loading, error } = useLocationClient()
  
  const searchPlaces = async (query: string) => {
    if (!client) return
    
    const command = new SuggestCommand({
      QueryText: query,
      MaxResults: 5
    })
    const response = await client.send(command)
    return response.ResultItems
  }
  
  return <div>...</div>
}
```

## API Reference

### LocationClientProvider

Provides the location client to all child components.

```tsx
<LocationClientProvider getConfig={getLocationConfig}>
  {children}
</LocationClientProvider>
```

**Props:**
- `getConfig` (function, required) - Async function that returns `{ apiUrl: string, token: string }`
- `children` (ReactNode, required) - Child components

### useLocationClient

Hook to access the location client in any component.

```tsx
const { client, config, loading, error } = useLocationClient()
```

**Returns:**
- `client` (GeoPlacesClient | null) - The location client instance
- `config` (ClientConfig | null) - The client configuration (apiUrl, token)
- `loading` (boolean) - Whether the client is initializing
- `error` (string | null) - Error message if initialization failed

**Throws:** Error if used outside `LocationClientProvider`

## Usage with Next.js Server Actions

```tsx
// app/actions/location.ts (Server-side)
'use server'

export async function getLocationConfig() {
  const response = await fetch('https://api.example.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.LOCATION_CLIENT_ID!,
      client_secret: process.env.LOCATION_CLIENT_SECRET!
    })
  })
  
  const data = await response.json()
  return {
    apiUrl: 'https://api.example.com',
    token: data.access_token
  }
}

// app/layout.tsx (Client-side)
'use client'

import { LocationClientProvider } from '@chaosity/location-client-react'
import { getLocationConfig } from './actions/location'

export default function RootLayout({ children }) {
  return (
    <LocationClientProvider getConfig={getLocationConfig}>
      {children}
    </LocationClientProvider>
  )
}
```

## Complete Example with MapLibre

```tsx
'use client'

import { useLocationClient } from '@chaosity/location-client-react'
import { GeoPlaces } from '@chaosity/location-client'
import maplibregl from 'maplibre-gl'
import MaplibreGeocoder from '@maplibre/maplibre-gl-geocoder'
import { useEffect, useRef } from 'react'

export default function MapComponent() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const { config, client, loading, error } = useLocationClient()

  useEffect(() => {
    if (!mapContainer.current || map.current || loading || !config || !client) return

    // Initialize map
    const mapInstance = new maplibregl.Map({
      container: mapContainer.current,
      style: `${config.apiUrl}/maps/Standard/descriptor`,
      center: [-123.12, 49.28],
      zoom: 10,
      transformRequest: (url) => {
        if (url.startsWith(config.apiUrl)) {
          return {
            url,
            headers: { 'Authorization': `Bearer ${config.token}` }
          }
        }
        return { url }
      }
    })

    // Add navigation controls
    mapInstance.addControl(new maplibregl.NavigationControl(), 'top-right')

    // Add geocoder
    const geoPlaces = new GeoPlaces(config.apiUrl, config.token, mapInstance)
    const geocoder = new MaplibreGeocoder(geoPlaces, {
      maplibregl,
      showResultsWhileTyping: true,
      limit: 30
    })
    mapInstance.addControl(geocoder, 'top-left')

    // Handle result selection
    geocoder.on('result', async (event) => {
      const { id, result_type } = event.result
      if (result_type === 'Place') {
        const details = await geoPlaces.searchByPlaceId(id)
        console.log('Place details:', details)
      }
    })

    map.current = mapInstance

    return () => {
      if (map.current) {
        map.current.remove()
        map.current = null
      }
    }
  }, [config, client, loading])

  if (error) {
    return <div>Error: {error}</div>
  }

  if (loading) {
    return <div>Loading map...</div>
  }

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
  SearchNearbyCommand
} from '@chaosity/location-client'

function MyComponent() {
  const { client } = useLocationClient()

  const searchPlaces = async () => {
    const response = await client.send(
      new SuggestCommand({ QueryText: 'Vancouver', MaxResults: 5 })
    )
    return response.ResultItems
  }
}
```

## TypeScript Support

Full TypeScript support with types from AWS SDK:

```tsx
import type { SuggestCommandOutput } from '@aws-sdk/client-geo-places'

const { client } = useLocationClient()

const response: SuggestCommandOutput = await client.send(
  new SuggestCommand({ QueryText: 'Vancouver' })
)
```

## Security Best Practices

⚠️ **NEVER expose client credentials in browser code!**

- The `getConfig` function should call a server-side API or Server Action
- Store `client_id` and `client_secret` in server environment variables only
- Only the JWT token should be sent to the browser
- Tokens should be short-lived and refreshed as needed

## License

MIT
