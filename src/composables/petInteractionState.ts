import type {
  InputCadence,
  KeyboardHandTarget,
  KeyboardInputEvent,
  KeyboardZone,
  MouseButton,
  MouseButtonInputEvent,
  MouseHandTarget,
  MouseMoveInputEvent,
  MouseWheelInputEvent,
} from '../types'

const PARAMETER_EPSILON = 0.001

export const KEYBOARD_WATCHDOG_MS = 8_000
export const MOUSE_BUTTON_WATCHDOG_MS = 8_000

export const KEYBOARD_ZONE_VALUES: Readonly<Record<KeyboardZone, number>> = {
  left: -1,
  center: 0,
  right: 1,
  space: 0,
  enter: 1,
  backspace: 1,
  other: 0,
}

export const CADENCE_STRENGTH: Readonly<Record<InputCadence, number>> = {
  slow: 0.48,
  normal: 0.66,
  fast: 0.84,
  burst: 1,
}

export interface HeldMouseButtons {
  left: boolean
  right: boolean
  other: boolean
}

export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}

export function clampSignedUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, -1), 1)
}

export function normalizeAxis(value: number): -1 | 0 | 1 {
  if (value > 0) return 1
  if (value < 0) return -1
  return 0
}

export function keyboardZoneValue(zone: KeyboardZone): number {
  return KEYBOARD_ZONE_VALUES[zone]
}

export function cadenceStrength(cadence: InputCadence): number {
  return CADENCE_STRENGTH[cadence]
}

export function isInputStale(
  lastSeenAt: number,
  now: number,
  timeoutMs: number,
): boolean {
  return Number.isFinite(lastSeenAt)
    && Number.isFinite(now)
    && now - lastSeenAt >= Math.max(timeoutMs, 0)
}

export function createKeyboardHandTarget(): KeyboardHandTarget {
  return {
    owner: 'screen_left_hand',
    zone: 'center',
    zoneValue: 0,
    keyX: 0,
    keyY: 0.49,
    press: 0,
    spacePress: 0,
    enterPress: 0,
    backspacePress: 0,
    pulse: 0,
    cadence: 'normal',
    active: false,
    revision: 0,
  }
}

export function createMouseHandTarget(): MouseHandTarget {
  return {
    owner: 'screen_right_hand',
    x: 0,
    y: 0,
    gazeX: 0,
    gazeY: 0,
    leftClick: 0,
    rightClick: 0,
    otherClick: 0,
    wheel: 0,
    pulse: 0,
    active: false,
    revision: 0,
  }
}

/**
 * Pure keyboard reducer. Repeated presses intentionally increment `revision`
 * even when zone and state are unchanged, so fast same-zone input is visible
 * to a parameter driver.
 */
export function applyKeyboardPress(
  current: KeyboardHandTarget,
  event: KeyboardInputEvent,
): KeyboardHandTarget {
  const strength = cadenceStrength(event.cadence)
  return {
    ...current,
    zone: event.zone,
    zoneValue: keyboardZoneValue(event.zone),
    keyX: clampSignedUnit(event.keyX),
    keyY: clampUnit(event.keyY),
    press: strength,
    spacePress: event.zone === 'space' ? 1 : current.spacePress,
    enterPress: event.zone === 'enter' ? 1 : current.enterPress,
    backspacePress: event.zone === 'backspace' ? 1 : current.backspacePress,
    pulse: Math.max(current.pulse, strength),
    cadence: event.cadence,
    active: true,
    revision: current.revision + 1,
  }
}

export function applyKeyboardRelease(
  current: KeyboardHandTarget,
  fallback?: {
    zone: KeyboardZone
    keyX: number
    keyY: number
    cadence: InputCadence
  },
): KeyboardHandTarget {
  return {
    ...current,
    zone: fallback?.zone ?? current.zone,
    zoneValue: fallback
      ? keyboardZoneValue(fallback.zone)
      : current.zoneValue,
    keyX: fallback ? clampSignedUnit(fallback.keyX) : current.keyX,
    keyY: fallback ? clampUnit(fallback.keyY) : current.keyY,
    press: fallback ? cadenceStrength(fallback.cadence) : current.press,
    cadence: fallback?.cadence ?? current.cadence,
    active: Boolean(fallback),
    revision: current.revision + 1,
  }
}

export function applyMouseMove(
  current: MouseHandTarget,
  event: MouseMoveInputEvent,
): MouseHandTarget {
  const speed = clampUnit(event.speed)
  const hasButtonImpulse = current.leftClick > PARAMETER_EPSILON
    || current.rightClick > PARAMETER_EPSILON
    || current.otherClick > PARAMETER_EPSILON
  const hasGaze = event.gazeX !== undefined && event.gazeY !== undefined
  return {
    ...current,
    x: normalizeAxis(event.x) * speed,
    y: normalizeAxis(event.y) * speed,
    gazeX: hasGaze ? clampSignedUnit(event.gazeX ?? 0) : current.gazeX,
    gazeY: hasGaze ? clampSignedUnit(event.gazeY ?? 0) : current.gazeY,
    pulse: Math.max(current.pulse, speed),
    active: speed > 0 || hasButtonImpulse,
    revision: current.revision + 1,
  }
}

export function applyMouseButton(
  current: MouseHandTarget,
  event: MouseButtonInputEvent,
  active: boolean,
): MouseHandTarget {
  const value = event.state === 'pressed' ? 1 : current[mouseButtonField(event.button)]
  return {
    ...current,
    [mouseButtonField(event.button)]: value,
    pulse: event.state === 'pressed' ? 1 : current.pulse,
    active,
    revision: current.revision + 1,
  }
}

export function applyMouseWheel(
  current: MouseHandTarget,
  event: MouseWheelInputEvent,
): MouseHandTarget {
  const intensity = clampUnit(event.intensity)
  const hasButtonImpulse = current.leftClick > PARAMETER_EPSILON
    || current.rightClick > PARAMETER_EPSILON
    || current.otherClick > PARAMETER_EPSILON
  return {
    ...current,
    wheel: (event.direction === 'up' ? 1 : -1) * intensity,
    pulse: Math.max(current.pulse, intensity),
    active: intensity > 0 || hasButtonImpulse,
    revision: current.revision + 1,
  }
}

export function decayToZero(
  value: number,
  elapsedMs: number,
  timeConstantMs: number,
): number {
  if (Math.abs(value) <= PARAMETER_EPSILON) return 0
  const elapsed = Math.max(0, elapsedMs)
  const next = value * Math.exp(-elapsed / timeConstantMs)
  return Math.abs(next) <= PARAMETER_EPSILON ? 0 : next
}

export function stepKeyboardHandTarget(
  current: KeyboardHandTarget,
  elapsedMs: number,
  held?: {
    zone: KeyboardZone
    keyX: number
    keyY: number
    cadence: InputCadence
  },
): KeyboardHandTarget {
  return {
    ...current,
    zone: held?.zone ?? current.zone,
    zoneValue: held ? keyboardZoneValue(held.zone) : current.zoneValue,
    keyX: held ? clampSignedUnit(held.keyX) : current.keyX,
    keyY: held ? clampUnit(held.keyY) : current.keyY,
    press: held
      ? cadenceStrength(held.cadence)
      : decayToZero(current.press, elapsedMs, 85),
    spacePress: held?.zone === 'space'
      ? 1
      : decayToZero(current.spacePress, elapsedMs, 105),
    enterPress: held?.zone === 'enter'
      ? 1
      : decayToZero(current.enterPress, elapsedMs, 140),
    backspacePress: held?.zone === 'backspace'
      ? 1
      : decayToZero(current.backspacePress, elapsedMs, 125),
    pulse: decayToZero(current.pulse, elapsedMs, 90),
    cadence: held?.cadence ?? current.cadence,
    active: Boolean(held),
  }
}

export function stepMouseHandTarget(
  current: MouseHandTarget,
  elapsedMs: number,
  held: HeldMouseButtons,
): MouseHandTarget {
  const buttonsActive = held.left || held.right || held.other
  return {
    ...current,
    x: decayToZero(current.x, elapsedMs, 115),
    y: decayToZero(current.y, elapsedMs, 115),
    leftClick: held.left
      ? 1
      : decayToZero(current.leftClick, elapsedMs, 90),
    rightClick: held.right
      ? 1
      : decayToZero(current.rightClick, elapsedMs, 90),
    otherClick: held.other
      ? 1
      : decayToZero(current.otherClick, elapsedMs, 90),
    wheel: decayToZero(current.wheel, elapsedMs, 125),
    pulse: decayToZero(current.pulse, elapsedMs, 100),
    active: buttonsActive
      || Math.abs(current.x) > PARAMETER_EPSILON
      || Math.abs(current.y) > PARAMETER_EPSILON
      || Math.abs(current.wheel) > PARAMETER_EPSILON,
  }
}

export function targetsNeedAnimation(
  keyboard: KeyboardHandTarget,
  mouse: MouseHandTarget,
  heldMouse: HeldMouseButtons = { left: false, right: false, other: false },
): boolean {
  return [
    keyboard.active ? 0 : keyboard.press,
    keyboard.active && keyboard.zone === 'space' ? 0 : keyboard.spacePress,
    keyboard.active && keyboard.zone === 'enter' ? 0 : keyboard.enterPress,
    keyboard.active && keyboard.zone === 'backspace' ? 0 : keyboard.backspacePress,
    keyboard.pulse,
    mouse.x,
    mouse.y,
    mouse.wheel,
    mouse.pulse,
    heldMouse.left ? 0 : mouse.leftClick,
    heldMouse.right ? 0 : mouse.rightClick,
    heldMouse.other ? 0 : mouse.otherClick,
  ].some(value => Math.abs(value) > PARAMETER_EPSILON)
}

function mouseButtonField(
  button: MouseButton,
): 'leftClick' | 'rightClick' | 'otherClick' {
  if (button === 'left') return 'leftClick'
  if (button === 'right') return 'rightClick'
  return 'otherClick'
}
