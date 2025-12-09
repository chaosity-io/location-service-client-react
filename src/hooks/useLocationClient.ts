import { useEffect, useState } from 'react'
import { GeoPlacesClient, ClientConfig } from '@chaosity/location-client'

export interface UseLocationClientOptions {
  getConfig: () => Promise<ClientConfig>
}

export function useLocationClient(options: UseLocationClientOptions) {
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [client, setClient] = useState<GeoPlacesClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    options.getConfig()
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

  return { config, client, loading, error }
}
