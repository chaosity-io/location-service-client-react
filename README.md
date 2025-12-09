# @chaosity/location-client-react

React bindings for [@chaosity/location-client](https://www.npmjs.com/package/@chaosity/location-client) - AWS Location Service compatible client.

## Installation

```bash
npm install @chaosity/location-client-react @chaosity/location-client
```

## Quick Start

```tsx
import { LocationClientProvider, useLocationClient } from '@chaosity/location-client-react'
import { places } from '@chaosity/location-client'

// 1. Wrap your app with the provider
function App() {
  return (
    <LocationClientProvider apiUrl="https://api.example.com" token="your-token">
      <MapComponent />
    </LocationClientProvider>
  )
}

// 2. Use the client in any component
function MapComponent() {
  const client = useLocationClient()
  
  const searchPlaces = async (query: string) => {
    const command = new places.SuggestCommand({
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
<LocationClientProvider 
  apiUrl="https://api.example.com"
  token="your-bearer-token"
>
  {children}
</LocationClientProvider>
```

**Props:**
- `apiUrl` (string, required) - API endpoint URL
- `token` (string, required) - Bearer token for authentication
- `children` (ReactNode, required) - Child components

### useLocationClient

Hook to access the location client in any component.

```tsx
const client = useLocationClient()
```

**Returns:** `GeoPlacesClient` instance

**Throws:** Error if used outside `LocationClientProvider`

## Usage with Server Actions (Next.js)

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

// app/page.tsx (Client-side)
'use client'
import { LocationClientProvider } from '@chaosity/location-client-react'
import { getLocationConfig } from './actions/location'

export default async function Page() {
  const config = await getLocationConfig()
  
  return (
    <LocationClientProvider {...config}>
      <MapComponent />
    </LocationClientProvider>
  )
}
```

## Available Commands

All AWS Location Service commands are available through the client:

```tsx
import { places } from '@chaosity/location-client'

// Autocomplete
new places.SuggestCommand({ QueryText: 'Van', MaxResults: 5 })

// Geocoding
new places.GeocodeCommand({ QueryText: 'Vancouver, BC' })

// Reverse Geocoding
new places.ReverseGeocodeCommand({ QueryPosition: [-123.1207, 49.2827] })

// Place Details
new places.GetPlaceCommand({ PlaceId: 'place-id' })

// Search Nearby
new places.SearchNearbyCommand({ QueryPosition: [-123.1207, 49.2827] })

// Text Search
new places.SearchTextCommand({ QueryText: 'coffee shops' })
```

See [@chaosity/location-client](https://www.npmjs.com/package/@chaosity/location-client) for complete documentation.

## TypeScript Support

Full TypeScript support with types from AWS SDK:

```tsx
import { places } from '@chaosity/location-client'
import type { SuggestCommandOutput } from '@aws-sdk/client-geo-places'

const response: SuggestCommandOutput = await client.send(
  new places.SuggestCommand({ QueryText: 'Vancouver' })
)
```

## License

MIT
