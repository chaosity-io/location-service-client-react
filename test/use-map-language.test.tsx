import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * useMapLanguage was at 0% (#3 / T35).
 *
 * The listener is the whole point of the hook, and it is the part that looks
 * redundant. Applying the language once is not enough: `map.setStyle()` — which
 * every style or colour-scheme switch calls — replaces the layers, so labels
 * revert to their default language. The `style.load` listener is what makes the
 * choice survive that, and nothing about a passing "labels are French" check
 * would notice its absence.
 */

const applyMapLanguage = vi.fn()

vi.mock('@chaosity/location-client', () => ({
  applyMapLanguage: (...args: unknown[]) => applyMapLanguage(...args),
}))

const { useMapLanguage } = await import('../src/hooks/useMapLanguage')

const fakeMap = (styleLoaded = true) => {
  const handlers: Record<string, (() => void)[]> = {}
  return {
    isStyleLoaded: () => styleLoaded,
    on: vi.fn((ev: string, fn: () => void) => {
      ;(handlers[ev] ??= []).push(fn)
    }),
    off: vi.fn((ev: string, fn: () => void) => {
      handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== fn)
    }),
    /** Fire what MapLibre fires after setStyle(). */
    emitStyleLoad: () => (handlers['style.load'] ?? []).forEach((h) => h()),
    listeners: (ev: string) => (handlers[ev] ?? []).length,
  }
}

const Harness = ({ map, language }: { map: unknown; language: string }) => {
  useMapLanguage(map as never, language)
  return null
}

afterEach(() => {
  cleanup()
  applyMapLanguage.mockClear()
})

describe('applying the language', () => {
  it('applies immediately when the style is already loaded', () => {
    const map = fakeMap(true)
    render(<Harness map={map} language="fr" />)
    expect(applyMapLanguage).toHaveBeenCalledWith(map, 'fr')
  })

  it('waits when the style is not loaded yet', () => {
    // Calling into a half-built style is what applyMapLanguage swallows
    // internally; not calling at all is better than relying on that.
    const map = fakeMap(false)
    render(<Harness map={map} language="fr" />)
    expect(applyMapLanguage).not.toHaveBeenCalled()
  })

  it('does nothing at all while the map is still null', () => {
    render(<Harness map={null} language="fr" />)
    expect(applyMapLanguage).not.toHaveBeenCalled()
  })
})

describe('surviving setStyle — the reason the listener exists', () => {
  it('reapplies the language when the style reloads', () => {
    // setStyle() replaces every layer, so labels revert to their default
    // language. Without this listener the choice silently undoes itself the
    // first time someone switches to the dark basemap.
    const map = fakeMap(false)
    render(<Harness map={map} language="ja" />)
    expect(applyMapLanguage).not.toHaveBeenCalled()

    map.emitStyleLoad()

    expect(applyMapLanguage).toHaveBeenCalledWith(map, 'ja')
  })

  it('keeps reapplying across repeated style changes', () => {
    const map = fakeMap(true)
    render(<Harness map={map} language="de" />)

    map.emitStyleLoad()
    map.emitStyleLoad()

    // once on mount, once per style load
    expect(applyMapLanguage).toHaveBeenCalledTimes(3)
  })
})

describe('the listener is cleaned up', () => {
  it('removes it on unmount, so a replaced map does not leak', () => {
    const map = fakeMap(true)
    const { unmount } = render(<Harness map={map} language="fr" />)
    expect(map.listeners('style.load')).toBe(1)

    unmount()

    expect(map.off).toHaveBeenCalled()
    expect(map.listeners('style.load')).toBe(0)
  })

  it('swaps the listener when the language changes', () => {
    const map = fakeMap(true)
    const { rerender } = render(<Harness map={map} language="fr" />)
    rerender(<Harness map={map} language="es" />)

    // Still exactly one listener — the old closure captured 'fr' and would
    // keep reapplying it after every style load.
    expect(map.listeners('style.load')).toBe(1)

    applyMapLanguage.mockClear()
    map.emitStyleLoad()
    expect(applyMapLanguage).toHaveBeenCalledWith(map, 'es')
    expect(applyMapLanguage).not.toHaveBeenCalledWith(map, 'fr')
  })

  it('moves the listener to a new map instance', () => {
    const first = fakeMap(true)
    const second = fakeMap(true)
    const { rerender } = render(<Harness map={first} language="fr" />)

    rerender(<Harness map={second} language="fr" />)

    expect(first.listeners('style.load')).toBe(0)
    expect(second.listeners('style.load')).toBe(1)
  })
})
