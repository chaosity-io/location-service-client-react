'use client'

import { useEffect } from 'react'
import { applyMapLanguage } from '@chaosity/location-client'

/**
 * Minimal interface describing the MapLibre Map methods used by this hook.
 * Using a structural type avoids maplibre-gl version conflicts between packages.
 */
interface MapLike {
  isStyleLoaded(): boolean | void
  on(event: string, listener: (...args: unknown[]) => void): void
  off(event: string, listener: (...args: unknown[]) => void): void
}

/**
 * React hook that keeps map label language in sync with the `language` prop.
 *
 * Registers a persistent `style.load` listener so language is automatically
 * reapplied whenever `map.setStyle()` is called (e.g. style or color scheme change).
 * Also applies immediately if the style is already loaded.
 *
 * @param map - MapLibre Map instance, or null while the map is initializing
 * @param language - ISO 639-1 language code (e.g. 'en', 'fr', 'de', 'ja')
 *
 * @example
 * const [mapInstance, setMapInstance] = useState<maplibregl.Map | null>(null)
 * useMapLanguage(mapInstance, language)
 */
export function useMapLanguage(map: MapLike | null, language: string): void {
  useEffect(() => {
    if (!map) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applyFn = () => applyMapLanguage(map as any, language)

    if (map.isStyleLoaded()) {
      applyFn()
    }

    map.on('style.load', applyFn)

    return () => {
      map.off('style.load', applyFn)
    }
  }, [map, language])
}
