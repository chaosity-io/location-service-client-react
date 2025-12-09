# @chaosity/location-client

AWS Location Service compatible client with custom authentication.

## Built on AWS Official Libraries

This client uses:
- [`@aws/amazon-location-client`](https://github.com/aws-geospatial/amazon-location-client-js) - AWS Location Client with all commands
- [`@aws/amazon-location-utilities-datatypes`](https://github.com/aws-geospatial/amazon-location-utilities-datatypes-js) - Data type conversions (GeoJSON, etc.)

## Key Difference from AWS SDK

**Only difference**: Authentication method
- AWS SDK: Uses AWS SigV4 (IAM credentials)
- This client: Uses Bearer token (OAuth2)

**Everything else is identical**:
- Same command classes from AWS Location Client
- Same request/response types
- Same data type conversions

## Installation

```bash
npm install @chaosity/location-client
```

## Usage

### Basic Client

```typescript
import { GeoPlacesClient, places } from '@chaosity/location-client'

const client = new GeoPlacesClient({
  apiUrl: 'https://api.example.com',
  token: 'your-bearer-token'
})

// Use AWS Location Client commands
const command = new places.SuggestCommand({
  QueryText: 'Vancouver',
  MaxResults: 5
})

const response = await client.send(command)
```

### MapLibre Integration

```typescript
import { GeoPlacesClient, GeoPlaces, placeToFeatureCollection } from '@chaosity/location-client'
import maplibregl from 'maplibre-gl'

const map = new maplibregl.Map({ /* ... */ })
const client = new GeoPlacesClient({ apiUrl, token })
const geoPlaces = new GeoPlaces(client, map)

// Use with MapLibre Geocoder
const results = await geoPlaces.forwardGeocode({ query: 'Vancouver' })

// Or use AWS utilities directly for data conversion
const featureCollection = placeToFeatureCollection(response)
```

## Available Commands

All commands from AWS Location Client:
- `places.AutocompleteCommand`
- `places.GeocodeCommand`
- `places.GetPlaceCommand`
- `places.ReverseGeocodeCommand`
- `places.SearchNearbyCommand`
- `places.SearchTextCommand`
- `places.SuggestCommand`
- `maps.*` - All Maps commands
- `routes.*` - All Routes commands

## Data Type Utilities

All utilities from `@aws/amazon-location-utilities-datatypes`:
- `placeToFeatureCollection` - Convert places to GeoJSON
- `routeToFeatureCollection` - Convert routes to GeoJSON
- `devicePositionsToFeatureCollection` - Convert device positions to GeoJSON
- `geofencesToFeatureCollection` - Convert geofences to GeoJSON
- `featureCollectionToGeofence` - Convert GeoJSON to geofences

Refer to [AWS Location Client docs](https://github.com/aws-geospatial/amazon-location-client-js) and [Data Types docs](https://github.com/aws-geospatial/amazon-location-utilities-datatypes-js) for complete documentation.

## ⚠️ Security Notice

**NEVER expose `client_id` and `client_secret` in browser code!**

- `TokenProvider` is for **server-side use only** (Next.js Server Actions, API routes, backend services)
- Client credentials must be stored in environment variables on the server
- Browser code should only receive the JWT token from your backend

## Installation

```bash
npm install @chaosity/location-client maplibre-gl
```

## Quick Start

### Recommended: Server Action (Next.js)

```typescript
// lib/actions/location-auth.ts (Server-side only)
'use server'

export async function getLocationToken() {
  const response = await fetch('https://api.locationservice.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.LOCATION_CLIENT_ID!,
      client_secret: process.env.LOCATION_CLIENT_SECRET!
    })
  })
  
  const data = await response.json()
  return { token: data.access_token, apiUrl: 'https://api.locationservice.com' }
}

// components/Map.tsx (Client-side)
'use client'
import { GeoPlaces } from '@chaosity/location-client'
import { getLocationToken } from '@/lib/actions/location-auth'

const { token, apiUrl } = await getLocationToken()
const geoPlaces = new GeoPlaces(apiUrl, token)

// Use with MapLibre Geocoder
const geocoder = new MaplibreGeocoder(geoPlaces, { maplibregl })
map.addControl(geocoder)
```

### Alternative: Using AuthClient (Server-side only)

```typescript
// lib/actions/location-auth.ts (Server-side only)
'use server'
import { AuthClient } from '@chaosity/location-client'

export async function getLocationToken() {
  const authClient = new AuthClient()
  const tokenResponse = await authClient.fetchToken({
    client_id: process.env.LOCATION_CLIENT_ID!,
    client_secret: process.env.LOCATION_CLIENT_SECRET!
  })
  
  return { token: tokenResponse.access_token, apiUrl: 'https://api.locationservice.com' }
}
```

## API Reference

### AuthHelper

Manages authentication tokens.

```typescript
const authHelper = new AuthHelper(token: string, apiUrl: string)
authHelper.setToken(newToken: string)
authHelper.getToken(): string
authHelper.getClientConfig(): ClientConfig
```

### AuthClient

⚠️ **SERVER-SIDE ONLY** - Never use in browser code!

Fetches tokens using OAuth2 client credentials flow.

```typescript
const authClient = new AuthClient(authEndpoint?: string)
const tokenResponse = await authClient.fetchToken({
  client_id: string,
  client_secret: string
})
// Returns: { access_token, token_type, expires_in }
```

### GeoPlacesClient

Executes commands against the API.

```typescript
const client = new GeoPlacesClient(config: ClientConfig)
await client.send(command: Command)
```

### GeoPlaces

MapLibre Geocoder adapter (browser-safe).

```typescript
const geoPlaces = new GeoPlaces(apiUrl: string, token: string)
await geoPlaces.forwardGeocode(config)
await geoPlaces.reverseGeocode(config)
await geoPlaces.getSuggestions(config)
await geoPlaces.searchByPlaceId(placeId)
```

## Commands

### Places Commands

- `SearchTextCommand` - Search for places by text
- `SuggestCommand` - Get autocomplete suggestions
- `ReverseGeocodeCommand` - Get place from coordinates
- `SearchNearbyCommand` - Search nearby places
- `GetPlaceCommand` - Get place details by ID

## License

MIT
