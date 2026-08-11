/**
 * Compatibility projection used by the current raster-preview and Live2D adapters.
 *
 * The interaction state below is the source of truth. In particular,
 * keyboard input must never project to `typing-right`: every keyboard zone is
 * operated by screen_left_hand.
 */
export type PetAction =
  | 'idle'
  | 'typing-left'
  | 'typing-right'
  | 'space'
  | 'enter'
  | 'backspace'
  | 'mouse'
  | 'tease'
  | 'surprised'

export type InputState = 'pressed' | 'released'
export type InputCadence = 'slow' | 'normal' | 'fast' | 'burst'
export type KeyboardZone =
  | 'left'
  | 'center'
  | 'right'
  | 'space'
  | 'enter'
  | 'backspace'
  | 'other'
export type MouseAxisDirection = -1 | 0 | 1
export type MouseButton = 'left' | 'right' | 'other'
export type MouseWheelDirection = 'up' | 'down'
export type ListenerStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'permission-denied'
  | 'failed'

export interface KeyboardInputEvent {
  kind: 'keyboard'
  zone: KeyboardZone
  /** Horizontal landing position used only by the animated keyboard hand. */
  keyX: number
  /** Anonymous keyboard depth: 0 is nearest the character, 1 is farthest. */
  keyY: number
  /** Short physical-key label used transiently by the on-screen key bubble. */
  keyLabel: string
  state: InputState
  cadence: InputCadence
}

export interface MouseMoveInputEvent {
  kind: 'mouse-move'
  x: MouseAxisDirection
  y: MouseAxisDirection
  speed: number
  /** Normalized position inside the display that currently contains the pointer. */
  gazeX?: number
  gazeY?: number
}

export interface MouseButtonInputEvent {
  kind: 'mouse-button'
  button: MouseButton
  state: InputState
}

export interface MouseWheelInputEvent {
  kind: 'mouse-wheel'
  direction: MouseWheelDirection
  intensity: number
}

export interface ListenerStatusEvent {
  kind: 'listener-status'
  status: ListenerStatus
  message?: string
}

/**
 * Privacy-preserving IPC protocol.
 *
 * It intentionally has no typed/composed text, raw/absolute pointer coordinate,
 * foreground application, window title, or process name. Keyboard events carry
 * only a short physical-key label for the transient on-screen indicator.
 * Eye tracking receives only a normalized -1..1 position within the current
 * display; a point outside every display is omitted.
 */
export type SemanticInputEvent =
  | KeyboardInputEvent
  | MouseMoveInputEvent
  | MouseButtonInputEvent
  | MouseWheelInputEvent
  | ListenerStatusEvent

/** Kept as the bridge-facing name while the Rust side migrates to the DTO. */
export type DeviceEvent = SemanticInputEvent

export interface KeyboardHandTarget {
  owner: 'screen_left_hand'
  zone: KeyboardZone
  zoneValue: number
  keyX: number
  keyY: number
  press: number
  spacePress: number
  enterPress: number
  backspacePress: number
  pulse: number
  cadence: InputCadence
  active: boolean
  revision: number
}

export interface MouseHandTarget {
  owner: 'screen_right_hand'
  x: number
  y: number
  gazeX: number
  gazeY: number
  leftClick: number
  rightClick: number
  otherClick: number
  wheel: number
  pulse: number
  active: boolean
  revision: number
}

export type PetExpressionName =
  | 'Neutral'
  | 'TeaseSmile'
  | 'Wink'
  | 'Smug'
  | 'Surprised'
  | 'Blush'
  | 'Sleepy'

export type PetLongMotionName =
  | 'Idle'
  | 'Tease'
  | 'Poke'
  | 'Surprised'
  | 'Sleep'
  | 'WakeUp'

export interface ExpressionTarget {
  name: PetExpressionName
  intensity: number
  revision: number
}

export interface LongMotionTarget {
  name: PetLongMotionName
  revision: number
}

export interface ListenerState {
  status: ListenerStatus
  message?: string
}

export type ShortcutRegistrationStatus =
  | 'pending'
  | 'registered'
  | 'conflict'

export interface ShortcutStatusPayload {
  accelerator: 'CommandOrControl+Shift+T'
  status: ShortcutRegistrationStatus
  message?: string
}

export interface DesktopStateSnapshot {
  interactionPaused: boolean
  clickThrough: boolean
  positionLocked: boolean
  alwaysOnTop: boolean
  visible: boolean
  shortcut: ShortcutStatusPayload
}

export interface DesktopOperationError {
  operation: string
  message: string
}

export interface PetSettings {
  bubbleEnabled: boolean
  clickThrough: boolean
  sensitivity: number
  modelPath: string
  characterScale: number
  alwaysOnTop: boolean
  interactionPaused: boolean
  autostartEnabled: boolean
}
