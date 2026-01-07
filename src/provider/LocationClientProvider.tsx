'use client'

import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react'
import type { ReactNode } from 'react'
import { GeoPlacesClient, ClientConfig } from '@chaosity/location-client'
import debug from 'debug'
import { jwtDecode } from 'jwt-decode'

const log = debug('location-client-react:provider')

interface LocationClientContextValue {
  config: ClientConfig | null
  client: GeoPlacesClient | null
  getToken: () => string | undefined
  ensureValidToken: () => Promise<void>
  loading: boolean
  error: string | null
}

const LocationClientContext = createContext<LocationClientContextValue | undefined>(undefined)

export interface LocationClientProviderProps {
  children: ReactNode
  getConfig: () => Promise<ClientConfig & { expiresAt?: number }>
  refreshBuffer?: number // Seconds before expiry to check (default: 60)
}

export function LocationClientProvider({ children, getConfig, refreshBuffer = 60 }: LocationClientProviderProps) {
  const [config, setConfig] = useState<ClientConfig | null>(null)
  const [client, setClient] = useState<GeoPlacesClient | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const tokenRef = useRef<string | undefined>(undefined)
  const expiresAtRef = useRef<number | null>(null)
  const getConfigRef = useRef(getConfig)
  const tokenGenerationCount = useRef(0)

  // Update ref when getConfig changes
  useEffect(() => {
    getConfigRef.current = getConfig
  }, [getConfig])

  // Token getter function (stable reference)
  const getToken = useCallback(() => tokenRef.current, [])

  // Check if token is expired or about to expire
  const isTokenExpired = useCallback(() => {
    if (!expiresAtRef.current) return false
    return Date.now() >= (expiresAtRef.current - refreshBuffer * 1000)
  }, [refreshBuffer])

  // Refresh token if needed
  const ensureValidToken = useCallback(async () => {
    if (!isTokenExpired()) return

    const timeUntilExpiry = expiresAtRef.current ? Math.floor((expiresAtRef.current - Date.now()) / 1000) : 0
    log('Token expired or expiring soon (expires in %ds), refreshing...', timeUntilExpiry)

    tokenGenerationCount.current++

    try {
      const cfg = await getConfigRef.current()
      setConfig(cfg)
      tokenRef.current = cfg.token
      expiresAtRef.current = null
      
      const baseClient = new GeoPlacesClient(cfg)
      const wrappedClient = new Proxy(baseClient, {
        get(target, prop) {
          if (prop === 'send') {
            return async (command: any) => {
              await ensureValidToken()
              return target.send(command)
            }
          }
          return (target as any)[prop]
        }
      }) as GeoPlacesClient
      
      setClient(wrappedClient)
      
      const decoded = jwtDecode<{ exp: number }>(cfg.token)
      expiresAtRef.current = decoded.exp * 1000
      const newExpiry = Math.floor((decoded.exp * 1000 - Date.now()) / 1000)
      log('Token refreshed successfully (new token expires in %ds)', newExpiry)
    } catch (err) {
      log('Token refresh failed: %s', err instanceof Error ? err.message : 'Unknown error')
      setError(err instanceof Error ? err.message : 'Failed to refresh token')
    }
  }, [isTokenExpired])

  // Initial load
  useEffect(() => {
    log('Initializing LocationClientProvider')
    tokenGenerationCount.current++
    getConfig()
      .then((cfg) => {
        setConfig(cfg)
        tokenRef.current = cfg.token
        
        const baseClient = new GeoPlacesClient(cfg)
        const wrappedClient = new Proxy(baseClient, {
          get(target, prop) {
            if (prop === 'send') {
              return async (command: any) => {
                await ensureValidToken()
                return target.send(command)
              }
            }
            return (target as any)[prop]
          }
        }) as GeoPlacesClient
        
        setClient(wrappedClient)
        
        try {
          const decoded = jwtDecode<{ exp: number }>(cfg.token)
          expiresAtRef.current = decoded.exp * 1000
          const expiry = Math.floor((decoded.exp * 1000 - Date.now()) / 1000)
          log('Client initialized (token expires in %ds)', expiry)
        } catch (err) {
          log('Failed to decode token, no expiry info')
        }
        setLoading(false)
      })
      .catch((err) => {
        log('Initialization failed: %s', err instanceof Error ? err.message : 'Unknown error')
        setError(err instanceof Error ? err.message : 'Failed to initialize client')
        setLoading(false)
      })
  }, [ensureValidToken])

  // Check token validity on every state change
  useEffect(() => {
    if (!loading && config) {
      ensureValidToken()
    }
  }, [config, loading, ensureValidToken])

  return (
    <LocationClientContext.Provider value={{ config, client, getToken, ensureValidToken, loading, error }}>
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
