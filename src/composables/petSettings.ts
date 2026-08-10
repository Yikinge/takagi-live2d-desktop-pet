import type { PetSettings } from '../types'

export const SETTINGS_STORAGE_KEY = 'takagi-pet-settings'
export const SETTINGS_VERSION = 3
export const TAKAGI_MODEL_PATH = '/models/takagi/Takagi.model3.json'

export const DEFAULT_SETTINGS: Readonly<PetSettings> = Object.freeze({
  bubbleEnabled: true,
  clickThrough: true,
  sensitivity: 72,
  modelPath: TAKAGI_MODEL_PATH,
  characterScale: 1,
  alwaysOnTop: true,
  interactionPaused: false,
  autostartEnabled: false,
})

interface StoredSettings {
  version: number
  settings: PetSettings
}

export function sanitizePetSettings(value: unknown): PetSettings {
  const candidate = unwrapSettings(value)
  return {
    bubbleEnabled: booleanOr(
      candidate.bubbleEnabled,
      DEFAULT_SETTINGS.bubbleEnabled,
    ),
    clickThrough: booleanOr(
      candidate.clickThrough,
      DEFAULT_SETTINGS.clickThrough,
    ),
    sensitivity: clampNumber(
      candidate.sensitivity,
      30,
      100,
      DEFAULT_SETTINGS.sensitivity,
    ),
    // The runtime contract intentionally has one same-origin model entry.
    // Persisted or legacy remote paths are never accepted.
    modelPath: TAKAGI_MODEL_PATH,
    characterScale: clampNumber(
      candidate.characterScale,
      0.6,
      1.6,
      DEFAULT_SETTINGS.characterScale,
    ),
    alwaysOnTop: booleanOr(
      candidate.alwaysOnTop,
      DEFAULT_SETTINGS.alwaysOnTop,
    ),
    interactionPaused: booleanOr(
      candidate.interactionPaused,
      DEFAULT_SETTINGS.interactionPaused,
    ),
    autostartEnabled: booleanOr(
      candidate.autostartEnabled,
      DEFAULT_SETTINGS.autostartEnabled,
    ),
  }
}

export function loadPetSettings(
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): PetSettings {
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY)
    return raw ? sanitizePetSettings(JSON.parse(raw) as unknown) : {
      ...DEFAULT_SETTINGS,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function savePetSettings(
  settings: PetSettings,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
) {
  const payload: StoredSettings = {
    version: SETTINGS_VERSION,
    settings: sanitizePetSettings(settings),
  }
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Settings persistence is optional. Input events are never stored here.
  }
}

function unwrapSettings(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  if (isRecord(value.settings)) return value.settings
  // Version 1 stored the settings object directly.
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function clampNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, minimum), maximum)
    : fallback
}
