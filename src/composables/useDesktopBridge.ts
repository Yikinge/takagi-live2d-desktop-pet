import {
  computed,
  onBeforeUnmount,
  ref,
} from 'vue'
import type {
  DesktopOperationError,
  DesktopStateSnapshot,
  DeviceEvent,
  InputCadence,
  InputState,
  KeyboardZone,
  ListenerState,
  ListenerStatus,
  MouseAxisDirection,
  MouseButton,
  MouseWheelDirection,
  ShortcutRegistrationStatus,
  ShortcutStatusPayload,
} from '../types'

type Cleanup = () => void
type Invoke = typeof import('@tauri-apps/api/core')['invoke']
type Listen = typeof import('@tauri-apps/api/event')['listen']

const PREVIEW_MESSAGE = '浏览器预览模式：点击下方按键可以测试动作'
const RECOVERY_ACCELERATOR = 'CommandOrControl+Shift+T' as const

export const DESKTOP_COMMANDS = {
  startDeviceListening: 'start_device_listening',
  recheckInputPermissions: 'recheck_input_permissions',
  getListenerStatus: 'get_listener_status',
  setInteractionPaused: 'set_interaction_paused',
  setClickThrough: 'set_click_through',
  setPositionLocked: 'set_position_locked',
  setAlwaysOnTop: 'set_always_on_top',
  setMainWindowVisible: 'set_main_window_visible',
  showMainWindow: 'show_main_window',
  openSettings: 'open_settings',
  hideSettingsWindow: 'hide_settings_window',
  notifySettingsUpdated: 'notify_settings_updated',
  previewKeyBubble: 'preview_key_bubble',
  getDesktopState: 'get_desktop_state',
  getAutostartEnabled: 'get_autostart_enabled',
  setAutostartEnabled: 'set_autostart_enabled',
} as const

export const DESKTOP_EVENTS = {
  deviceChanged: 'device-changed',
  desktopStateChanged: 'desktop-state-changed',
  shortcutStatusChanged: 'shortcut-status-changed',
  openSettings: 'open-settings',
  settingsUpdated: 'pet-settings-updated',
  desktopOperationError: 'desktop-operation-error',
} as const

function defaultShortcutState(): ShortcutStatusPayload {
  return {
    accelerator: RECOVERY_ACCELERATOR,
    status: 'pending',
  }
}

function defaultDesktopState(): DesktopStateSnapshot {
  return {
    interactionPaused: false,
    clickThrough: false,
    positionLocked: true,
    alwaysOnTop: true,
    visible: true,
    shortcut: defaultShortcutState(),
  }
}

export function useDesktopBridge(onDeviceEvent: (event: DeviceEvent) => void) {
  const isDesktop = ref(
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window,
  )
  const started = ref(false)
  const listenerState = ref<ListenerState>({
    status: isDesktop.value ? 'starting' : 'paused',
    message: isDesktop.value
      ? '等待全局输入监听启动。'
      : PREVIEW_MESSAGE,
  })
  const desktopState = ref(defaultDesktopState())
  const shortcutState = ref(defaultShortcutState())
  const autostartEnabled = ref(false)
  const autostartAvailable = ref(isDesktop.value)
  const autostartLoaded = ref(false)
  const openSettingsRevision = ref(0)
  const settingsRevision = ref(0)
  const desktopOperationError = ref<DesktopOperationError | null>(null)
  const bridgeFailure = ref('')
  const cleanups: Cleanup[] = []

  const inputReady = computed(
    () => listenerState.value.status === 'running',
  )
  const autostartState = computed(() => ({
    available: autostartAvailable.value,
    enabled: autostartEnabled.value,
    loaded: autostartLoaded.value,
  }))
  const error = computed(() => {
    if (!isDesktop.value) return PREVIEW_MESSAGE
    if (bridgeFailure.value) return bridgeFailure.value
    if (desktopOperationError.value) {
      return desktopOperationError.value.message
    }
    if (
      listenerState.value.status === 'permission-denied'
      || listenerState.value.status === 'failed'
    ) {
      return listenerState.value.message ?? '全局输入监听不可用。'
    }
    return ''
  })

  let invokeCommand: Invoke | undefined
  let startPromise: Promise<void> | undefined
  let disposed = false
  let listenerEventRevision = 0
  let desktopStateEventRevision = 0
  let shortcutEventRevision = 0

  function setBridgeFailure(operation: string, reason: unknown) {
    const message = readableError(reason, `${operation} 失败。`)
    bridgeFailure.value = message
    desktopOperationError.value = { operation, message }
  }

  function clearOperationError() {
    bridgeFailure.value = ''
    desktopOperationError.value = null
  }

  function applyListenerEvent(event: DeviceEvent) {
    if (event.kind === 'listener-status') {
      listenerState.value = {
        status: event.status,
        ...(event.message ? { message: event.message } : {}),
      }
    }
    onDeviceEvent(event)
  }

  function acceptDevicePayload(payload: unknown) {
    const event = parseDeviceEvent(payload)
    if (!event) {
      setBridgeFailure(
        DESKTOP_EVENTS.deviceChanged,
        '本地输入服务返回了无效的语义事件。',
      )
      return
    }
    if (event.kind === 'listener-status') listenerEventRevision += 1
    applyListenerEvent(event)
  }

  function applyShortcutState(next: ShortcutStatusPayload) {
    shortcutState.value = next
    desktopState.value = {
      ...desktopState.value,
      shortcut: next,
    }
  }

  function acceptShortcutPayload(payload: unknown) {
    const next = parseShortcutStatus(payload)
    if (!next) {
      setBridgeFailure(
        DESKTOP_EVENTS.shortcutStatusChanged,
        '快捷键服务返回了无效状态。',
      )
      return
    }
    shortcutEventRevision += 1
    applyShortcutState(next)
  }

  function applyDesktopState(next: DesktopStateSnapshot) {
    desktopState.value = next
    shortcutState.value = next.shortcut
  }

  function acceptDesktopPayload(payload: unknown) {
    const next = parseDesktopState(payload)
    if (!next) {
      setBridgeFailure(
        DESKTOP_EVENTS.desktopStateChanged,
        '桌面服务返回了无效状态。',
      )
      return
    }
    desktopStateEventRevision += 1
    shortcutEventRevision += 1
    applyDesktopState(next)
  }

  function acceptDesktopErrorPayload(payload: unknown) {
    const next = parseDesktopOperationError(payload)
    if (!next) {
      setBridgeFailure(
        DESKTOP_EVENTS.desktopOperationError,
        '桌面服务返回了无效错误状态。',
      )
      return
    }
    desktopOperationError.value = next
  }

  async function addSubscription<T>(
    listen: Listen,
    eventName: string,
    handler: (payload: T) => void,
  ) {
    const unlisten = await listen<T>(eventName, event => {
      if (!disposed) handler(event.payload)
    })
    if (disposed) {
      unlisten()
    } else {
      cleanups.push(unlisten)
    }
  }

  async function startDesktopBridge() {
    try {
      const [{ listen }, { invoke }] = await Promise.all([
        import('@tauri-apps/api/event'),
        import('@tauri-apps/api/core'),
      ])
      if (disposed) return
      invokeCommand = invoke

      await Promise.all([
        addSubscription<unknown>(
          listen,
          DESKTOP_EVENTS.deviceChanged,
          acceptDevicePayload,
        ),
        addSubscription<unknown>(
          listen,
          DESKTOP_EVENTS.desktopStateChanged,
          acceptDesktopPayload,
        ),
        addSubscription<unknown>(
          listen,
          DESKTOP_EVENTS.shortcutStatusChanged,
          acceptShortcutPayload,
        ),
        addSubscription<unknown>(
          listen,
          DESKTOP_EVENTS.openSettings,
          () => {
            openSettingsRevision.value += 1
          },
        ),
        addSubscription<unknown>(
          listen,
          DESKTOP_EVENTS.settingsUpdated,
          () => {
            settingsRevision.value += 1
          },
        ),
        addSubscription<unknown>(
          listen,
          DESKTOP_EVENTS.desktopOperationError,
          acceptDesktopErrorPayload,
        ),
      ])
      if (disposed) return
      started.value = true

      await Promise.all([
        startInputListener(),
        refreshDesktopState(),
        refreshAutostart(),
      ])
    } catch (reason) {
      setBridgeFailure('bridge-start', reason)
      started.value = false
      invokeCommand = undefined
      disposeSubscriptions()
    }
  }

  async function start() {
    if (!isDesktop.value || disposed || started.value) return
    if (!startPromise) {
      startPromise = startDesktopBridge().finally(() => {
        startPromise = undefined
      })
    }
    await startPromise
  }

  async function ensureInvoke(): Promise<Invoke | undefined> {
    if (!isDesktop.value || disposed) return undefined
    if (!started.value) await start()
    return invokeCommand
  }

  async function startInputListener() {
    const invoke = invokeCommand
    if (!invoke || disposed) return
    const eventRevision = listenerEventRevision
    try {
      const payload = await invoke<unknown>(
        DESKTOP_COMMANDS.startDeviceListening,
      )
      const event = parseDeviceEvent(payload)
      if (!event || event.kind !== 'listener-status') {
        throw new Error('本地输入服务返回了无效状态。')
      }
      // The command emits the same status before returning it. If that event
      // (or a newer Running event) already arrived, its ordering is fresher.
      if (listenerEventRevision === eventRevision) applyListenerEvent(event)
    } catch (reason) {
      setBridgeFailure(DESKTOP_COMMANDS.startDeviceListening, reason)
    }
  }

  async function refreshListenerState(): Promise<ListenerState> {
    const invoke = await ensureInvoke()
    if (!invoke) return listenerState.value
    const eventRevision = listenerEventRevision
    try {
      const payload = await invoke<unknown>(
        DESKTOP_COMMANDS.getListenerStatus,
      )
      const event = parseDeviceEvent(payload)
      if (!event || event.kind !== 'listener-status') {
        throw new Error('本地输入服务返回了无效状态。')
      }
      if (listenerEventRevision === eventRevision) applyListenerEvent(event)
      return listenerState.value
    } catch (reason) {
      setBridgeFailure(DESKTOP_COMMANDS.getListenerStatus, reason)
      return listenerState.value
    }
  }

  async function recheckInputPermissions(): Promise<ListenerState> {
    const invoke = await ensureInvoke()
    if (!invoke) return listenerState.value
    clearOperationError()
    const eventRevision = listenerEventRevision
    try {
      const payload = await invoke<unknown>(
        DESKTOP_COMMANDS.recheckInputPermissions,
      )
      const event = parseDeviceEvent(payload)
      if (!event || event.kind !== 'listener-status') {
        throw new Error('权限服务返回了无效状态。')
      }
      if (listenerEventRevision === eventRevision) applyListenerEvent(event)
      return listenerState.value
    } catch (reason) {
      setBridgeFailure(DESKTOP_COMMANDS.recheckInputPermissions, reason)
      return listenerState.value
    }
  }

  async function refreshDesktopState(): Promise<DesktopStateSnapshot> {
    const invoke = await ensureInvoke()
    if (!invoke) return desktopState.value
    const stateEventRevision = desktopStateEventRevision
    const currentShortcutRevision = shortcutEventRevision
    try {
      const payload = await invoke<unknown>(DESKTOP_COMMANDS.getDesktopState)
      const next = parseDesktopState(payload)
      if (!next) throw new Error('桌面服务返回了无效状态。')
      if (desktopStateEventRevision === stateEventRevision) {
        applyDesktopState({
          ...next,
          shortcut: shortcutEventRevision === currentShortcutRevision
            ? next.shortcut
            : shortcutState.value,
        })
      }
      return desktopState.value
    } catch (reason) {
      setBridgeFailure(DESKTOP_COMMANDS.getDesktopState, reason)
      return desktopState.value
    }
  }

  async function updateDesktopState(
    command: string,
    args: Record<string, unknown> | undefined,
    previewUpdate: () => DesktopStateSnapshot,
  ): Promise<DesktopStateSnapshot> {
    if (!isDesktop.value) {
      const next = previewUpdate()
      applyDesktopState(next)
      return next
    }

    const invoke = await ensureInvoke()
    if (!invoke) return desktopState.value
    clearOperationError()
    const stateEventRevision = desktopStateEventRevision
    const currentShortcutRevision = shortcutEventRevision
    try {
      const payload = await invoke<unknown>(command, args)
      const next = parseDesktopState(payload)
      if (!next) throw new Error('桌面服务返回了无效状态。')
      if (desktopStateEventRevision === stateEventRevision) {
        applyDesktopState({
          ...next,
          shortcut: shortcutEventRevision === currentShortcutRevision
            ? next.shortcut
            : shortcutState.value,
        })
      }
      return desktopState.value
    } catch (reason) {
      setBridgeFailure(command, reason)
      return desktopState.value
    }
  }

  async function setClickThrough(enabled: boolean) {
    return updateDesktopState(
      DESKTOP_COMMANDS.setClickThrough,
      { enabled },
      () => ({
        ...desktopState.value,
        clickThrough: enabled,
        positionLocked: enabled ? true : desktopState.value.positionLocked,
      }),
    )
  }

  async function setPositionLocked(locked: boolean) {
    return updateDesktopState(
      DESKTOP_COMMANDS.setPositionLocked,
      { locked },
      () => ({
        ...desktopState.value,
        positionLocked: locked,
        clickThrough: locked,
      }),
    )
  }

  async function setAlwaysOnTop(enabled: boolean) {
    return updateDesktopState(
      DESKTOP_COMMANDS.setAlwaysOnTop,
      { enabled },
      () => ({ ...desktopState.value, alwaysOnTop: enabled }),
    )
  }

  async function setInteractionPaused(paused: boolean) {
    return updateDesktopState(
      DESKTOP_COMMANDS.setInteractionPaused,
      { paused },
      () => ({ ...desktopState.value, interactionPaused: paused }),
    )
  }

  async function setMainWindowVisible(visible: boolean) {
    return updateDesktopState(
      DESKTOP_COMMANDS.setMainWindowVisible,
      { visible },
      () => ({
        ...desktopState.value,
        visible,
      }),
    )
  }

  async function showMainWindow() {
    return updateDesktopState(
      DESKTOP_COMMANDS.showMainWindow,
      undefined,
      () => ({
        ...desktopState.value,
        visible: true,
      }),
    )
  }

  async function openSettings() {
    if (!isDesktop.value) openSettingsRevision.value += 1
    return updateDesktopState(
      DESKTOP_COMMANDS.openSettings,
      undefined,
      () => ({
        ...desktopState.value,
        visible: true,
      }),
    )
  }

  async function invokeVoid(command: string) {
    if (!isDesktop.value) return
    const invoke = await ensureInvoke()
    if (!invoke) return
    clearOperationError()
    try {
      await invoke(command)
    } catch (reason) {
      setBridgeFailure(command, reason)
    }
  }

  async function hideSettingsWindow() {
    await invokeVoid(DESKTOP_COMMANDS.hideSettingsWindow)
  }

  async function notifySettingsUpdated() {
    await invokeVoid(DESKTOP_COMMANDS.notifySettingsUpdated)
  }

  async function previewKeyBubble() {
    await invokeVoid(DESKTOP_COMMANDS.previewKeyBubble)
  }

  async function refreshAutostart(): Promise<boolean> {
    const invoke = await ensureInvoke()
    if (!invoke) {
      autostartEnabled.value = false
      autostartLoaded.value = true
      return false
    }
    try {
      autostartEnabled.value = await invoke<boolean>(
        DESKTOP_COMMANDS.getAutostartEnabled,
      )
      autostartAvailable.value = true
    } catch (reason) {
      autostartAvailable.value = false
      setBridgeFailure(DESKTOP_COMMANDS.getAutostartEnabled, reason)
    } finally {
      autostartLoaded.value = true
    }
    return autostartEnabled.value
  }

  async function setAutostartEnabled(enabled: boolean): Promise<boolean> {
    const invoke = await ensureInvoke()
    if (!invoke) return false
    clearOperationError()
    try {
      autostartEnabled.value = await invoke<boolean>(
        DESKTOP_COMMANDS.setAutostartEnabled,
        { enabled },
      )
      autostartAvailable.value = true
    } catch (reason) {
      setBridgeFailure(DESKTOP_COMMANDS.setAutostartEnabled, reason)
    } finally {
      autostartLoaded.value = true
    }
    return autostartEnabled.value
  }

  async function startDragging() {
    if (!isDesktop.value || disposed) return
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      await getCurrentWindow().startDragging()
    } catch (reason) {
      setBridgeFailure('start-dragging', reason)
    }
  }

  /**
   * Compatibility with the current App call site. Recovery shortcut
   * registration and handling live exclusively in Rust.
   */
  async function registerToggleShortcut(_callback: () => void) {
    await start()
  }

  function disposeSubscriptions() {
    while (cleanups.length) {
      try {
        cleanups.pop()?.()
      } catch {
        // Tauri unlisten functions are best-effort during teardown.
      }
    }
  }

  onBeforeUnmount(() => {
    disposed = true
    started.value = false
    invokeCommand = undefined
    disposeSubscriptions()
  })

  return {
    autostartAvailable,
    autostartEnabled,
    autostartLoaded,
    autostartState,
    clearOperationError,
    desktopOperationError,
    desktopState,
    error,
    inputReady,
    isDesktop,
    listenerState,
    hideSettingsWindow,
    notifySettingsUpdated,
    openSettings,
    openSettingsRevision,
    previewKeyBubble,
    recheckInputPermissions,
    refreshAutostart,
    refreshDesktopState,
    refreshListenerState,
    registerToggleShortcut,
    setAlwaysOnTop,
    setAutostartEnabled,
    setClickThrough,
    setInteractionPaused,
    setMainWindowVisible,
    setPositionLocked,
    settingsRevision,
    shortcutState,
    showMainWindow,
    start,
    started,
    startDragging,
  }
}

function parseDeviceEvent(payload: unknown): DeviceEvent | undefined {
  if (!isRecord(payload) || typeof payload.kind !== 'string') return undefined

  if (
    payload.kind === 'keyboard'
    && isKeyboardZone(payload.zone)
    && isSignedUnitNumber(payload.keyX)
    && isUnitNumber(payload.keyY)
    && typeof payload.keyLabel === 'string'
    && payload.keyLabel.length > 0
    && payload.keyLabel.length <= 24
    && isInputState(payload.state)
    && isInputCadence(payload.cadence)
  ) {
    return {
      kind: 'keyboard',
      zone: payload.zone,
      keyX: payload.keyX,
      keyY: payload.keyY,
      keyLabel: payload.keyLabel,
      state: payload.state,
      cadence: payload.cadence,
    }
  }

  if (
    payload.kind === 'mouse-move'
    && isMouseAxisDirection(payload.x)
    && isMouseAxisDirection(payload.y)
    && isUnitNumber(payload.speed)
    && (
      (payload.gazeX === undefined && payload.gazeY === undefined)
      || (isSignedUnitNumber(payload.gazeX) && isSignedUnitNumber(payload.gazeY))
    )
  ) {
    return {
      kind: 'mouse-move',
      x: payload.x,
      y: payload.y,
      speed: payload.speed,
      ...(payload.gazeX !== undefined && payload.gazeY !== undefined
        ? { gazeX: payload.gazeX, gazeY: payload.gazeY }
        : {}),
    }
  }

  if (
    payload.kind === 'mouse-button'
    && isMouseButton(payload.button)
    && isInputState(payload.state)
  ) {
    return {
      kind: 'mouse-button',
      button: payload.button,
      state: payload.state,
    }
  }

  if (
    payload.kind === 'mouse-wheel'
    && isMouseWheelDirection(payload.direction)
    && isUnitNumber(payload.intensity)
  ) {
    return {
      kind: 'mouse-wheel',
      direction: payload.direction,
      intensity: payload.intensity,
    }
  }

  if (
    payload.kind === 'listener-status'
    && isListenerStatus(payload.status)
    && (
      payload.message === undefined
      || typeof payload.message === 'string'
    )
  ) {
    return {
      kind: 'listener-status',
      status: payload.status,
      ...(payload.message ? { message: payload.message } : {}),
    }
  }

  return undefined
}

function parseShortcutStatus(
  payload: unknown,
): ShortcutStatusPayload | undefined {
  if (
    !isRecord(payload)
    || payload.accelerator !== RECOVERY_ACCELERATOR
    || !isShortcutRegistrationStatus(payload.status)
    || (
      payload.message !== undefined
      && typeof payload.message !== 'string'
    )
  ) return undefined

  return {
    accelerator: RECOVERY_ACCELERATOR,
    status: payload.status,
    ...(payload.message ? { message: payload.message } : {}),
  }
}

function parseDesktopState(
  payload: unknown,
): DesktopStateSnapshot | undefined {
  if (
    !isRecord(payload)
    || typeof payload.interactionPaused !== 'boolean'
    || typeof payload.clickThrough !== 'boolean'
    || typeof payload.positionLocked !== 'boolean'
    || typeof payload.alwaysOnTop !== 'boolean'
    || typeof payload.visible !== 'boolean'
  ) return undefined

  const shortcut = parseShortcutStatus(payload.shortcut)
  if (!shortcut) return undefined
  return {
    interactionPaused: payload.interactionPaused,
    clickThrough: payload.clickThrough,
    positionLocked: payload.positionLocked,
    alwaysOnTop: payload.alwaysOnTop,
    visible: payload.visible,
    shortcut,
  }
}

function parseDesktopOperationError(
  payload: unknown,
): DesktopOperationError | undefined {
  if (
    !isRecord(payload)
    || typeof payload.operation !== 'string'
    || !payload.operation
    || typeof payload.message !== 'string'
    || !payload.message
  ) return undefined
  return {
    operation: payload.operation,
    message: payload.message,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
    && value <= 1
}

function isSignedUnitNumber(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= -1
    && value <= 1
}

function isKeyboardZone(value: unknown): value is KeyboardZone {
  return [
    'left',
    'center',
    'right',
    'space',
    'enter',
    'backspace',
    'other',
  ].includes(value as KeyboardZone)
}

function isInputState(value: unknown): value is InputState {
  return ['pressed', 'released'].includes(value as InputState)
}

function isInputCadence(value: unknown): value is InputCadence {
  return ['slow', 'normal', 'fast', 'burst'].includes(value as InputCadence)
}

function isMouseAxisDirection(value: unknown): value is MouseAxisDirection {
  return value === -1 || value === 0 || value === 1
}

function isMouseButton(value: unknown): value is MouseButton {
  return ['left', 'right', 'other'].includes(value as MouseButton)
}

function isMouseWheelDirection(
  value: unknown,
): value is MouseWheelDirection {
  return ['up', 'down'].includes(value as MouseWheelDirection)
}

function isListenerStatus(value: unknown): value is ListenerStatus {
  return [
    'starting',
    'running',
    'paused',
    'permission-denied',
    'failed',
  ].includes(value as ListenerStatus)
}

function isShortcutRegistrationStatus(
  value: unknown,
): value is ShortcutRegistrationStatus {
  return ['pending', 'registered', 'conflict']
    .includes(value as ShortcutRegistrationStatus)
}

function readableError(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message) return reason.message
  if (typeof reason === 'string' && reason) return reason
  return fallback
}
