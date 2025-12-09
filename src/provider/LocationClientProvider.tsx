import React, { createContext, useContext, useEffect, useState } from 'react'
import { GeoPlacesClient, ClientConfig } from '@chaosity/location-client'

interface LocationClientContextValue {
  config: ClientConfig | null
  client: GeoPlacesClient | null
  loading: boolean
  error: string | null
}

const LocationClientContext = createContext<LocationClientContextValue | undefined>(undefined)

export interface LocationClientProviderProps {
  children: React.ReactNode
  getConfig: () => Promise<ClientConfig>
}

export function LocationClientProvider({ children, getConfig }: LocationClientProviderProps) {
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [client, setClient] = useState<GeoPlacesClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        setConfig(cfg)
        setClient(new GeoPlacesClient(cfg))
        setLoading(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to initialize client')
        setLoading(false)
      })
  }, [])

  return (
    <LocationClientContext.Provider value={{ config, client, loading, error }}>
      {children}
    </LocationClientContext.Provider>
  )
}

export function useLocationClient() {
  const context = useContext(LocationClientContext)
  if (context === undefined) {
    throw new Error('useLocationClient must be used within LocationClientProvider')
  }
  return context
}
