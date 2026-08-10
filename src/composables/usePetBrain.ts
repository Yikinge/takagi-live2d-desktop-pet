import { computed, onBeforeUnmount, ref } from 'vue'
import {
  KEYBOARD_WATCHDOG_MS,
  MOUSE_BUTTON_WATCHDOG_MS,
  applyKeyboardPress,
  applyKeyboardRelease,
  applyMouseButton,
  applyMouseMove,
  applyMouseWheel,
  clampUnit,
  createKeyboardHandTarget,
  createMouseHandTarget,
  isInputStale,
  stepKeyboardHandTarget,
  stepMouseHandTarget,
  targetsNeedAnimation,
  type HeldMouseButtons,
} from './petInteractionState'
import type {
  DeviceEvent,
  ExpressionTarget,
  InputCadence,
  KeyboardInputEvent,
  KeyboardZone,
  ListenerState,
  LongMotionTarget,
  MouseButton,
  MouseButtonInputEvent,
  PetAction,
  PetExpressionName,
  PetLongMotionName,
} from '../types'

const TEASE_LINES = [
  '这么认真，是怕输给我吗？',
  '刚才按错的那一下，我看见了哦。',
  '要不要猜猜，我下一句会说什么？',
  '手速不错嘛……不过表情更好猜。',
  '再快一点，我可还没被难住呢。',
]

const ENTER_LINES = [
  '提交啦。真的不再检查一次？',
  '嗯，这次看起来很有自信。',
  '按下去就不能假装没看见咯。',
]

const BACKSPACE_LINES = [
  '删掉就当没发生过了吗？',
  '我会替你保守这个小失误的。',
  '犹豫了？被我说中了吧。',
]

const DEMO_KEYBOARD_TARGETS: Readonly<Record<KeyboardZone, readonly [number, number]>> = {
  left: [-0.5, 0.73], // W
  center: [0, 0.45], // D
  right: [1, 0.45], // G
  space: [-0.86, 0],
  enter: [-1, 0.58],
  backspace: [1, 0.04],
  other: [0, 0.45],
}

const DEMO_KEY_LABELS: Readonly<Record<KeyboardZone, string>> = {
  left: 'W',
  center: 'D',
  right: 'G',
  space: 'Space',
  enter: 'Enter',
  backspace: 'Backspace',
  other: '其他键',
}

function demoKeyboardTarget(zone: KeyboardZone): readonly [number, number] {
  return DEMO_KEYBOARD_TARGETS[zone]
}

interface HeldKeyboardZone {
  zone: KeyboardZone
  keyX: number
  keyY: number
  cadence: InputCadence
  count: number
  lastSeenAt: number
}

const WATCHDOG_INTERVAL_MS = 250

export function usePetBrain(getSensitivity: () => number = () => 72) {
  /**
   * `action` is only a compatibility projection for the current UI. The four
   * refs below are independent and are the authoritative interaction output.
   */
  const action = ref<PetAction>('idle')
  const keyboardHand = ref(createKeyboardHandTarget())
  const mouseHand = ref(createMouseHandTarget())
  const expression = ref<ExpressionTarget>({
    name: 'Neutral',
    intensity: 0,
    revision: 0,
  })
  const longMotion = ref<LongMotionTarget>({
    name: 'Idle',
    revision: 0,
  })
  const listenerStatus = ref<ListenerState>({ status: 'starting' })
  const bubble = ref('今天也让我坐在这里看着你吧。')
  const keyBubble = ref('')
  const keyBubbleRevision = ref(0)
  const typingCount = ref(0)
  const combo = ref(0)

  const heldKeyboardZones = new Map<string, HeldKeyboardZone>()
  const heldMouseButtons = new Map<MouseButton, number>()
  let actionTimer: number | undefined
  let bubbleTimer: number | undefined
  let keyBubbleTimer: number | undefined
  let comboTimer: number | undefined
  let expressionTimer: number | undefined
  let longMotionTimer: number | undefined
  let animationFrame: number | undefined
  let lastFrameAt = 0

  const intensity = computed(() => Math.min(combo.value / 14, 1))

  function randomLine(lines: string[]) {
    return lines[Math.floor(Math.random() * lines.length)]
  }

  function say(line: string, duration = 2600) {
    bubble.value = line
    window.clearTimeout(bubbleTimer)
    bubbleTimer = window.setTimeout(() => {
      bubble.value = ''
    }, duration)
  }

  function showKeyBubble(label: string, duration = 900) {
    keyBubble.value = label
    keyBubbleRevision.value += 1
    window.clearTimeout(keyBubbleTimer)
    keyBubbleTimer = window.setTimeout(() => {
      keyBubble.value = ''
    }, duration)
  }

  function setExpression(
    name: PetExpressionName,
    targetIntensity = 1,
    duration?: number,
  ) {
    expression.value = {
      name,
      intensity: clampUnit(targetIntensity),
      revision: expression.value.revision + 1,
    }
    window.clearTimeout(expressionTimer)
    if (duration) {
      expressionTimer = window.setTimeout(() => {
        expression.value = {
          name: 'Neutral',
          intensity: 0,
          revision: expression.value.revision + 1,
        }
      }, duration)
    }
  }

  function setLongMotion(name: PetLongMotionName, duration?: number) {
    longMotion.value = {
      name,
      revision: longMotion.value.revision + 1,
    }
    window.clearTimeout(longMotionTimer)
    if (duration) {
      longMotionTimer = window.setTimeout(() => {
        longMotion.value = {
          name: 'Idle',
          revision: longMotion.value.revision + 1,
        }
      }, duration)
    }
  }

  function latestHeldKeyboardZone() {
    let latest: {
      zone: KeyboardZone
      keyX: number
      keyY: number
      cadence: InputCadence
      at: number
    } | undefined
    for (const held of heldKeyboardZones.values()) {
      if (!latest || held.lastSeenAt > latest.at) {
        latest = {
          zone: held.zone,
          keyX: held.keyX,
          keyY: held.keyY,
          cadence: held.cadence,
          at: held.lastSeenAt,
        }
      }
    }
    return latest
  }

  function heldMouseState(): HeldMouseButtons {
    return {
      left: heldMouseButtons.has('left'),
      right: heldMouseButtons.has('right'),
      other: heldMouseButtons.has('other'),
    }
  }

  function projectRestingAction() {
    if (heldKeyboardZones.size > 0) {
      // All keyboard zones belong to screen_left_hand.
      action.value = 'typing-left'
    } else if (heldMouseButtons.size > 0) {
      action.value = 'mouse'
    } else {
      action.value = 'idle'
    }
  }

  function projectAction(next: PetAction, duration = 150) {
    action.value = next
    window.clearTimeout(actionTimer)
    actionTimer = window.setTimeout(projectRestingAction, duration)
  }

  function runAnimationFrame(now: number) {
    const elapsed = lastFrameAt
      ? Math.min(Math.max(now - lastFrameAt, 0), 64)
      : 16
    lastFrameAt = now

    const heldKeyboard = latestHeldKeyboardZone()
    keyboardHand.value = stepKeyboardHandTarget(
      keyboardHand.value,
      elapsed,
      heldKeyboard && {
        zone: heldKeyboard.zone,
        keyX: heldKeyboard.keyX,
        keyY: heldKeyboard.keyY,
        cadence: heldKeyboard.cadence,
      },
    )
    mouseHand.value = stepMouseHandTarget(
      mouseHand.value,
      elapsed,
      heldMouseState(),
    )

    if (targetsNeedAnimation(
      keyboardHand.value,
      mouseHand.value,
      heldMouseState(),
    )) {
      animationFrame = window.requestAnimationFrame(runAnimationFrame)
    } else {
      animationFrame = undefined
      lastFrameAt = 0
    }
  }

  function ensureAnimationFrame() {
    if (animationFrame === undefined) {
      lastFrameAt = 0
      animationFrame = window.requestAnimationFrame(runAnimationFrame)
    }
  }

  function updateCombo() {
    typingCount.value += 1
    combo.value += 1
    window.clearTimeout(comboTimer)
    comboTimer = window.setTimeout(() => {
      combo.value = 0
    }, 900)

    const teaseThreshold = Math.round(36 - getSensitivity() * 0.18)
    const noticeThreshold = Math.max(8, Math.round(teaseThreshold / 2))
    if (combo.value === noticeThreshold) {
      setExpression('TeaseSmile', 0.72, 1400)
      say('哦？突然认真起来了。')
    }
    if (combo.value === teaseThreshold) {
      setExpression('Smug', 1, 1100)
      setLongMotion('Tease', 900)
      projectAction('tease', 720)
      say(randomLine(TEASE_LINES), 3200)
    }
  }

  function handleKeyboard(event: KeyboardInputEvent) {
    const now = performance.now()
    const targetId = `${event.keyX.toFixed(3)}:${event.keyY.toFixed(3)}`
    if (event.state === 'pressed') {
      showKeyBubble(event.keyLabel)
      const previous = heldKeyboardZones.get(targetId)
      heldKeyboardZones.set(targetId, {
        zone: event.zone,
        keyX: event.keyX,
        keyY: event.keyY,
        cadence: event.cadence,
        count: (previous?.count ?? 0) + 1,
        lastSeenAt: now,
      })
      keyboardHand.value = applyKeyboardPress(keyboardHand.value, event)
      updateCombo()
      // Special-key detail lives in the parameter target. The compatibility
      // action stays left-handed because the current CSS special actions move
      // the wrong hand.
      projectAction('typing-left', 140)

      if (event.zone === 'enter') {
        setExpression('TeaseSmile', 0.68, 900)
        say(randomLine(ENTER_LINES))
      } else if (event.zone === 'backspace' && typingCount.value % 3 === 0) {
        setExpression('Smug', 0.72, 850)
        say(randomLine(BACKSPACE_LINES))
      }
    } else {
      const held = heldKeyboardZones.get(targetId)
      if (held && held.count > 1) {
        heldKeyboardZones.set(targetId, {
          ...held,
          count: held.count - 1,
          lastSeenAt: now,
        })
      } else {
        heldKeyboardZones.delete(targetId)
      }
      const fallback = latestHeldKeyboardZone()
      keyboardHand.value = applyKeyboardRelease(
        keyboardHand.value,
        fallback && {
          zone: fallback.zone,
          keyX: fallback.keyX,
          keyY: fallback.keyY,
          cadence: fallback.cadence,
        },
      )
      projectRestingAction()
    }
    ensureAnimationFrame()
  }

  function handleMouseButton(event: MouseButtonInputEvent) {
    if (event.state === 'pressed') {
      heldMouseButtons.set(event.button, performance.now())
    } else {
      heldMouseButtons.delete(event.button)
    }
    mouseHand.value = applyMouseButton(
      mouseHand.value,
      event,
      heldMouseButtons.size > 0,
    )
    projectAction('mouse', 190)
    ensureAnimationFrame()
  }

  function resetInteractionState() {
    heldKeyboardZones.clear()
    heldMouseButtons.clear()
    keyboardHand.value = {
      ...createKeyboardHandTarget(),
      revision: keyboardHand.value.revision + 1,
    }
    mouseHand.value = {
      ...createMouseHandTarget(),
      revision: mouseHand.value.revision + 1,
    }
    projectRestingAction()
    ensureAnimationFrame()
  }

  function handleListenerStatus(event: Extract<DeviceEvent, { kind: 'listener-status' }>) {
    const previous = listenerStatus.value.status
    listenerStatus.value = {
      status: event.status,
      ...(event.message ? { message: event.message } : {}),
    }

    if (event.status === 'paused') {
      resetInteractionState()
      setExpression('Sleepy', 1)
      setLongMotion('Sleep')
    } else if (event.status === 'permission-denied' || event.status === 'failed') {
      resetInteractionState()
      setExpression('Neutral', 0)
      setLongMotion('Idle')
    } else if (event.status === 'starting') {
      resetInteractionState()
      setExpression('Neutral', 0)
      setLongMotion('Idle')
    } else if (
      event.status === 'running'
      && previous !== 'starting'
      && previous !== 'running'
    ) {
      setExpression('Neutral', 0)
      setLongMotion('WakeUp', 900)
    }
  }

  function handleDeviceEvent(event: DeviceEvent) {
    switch (event.kind) {
      case 'keyboard':
        handleKeyboard(event)
        break
      case 'mouse-move':
        mouseHand.value = applyMouseMove(mouseHand.value, event)
        projectAction('mouse', 120)
        ensureAnimationFrame()
        break
      case 'mouse-button':
        handleMouseButton(event)
        break
      case 'mouse-wheel':
        mouseHand.value = applyMouseWheel(mouseHand.value, event)
        projectAction('mouse', 150)
        ensureAnimationFrame()
        break
      case 'listener-status':
        handleListenerStatus(event)
        break
    }
  }

  function expireStaleInputs(now = performance.now()) {
    let keyboardExpired = false
    for (const [targetId, held] of heldKeyboardZones) {
      if (isInputStale(held.lastSeenAt, now, KEYBOARD_WATCHDOG_MS)) {
        heldKeyboardZones.delete(targetId)
        keyboardExpired = true
      }
    }
    if (keyboardExpired) {
      const fallback = latestHeldKeyboardZone()
      keyboardHand.value = applyKeyboardRelease(
        keyboardHand.value,
        fallback && {
          zone: fallback.zone,
          keyX: fallback.keyX,
          keyY: fallback.keyY,
          cadence: fallback.cadence,
        },
      )
    }

    let mouseExpired = false
    for (const [button, lastSeenAt] of heldMouseButtons) {
      if (isInputStale(lastSeenAt, now, MOUSE_BUTTON_WATCHDOG_MS)) {
        heldMouseButtons.delete(button)
        mouseExpired = true
      }
    }
    if (mouseExpired) {
      mouseHand.value = {
        ...mouseHand.value,
        active: heldMouseButtons.size > 0,
        revision: mouseHand.value.revision + 1,
      }
    }

    if (keyboardExpired || mouseExpired) {
      projectRestingAction()
      ensureAnimationFrame()
    }
  }

  function demoKeyboard(zone: KeyboardZone, cadence: InputCadence = 'normal') {
    const [keyX, keyY] = demoKeyboardTarget(zone)
    const keyLabel = DEMO_KEY_LABELS[zone]
    handleKeyboard({ kind: 'keyboard', zone, keyX, keyY, keyLabel, state: 'pressed', cadence })
    window.setTimeout(() => {
      handleKeyboard({ kind: 'keyboard', zone, keyX, keyY, keyLabel, state: 'released', cadence })
    }, 900)
  }

  /**
   * Temporary adapter for the two existing App.vue demo buttons. It never
   * enters the IPC DTO and both choices still drive screen_left_hand.
   */
  function demoKey(legacyControl: string) {
    demoKeyboard(legacyControl.endsWith('J') ? 'right' : 'left')
  }

  function poke() {
    setExpression('TeaseSmile', 1, 1200)
    setLongMotion('Poke', 900)
    projectAction('tease', 760)
    say(randomLine(TEASE_LINES), 3200)
  }

  const watchdogTimer = window.setInterval(
    () => expireStaleInputs(),
    WATCHDOG_INTERVAL_MS,
  )

  onBeforeUnmount(() => {
    window.clearTimeout(actionTimer)
    window.clearTimeout(bubbleTimer)
    window.clearTimeout(keyBubbleTimer)
    window.clearTimeout(comboTimer)
    window.clearTimeout(expressionTimer)
    window.clearTimeout(longMotionTimer)
    window.clearInterval(watchdogTimer)
    if (animationFrame !== undefined) {
      window.cancelAnimationFrame(animationFrame)
    }
    heldKeyboardZones.clear()
    heldMouseButtons.clear()
  })

  return {
    action,
    bubble,
    combo,
    expression,
    handleDeviceEvent,
    intensity,
    keyboardHand,
    keyBubble,
    keyBubbleRevision,
    listenerStatus,
    longMotion,
    mouseHand,
    poke,
    resetInteractionState,
    say,
    typingCount,
    demoKey,
    demoKeyboard,
  }
}
