import {
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type Ref,
} from 'vue'
import 'pixi.js/unsafe-eval'
import type { Live2DSprite } from 'easy-live2d'
import type { Application } from 'pixi.js'
import parameterMapJson from '../../art/specs/parameter-map.json'
import {
  CUBISM_CORE_PATH,
  isBlockingDiagnostic,
  preflightModelContract,
  primaryDiagnosticStatus,
  probeCubismCore,
  resolveLocalModelAssetUrl,
  type ModelContract,
  type ModelDiagnostic,
  type ModelDiagnosticCode,
} from './modelContract'
import type {
  ExpressionTarget,
  KeyboardHandTarget,
  LongMotionTarget,
  MouseHandTarget,
} from '../types'

interface Live2DInputs {
  keyboardHand: Ref<KeyboardHandTarget>
  mouseHand: Ref<MouseHandTarget>
  expression: Ref<ExpressionTarget>
  longMotion: Ref<LongMotionTarget>
  scale?: Ref<number>
  onPoke?: () => void
}

interface ParameterSpec {
  id: string
  min: number
  max: number
  default: number
  smoothingMs: number
  returnMs: number
  priority: number
  driver: string
}

interface ParameterRange {
  min: number
  max: number
}

const parameterMap = parameterMapJson as {
  parameters: ParameterSpec[]
  expressions: string[]
  motions: string[]
}

const PARAMETER_SPECS = new Map(
  parameterMap.parameters.map(spec => [spec.id, spec]),
)

const PARAMETER_IDS = {
  angleX: 'ParamAngleX',
  angleY: 'ParamAngleY',
  angleZ: 'ParamAngleZ',
  bodyAngleX: 'ParamBodyAngleX',
  hairFront: 'ParamHairFront',
  eyeLOpen: 'ParamEyeLOpen',
  eyeROpen: 'ParamEyeROpen',
  eyeX: 'ParamEyeBallX',
  eyeY: 'ParamEyeBallY',
  keyZone: 'ParamKeyHandZone',
  keyPress: 'ParamKeyPress',
  spacePress: 'ParamSpacePress',
  enterPress: 'ParamEnterPress',
  backspacePress: 'ParamBackspacePress',
  mouseX: 'ParamMouseHandX',
  mouseY: 'ParamMouseHandY',
  mouseLeft: 'ParamMouseLeftClick',
  mouseRight: 'ParamMouseRightClick',
  mouseWheel: 'ParamMouseWheel',
} as const

const CORE_SCRIPT_ID = 'takagi-live2d-cubism-core'
const MODEL_READY_TIMEOUT_MS = 12_000
const MIN_CHARACTER_SCALE = 0.25
const MAX_CHARACTER_SCALE = 3
const MAX_RENDER_RESOLUTION = 2.5
const FRONT_HAIR_DRAWABLE_IDS = new Set([
  'front_hair_01',
  'front_hair_02',
  'front_hair_03',
  'front_hair_04',
  'front_hair_05',
])

// These source meshes are reconstruction/expression alternates. The current
// Cubism export leaves them at full opacity, which exposes blocky shoulder
// patches, duplicate lower lids, a duplicate nose and a spare torso in the
// neutral pose. They are not required by any shipped motion or expression.
const ALWAYS_HIDDEN_DRAWABLE_IDS = new Set([
  ...FRONT_HAIR_DRAWABLE_IDS,
  'lower_lid_screen_left',
  'lower_lid_screen_right',
  'nose',
  'screen_left_keyboard_hand',
  'sleeve_screen_left',
  'screen_left_forearm',
  'screen_left_upper_arm',
  'keyboard_base',
  'keyboard_zone_left',
  'keyboard_zone_center',
  'keyboard_zone_right',
  'key_backspace',
  'key_space',
  'key_enter',
  'desk_mat',
  'mouse_pad',
  'mouse_body',
  'mouse_left_button',
  'mouse_right_button',
  'mouse_wheel',
  'desk_prop_eraser',
  'desk_prop_chalk',
  'desk_prop_pencil',
  'desk_prop_notebook',
  'screen_right_forearm',
  'screen_right_upper_arm',
  'sleeve_screen_right',
  // Replaced by the approved complete forearm + mitten overlay. Keeping this
  // drawable visible caused a skin hand to show through beneath the glove.
  'screen_right_mouse_hand',
  'torso',
])

// Move the complete physical mouse assembly as one rigid group. The mouse pad
// deliberately stays outside this set.
const MOUSE_ASSEMBLY_DRAWABLE_IDS = new Set([
  'mouse_body',
  'mouse_left_button',
  'mouse_right_button',
  'mouse_wheel',
])
const MOUSE_ARM_DRAWABLE_IDS = new Set([
  'screen_right_mouse_hand',
  'sleeve_screen_right',
])

// The right closed-eye mesh is keyed correctly in Cubism, but the left one is
// exported at opacity 1 for the entire eye-open range. Drive both alternates
// from ParamEyeOpen with a near-closed threshold so blinking and Wink/Sleepy
// work without a dark duplicate stroke during ordinary squints.
const CLOSED_EYE_DRAWABLES = [
  {
    drawableId: 'eye_closed_screen_left',
    parameterId: 'ParamEyeLOpen',
  },
  {
    drawableId: 'eye_closed_screen_right',
    parameterId: 'ParamEyeROpen',
  },
] as const

// During a blink the open eye artwork needs to disappear together. The
// original Cubism eye-open parameters do not reliably win over the currently
// active expression, so the renderer combines those parameters with our
// short, independently scheduled blink envelope.
const OPEN_EYE_DRAWABLES = [
  { drawableId: 'eye_white_screen_left', parameterId: 'ParamEyeLOpen' },
  { drawableId: 'upper_lid_screen_left', parameterId: 'ParamEyeLOpen' },
  { drawableId: 'iris_screen_left', parameterId: 'ParamEyeLOpen' },
  { drawableId: 'pupil_screen_left', parameterId: 'ParamEyeLOpen' },
  { drawableId: 'highlight_screen_left', parameterId: 'ParamEyeLOpen' },
  { drawableId: 'eye_white_screen_right', parameterId: 'ParamEyeROpen' },
  { drawableId: 'upper_lid_screen_right', parameterId: 'ParamEyeROpen' },
  { drawableId: 'iris_screen_right', parameterId: 'ParamEyeROpen' },
  { drawableId: 'pupil_screen_right', parameterId: 'ParamEyeROpen' },
  { drawableId: 'highlight_screen_right', parameterId: 'ParamEyeROpen' },
] as const

const HEAD_DRAWABLE_IDS = new Set([
  'back_hair',
  'blush_screen_left',
  'blush_screen_right',
  'brow_screen_left',
  'brow_screen_right',
  'ear_screen_left',
  'ear_screen_right',
  'eye_closed_screen_left',
  'eye_closed_screen_right',
  'eye_white_screen_left',
  'eye_white_screen_right',
  'face',
  'front_hair_01',
  'front_hair_02',
  'front_hair_03',
  'front_hair_04',
  'front_hair_05',
  'highlight_screen_left',
  'highlight_screen_right',
  'iris_screen_left',
  'iris_screen_right',
  'lower_lid_screen_left',
  'lower_lid_screen_right',
  'mouth_closed',
  'mouth_inner',
  'nose',
  'pupil_screen_left',
  'pupil_screen_right',
  'side_hair_screen_left',
  'side_hair_screen_right',
  'teeth',
  'tongue',
  'upper_lid_screen_left',
  'upper_lid_screen_right',
])

// Move only the colored eye contents. The eye whites and lids stay fixed and
// remain the visual boundary, so a glance cannot pull an eyeball out of its
// socket even at the largest quantized mouse impulse.
const EYE_GAZE_DRAWABLE_IDS = new Set([
  'highlight_screen_left',
  'highlight_screen_right',
  'iris_screen_left',
  'iris_screen_right',
  'pupil_screen_left',
  'pupil_screen_right',
])

interface HeadPose {
  x: number
  y: number
  z: number
}

interface EyeGaze {
  x: number
  y: number
}

interface MouseAssemblyOffset {
  x: number
  y: number
}

interface AnchoredMouseArmProjection {
  drawableIndices: Set<number>
  root: { x: number; y: number }
  hand: { x: number; y: number }
}

interface MouseArmPose {
  a: number
  b: number
  rootX: number
  rootY: number
  offsetX: number
  offsetY: number
}

const NEUTRAL_HEAD_POSE: HeadPose = { x: 0, y: 0, z: 0 }
const EXPRESSION_HEAD_POSES: Record<ExpressionTarget['name'], HeadPose> = {
  Neutral: NEUTRAL_HEAD_POSE,
  TeaseSmile: { x: -3, y: 2, z: -2 },
  Wink: { x: -3, y: 1, z: -2 },
  Smug: { x: -4, y: 1, z: -3 },
  Surprised: { x: 0, y: 4, z: 0 },
  Blush: { x: 2, y: -3, z: 1 },
  Sleepy: { x: 0, y: -4, z: 1 },
}
const EXPRESSION_HEAD_TRANSITION_MS = 220
const POINTER_HEAD_X_DEGREES = 3.2
const POINTER_HEAD_Y_DEGREES = 2.2
const POINTER_HEAD_Z_DEGREES = -0.7
const HEAD_PIVOT_X = 0
const HEAD_PIVOT_Y = -0.055
const HEAD_TRANSLATION_PER_X_DEGREE = 0.0014
const HEAD_TRANSLATION_PER_Y_DEGREE = 0.0011
const HEAD_ROTATION_SCALE = Math.PI / 180
const EYE_GAZE_X_TRANSLATION = 0.018
const EYE_GAZE_Y_TRANSLATION = 0.013
const MOUSE_PAD_TRAVEL_X = 0.085
const MOUSE_PAD_TRAVEL_Y = 0.055
const MOUSE_ARM_MIN_SCALE = 0.98
const MOUSE_ARM_MAX_SCALE = 1.035
const MOUSE_ARM_MAX_ROTATION = 7 * Math.PI / 180
const BLINK_FIRST_MIN_DELAY_MS = 900
const BLINK_FIRST_DELAY_VARIANCE_MS = 1_200
const BLINK_MIN_DELAY_MS = 2_800
const BLINK_DELAY_VARIANCE_MS = 3_800
const BLINK_CLOSE_MS = 68
const BLINK_HOLD_MS = 58
const BLINK_OPEN_MS = 96
const BLINK_DOUBLE_PAUSE_MS = 82
const BLINK_DOUBLE_CHANCE = 0.14

class Live2DAdapterError extends Error {
  constructor(
    readonly code: ModelDiagnosticCode,
    message: string,
    readonly asset?: string,
  ) {
    super(message)
    this.name = 'Live2DAdapterError'
  }
}

export function useLive2D(
  host: Ref<HTMLElement | null>,
  canvas: Ref<HTMLCanvasElement | null>,
  modelPath: Ref<string>,
  inputs: Live2DInputs,
) {
  const loaded = ref(false)
  const status = ref('等待模型')
  const diagnostics = ref<ModelDiagnostic[]>([])
  const headPose = ref<HeadPose>({ ...NEUTRAL_HEAD_POSE })
  const defaultScale = ref(1)
  const characterScale = inputs.scale ?? defaultScale

  const parameterRanges = new Map<string, ParameterRange>()
  const availableMotionGroups = new Set<string>()
  const availableExpressions = new Set<string>()

  let app: Application | undefined
  let sprite: Live2DSprite | undefined
  let resizeObserver: ResizeObserver | undefined
  let dprMediaQuery: MediaQueryList | undefined
  let layoutFrame: number | undefined
  let abortController: AbortController | undefined
  let generation = 0
  let initialized = false
  let headPoseFrom: HeadPose = { ...NEUTRAL_HEAD_POSE }
  let headPoseTo: HeadPose = { ...NEUTRAL_HEAD_POSE }
  let headPoseStartedAt = 0
  let spriteBaseX = 0
  let spriteBaseY = 0
  let blinkOpen = 1
  let blinkTimer: number | undefined
  let blinkFrame: number | undefined

  function projectedBlinkOpen() {
    return blinkOpen
  }

  function stopBlinking() {
    if (blinkTimer !== undefined) {
      window.clearTimeout(blinkTimer)
      blinkTimer = undefined
    }
    if (blinkFrame !== undefined) {
      window.cancelAnimationFrame(blinkFrame)
      blinkFrame = undefined
    }
    blinkOpen = 1
    clearBlinkParameterOverrides()
  }

  function expressionEyeOpen() {
    switch (inputs.expression.value.name) {
      case 'Wink':
        return { left: 1, right: 0 }
      case 'Sleepy':
        return { left: 0, right: 0 }
      default:
        return { left: 1, right: 1 }
    }
  }

  function applyBlinkParameters() {
    const expressionOpen = expressionEyeOpen()
    setParameter(PARAMETER_IDS.eyeLOpen, expressionOpen.left * blinkOpen)
    setParameter(PARAMETER_IDS.eyeROpen, expressionOpen.right * blinkOpen)
  }

  function clearBlinkParameterOverrides() {
    if (!sprite) return
    const spriteRecord = sprite as unknown as Record<string, unknown>
    const liveModel = spriteRecord._model
    if (!isRecord(liveModel)) return
    const overrides = liveModel._parameterOverrides
    if (!isRecord(overrides) || !(overrides._byId instanceof Map)) return
    overrides._byId.delete(PARAMETER_IDS.eyeLOpen)
    overrides._byId.delete(PARAMETER_IDS.eyeROpen)
  }

  function blinkPulse(elapsed: number) {
    if (elapsed < BLINK_CLOSE_MS) {
      const progress = Math.min(Math.max(elapsed / BLINK_CLOSE_MS, 0), 1)
      return 1 - smoothstep(progress)
    }
    if (elapsed < BLINK_CLOSE_MS + BLINK_HOLD_MS) return 0
    const openingElapsed = elapsed - BLINK_CLOSE_MS - BLINK_HOLD_MS
    const progress = Math.min(Math.max(openingElapsed / BLINK_OPEN_MS, 0), 1)
    return smoothstep(progress)
  }

  function scheduleNextBlink(run: number, first = false) {
    if (run !== generation || !sprite || !app) return
    const delay = first
      ? BLINK_FIRST_MIN_DELAY_MS + Math.random() * BLINK_FIRST_DELAY_VARIANCE_MS
      : BLINK_MIN_DELAY_MS + Math.random() * BLINK_DELAY_VARIANCE_MS
    blinkTimer = window.setTimeout(() => runBlink(run), delay)
  }

  function runBlink(run: number) {
    if (run !== generation || !sprite || !app) return
    blinkTimer = undefined
    const doubleBlink = Math.random() < BLINK_DOUBLE_CHANCE
    const pulseDuration = BLINK_CLOSE_MS + BLINK_HOLD_MS + BLINK_OPEN_MS
    const secondPulseAt = pulseDuration + BLINK_DOUBLE_PAUSE_MS
    const sequenceDuration = doubleBlink
      ? secondPulseAt + pulseDuration
      : pulseDuration
    const startedAt = performance.now()

    const animate = (now: number) => {
      if (run !== generation || !sprite || !app) {
        blinkFrame = undefined
        blinkOpen = 1
        return
      }
      const elapsed = now - startedAt
      blinkOpen = doubleBlink && elapsed >= secondPulseAt
        ? blinkPulse(elapsed - secondPulseAt)
        : blinkPulse(elapsed)
      applyBlinkParameters()
      app.render()
      if (elapsed < sequenceDuration) {
        blinkFrame = window.requestAnimationFrame(animate)
        return
      }
      blinkFrame = undefined
      blinkOpen = 1
      applyBlinkParameters()
      app.render()
      clearBlinkParameterOverrides()
      scheduleNextBlink(run)
    }
    blinkFrame = window.requestAnimationFrame(animate)
  }

  function expressionHeadPose(now = performance.now()): HeadPose {
    const progress = Math.min(Math.max(
      (now - headPoseStartedAt) / EXPRESSION_HEAD_TRANSITION_MS,
      0,
    ), 1)
    const eased = 1 - (1 - progress) ** 3
    return {
      x: headPoseFrom.x + (headPoseTo.x - headPoseFrom.x) * eased,
      y: headPoseFrom.y + (headPoseTo.y - headPoseFrom.y) * eased,
      z: headPoseFrom.z + (headPoseTo.z - headPoseFrom.z) * eased,
    }
  }

  function targetExpressionHeadPose(target: ExpressionTarget): HeadPose {
    const pose = EXPRESSION_HEAD_POSES[target.name]
    const intensity = Math.min(Math.max(target.intensity, 0), 1)
    return {
      x: pose.x * intensity,
      y: pose.y * intensity,
      z: pose.z * intensity,
    }
  }

  function setExpressionHeadPose(target: ExpressionTarget) {
    const now = performance.now()
    headPoseFrom = expressionHeadPose(now)
    headPoseTo = targetExpressionHeadPose(target)
    headPoseStartedAt = now
  }

  function projectedHeadPose(): HeadPose {
    const expressionPose = expressionHeadPose()
    const mouse = inputs.mouseHand.value
    const next = {
      x: expressionPose.x + mouse.x * POINTER_HEAD_X_DEGREES,
      y: expressionPose.y + mouse.y * POINTER_HEAD_Y_DEGREES,
      z: expressionPose.z + mouse.x * POINTER_HEAD_Z_DEGREES,
    }
    if (
      Math.abs(next.x - headPose.value.x) > 0.001
      || Math.abs(next.y - headPose.value.y) > 0.001
      || Math.abs(next.z - headPose.value.z) > 0.001
    ) {
      headPose.value = next
    }
    return next
  }

  function projectedEyeGaze(): EyeGaze {
    const mouse = inputs.mouseHand.value
    return {
      x: mouse.gazeX * EYE_GAZE_X_TRANSLATION,
      // Normalized display coordinates use positive Y for downward movement while
      // Cubism model vertices use positive Y upward.
      y: -mouse.gazeY * EYE_GAZE_Y_TRANSLATION,
    }
  }

  function projectedMouseAssemblyOffset(): MouseAssemblyOffset {
    const mouse = inputs.mouseHand.value
    let x = Number.isFinite(mouse.gazeX) ? mouse.gazeX : 0
    let y = Number.isFinite(mouse.gazeY) ? mouse.gazeY : 0
    const magnitude = Math.hypot(x, y)
    if (magnitude > 1) {
      x /= magnitude
      y /= magnitude
    }
    return {
      x: x * MOUSE_PAD_TRAVEL_X,
      // Display coordinates increase downward; Cubism model Y increases up.
      y: -y * MOUSE_PAD_TRAVEL_Y,
    }
  }

  function addDiagnostic(next: ModelDiagnostic) {
    const key = diagnosticKey(next)
    if (diagnostics.value.some(item => diagnosticKey(item) === key)) return
    diagnostics.value = [...diagnostics.value, next]
  }

  function addRuntimeDiagnostic(
    code: ModelDiagnosticCode,
    message: string,
    severity: 'error' | 'warning' = 'error',
    asset?: string,
  ) {
    addDiagnostic({
      code,
      severity,
      message,
      blocking: false,
      ...(asset ? { asset } : {}),
    })
    if (loaded.value) refreshReadyStatus()
  }

  function refreshReadyStatus() {
    const errors = diagnostics.value.filter(item => item.severity === 'error')
    const warnings = diagnostics.value.filter(item => item.severity === 'warning')
    if (errors.length) {
      status.value = `Live2D 已就绪（${errors.length} 项模型契约问题）`
    } else if (warnings.length) {
      status.value = `Live2D 已就绪（${warnings.length} 项提示）`
    } else {
      status.value = 'Live2D 已就绪'
    }
  }

  function applyParameterTargets() {
    if (!sprite || parameterRanges.size === 0) return
    const keyboard = inputs.keyboardHand.value
    const mouse = inputs.mouseHand.value
    const keyZoneTarget = keyboard.zone === 'right'
      ? 0.6
      : keyboard.zone === 'enter'
        ? 1
        : keyboard.zone === 'backspace'
          ? 0.8
          : keyboard.zoneValue

    // The generic right zone and its two special keys share the physical side
    // of the keyboard, but use slightly different landing points so Enter and
    // Backspace remain visually distinguishable.
    setParameter(PARAMETER_IDS.keyZone, keyZoneTarget)
    setParameter(
      PARAMETER_IDS.keyPress,
      Math.max(keyboard.pulse, keyboard.press * 0.3),
    )
    setParameter(PARAMETER_IDS.spacePress, keyboard.spacePress)
    setParameter(PARAMETER_IDS.enterPress, keyboard.enterPress)
    setParameter(PARAMETER_IDS.backspacePress, keyboard.backspacePress)

    // Position is projected from the normalized on-screen pointer location so
    // the right hand and physical mouse stay together on the mouse pad. Keep
    // the source deformation neutral to avoid applying the movement twice.
    setParameter(PARAMETER_IDS.mouseX, 0)
    setParameter(PARAMETER_IDS.mouseY, 0)
    setParameter(PARAMETER_IDS.mouseLeft, mouse.leftClick)
    setParameter(PARAMETER_IDS.mouseRight, mouse.rightClick)
    setParameter(PARAMETER_IDS.mouseWheel, mouse.wheel)

    // Hand/head impulses stay deliberately quantized. Eye tracking separately
    // uses a normalized display-relative position and never receives raw
    // desktop coordinates.
    const gazeMagnitude = Math.min(Math.max(
      Math.abs(mouse.x),
      Math.abs(mouse.y),
    ), 1)
    // The source EyeBall keyforms are too subtle to survive the compact pet
    // scale. Keep them neutral and move the complete iris/pupil/highlight
    // groups together in the renderer projection below.
    setParameter(PARAMETER_IDS.eyeX, 0)
    setParameter(PARAMETER_IDS.eyeY, 0)
    // The source angle meshes deform only isolated facial pieces. That made
    // eyelids tear away while hair stayed behind. Keep the Cubism mesh in its
    // clean neutral keyform and apply one coherent renderer-side head pose to
    // every head drawable instead. These persistent overrides run after
    // motions, expressions and physics on every easy-live2d update.
    setParameter(PARAMETER_IDS.angleX, 0)
    setParameter(PARAMETER_IDS.angleY, 0)
    setParameter(PARAMETER_IDS.angleZ, 0)
    // Physics used to deform the five front-hair bands independently, which
    // exposed their authored boundaries as a split. Pin the shared source
    // parameter to its neutral keyform so they remain one continuous fringe.
    setParameter(PARAMETER_IDS.hairFront, 0)
    setParameter(
      PARAMETER_IDS.bodyAngleX,
      mouse.x * 1.4,
      gazeMagnitude * 0.22,
    )
  }

  function setParameter(id: string, value: number, weight = 1) {
    if (!sprite) return
    const range = parameterRanges.get(id)
    if (!range || !Number.isFinite(value)) return
    const spec = PARAMETER_SPECS.get(id)
    const intersectionMinimum = Math.max(range.min, spec?.min ?? range.min)
    const intersectionMaximum = Math.min(range.max, spec?.max ?? range.max)
    const [minimum, maximum] = intersectionMinimum <= intersectionMaximum
      ? [intersectionMinimum, intersectionMaximum]
      : [range.min, range.max]
    sprite.setParameterValueById(
      id,
      Math.min(Math.max(value, minimum), maximum),
      Math.min(Math.max(weight, 0), 1),
    )
  }

  function applyExpression(target = inputs.expression.value) {
    setExpressionHeadPose(target)
    if (!sprite || !availableExpressions.has(target.name)) return
    try {
      sprite.setExpression({ expressionId: target.name })
    } catch {
      addRuntimeDiagnostic(
        'expression-name-mismatch',
        `无法切换表情：${target.name}`,
        'warning',
        target.name,
      )
    }
  }

  async function applyLongMotion(target = inputs.longMotion.value) {
    const activeSprite = sprite
    const activeGeneration = generation
    if (!activeSprite || !availableMotionGroups.has(target.name)) return
    try {
      const { Priority } = await import('easy-live2d')
      if (
        sprite !== activeSprite
        || generation !== activeGeneration
        || !availableMotionGroups.has(target.name)
      ) return
      await activeSprite.startMotion({
        group: target.name,
        no: 0,
        priority: Priority.Force,
      })
    } catch {
      addRuntimeDiagnostic(
        'motion-name-mismatch',
        `无法播放动作：${target.name}`,
        'warning',
        target.name,
      )
    }
  }

  function measureStage() {
    const currentHost = host.value
    const currentCanvas = canvas.value
    if (!currentHost || !currentCanvas) return { width: 1, height: 1 }
    const style = window.getComputedStyle(currentCanvas)
    const horizontalInset = cssPixels(style.left) + cssPixels(style.right)
    const verticalInset = cssPixels(style.top) + cssPixels(style.bottom)
    return {
      width: Math.max(1, currentHost.clientWidth - horizontalInset),
      height: Math.max(1, currentHost.clientHeight - verticalInset),
    }
  }

  function layoutModel() {
    if (!app || !sprite) return
    const { width, height } = measureStage()
    const resolution = renderResolution()
    app.renderer.resize(width, height, resolution)

    const modelSize = sprite.getModelCanvasSize()
    if (!modelSize || modelSize.width <= 0 || modelSize.height <= 0) return
    const containScale = Math.min(
      width / modelSize.width,
      height / modelSize.height,
    )
    const requestedScale = Math.min(
      Math.max(characterScale.value || 1, MIN_CHARACTER_SCALE),
      MAX_CHARACTER_SCALE,
    )
    sprite.scale.set(containScale * 0.96 * requestedScale)
    // The t004 state PSDs are the approved visual reference. Their face sits
    // slightly higher than the earlier Cubism reconstruction, so keep the
    // dynamic head aligned with the PSD eyes, mouth and collar instead of
    // letting it overlap the floating idle cuff.
    spriteBaseX = width / 2 - height * 0.015
    spriteBaseY = height / 2 - height * 0.065
    sprite.x = spriteBaseX
    sprite.y = spriteBaseY
    sprite.rotation = 0
    sprite.onResize()
  }

  function scheduleLayout() {
    if (layoutFrame !== undefined) return
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = undefined
      layoutModel()
    })
  }

  function handleDprChange() {
    armDprWatcher()
    scheduleLayout()
  }

  function armDprWatcher() {
    dprMediaQuery?.removeEventListener('change', handleDprChange)
    dprMediaQuery = window.matchMedia(
      `(resolution: ${window.devicePixelRatio || 1}dppx)`,
    )
    dprMediaQuery.addEventListener('change', handleDprChange)
  }

  function bindLayoutObservers() {
    resizeObserver?.disconnect()
    if (host.value) {
      resizeObserver = new ResizeObserver(scheduleLayout)
      resizeObserver.observe(host.value)
    }
    window.addEventListener('resize', scheduleLayout)
    armDprWatcher()
  }

  function unbindLayoutObservers() {
    resizeObserver?.disconnect()
    resizeObserver = undefined
    window.removeEventListener('resize', scheduleLayout)
    dprMediaQuery?.removeEventListener('change', handleDprChange)
    dprMediaQuery = undefined
    if (layoutFrame !== undefined) {
      window.cancelAnimationFrame(layoutFrame)
      layoutFrame = undefined
    }
  }

  function destroyRenderer() {
    stopBlinking()
    unbindLayoutObservers()
    loaded.value = false
    parameterRanges.clear()
    availableMotionGroups.clear()
    availableExpressions.clear()
    headPoseFrom = { ...NEUTRAL_HEAD_POSE }
    headPoseTo = { ...NEUTRAL_HEAD_POSE }
    headPoseStartedAt = performance.now()
    headPose.value = { ...NEUTRAL_HEAD_POSE }
    try {
      sprite?.destroy()
    } catch {
      // Best-effort cleanup after a partially initialized Cubism model.
    }
    sprite = undefined
    try {
      app?.destroy()
    } catch {
      // Pixi may itself be only partially initialized.
    }
    app = undefined
  }

  async function init() {
    initialized = true
    const run = ++generation
    abortController?.abort()
    abortController = new AbortController()
    const { signal } = abortController
    destroyRenderer()
    diagnostics.value = []

    if (!host.value || !canvas.value) {
      status.value = 'Live2D 画布尚未就绪'
      abortController = undefined
      return
    }

    status.value = '检查 Live2D 模型…'
    try {
      const [contractResult, coreDiagnostic] = await Promise.all([
        preflightModelContract(
          modelPath.value,
          parameterMap.motions,
          parameterMap.expressions,
          signal,
        ),
        probeCubismCore(signal),
      ])
      if (run !== generation) return

      diagnostics.value = [
        ...contractResult.diagnostics,
        ...(coreDiagnostic ? [coreDiagnostic] : []),
      ]
      if (
        !contractResult.contract
        || diagnostics.value.some(isBlockingDiagnostic)
      ) {
        status.value = primaryDiagnosticStatus(diagnostics.value)
        abortController = undefined
        return
      }

      status.value = '加载 Live2D…'
      await loadCoreScript(signal)
      if (run !== generation) return

      const [
        { Application, Ticker },
        { Config, CubismSetting, Live2DSprite },
      ] = await Promise.all([
        import('pixi.js'),
        import('easy-live2d'),
      ])
      if (run !== generation) return

      Config.MouseFollow = false
      Config.MotionSound = false

      const stageSize = measureStage()
      const pixi = new Application()
      try {
        await pixi.init({
          canvas: canvas.value,
          width: stageSize.width,
          height: stageSize.height,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          preference: 'webgl',
          preserveDrawingBuffer: true,
          resolution: renderResolution(),
        })
      } catch {
        try {
          pixi.destroy()
        } catch {
          // Nothing else to release.
        }
        throw new Live2DAdapterError('renderer-failed', 'Live2D 渲染器初始化失败')
      }
      if (run !== generation) {
        pixi.destroy()
        return
      }
      app = pixi

      const setting = createRestrictedModelSetting(
        contractResult.contract,
        CubismSetting,
      )
      const model = new Live2DSprite({
        modelSetting: setting,
        ticker: Ticker.shared,
        draggable: false,
      })
      sprite = model
      model.anchor.set(0.5)
      model.onLive2D('hit', () => inputs.onPoke?.())
      pixi.stage.addChild(model)

      // WKWebView may throttle the shared ticker while this transparent,
      // non-activating desktop window starts behind another app. easy-live2d
      // begins loading from its first onRender callback, so explicitly render
      // one frame to start model I/O without stealing focus from the user.
      pixi.render()

      await withTimeout(
        model.ready,
        MODEL_READY_TIMEOUT_MS,
        () => new Live2DAdapterError(
          'model-ready-timeout',
          'Live2D 模型加载超时，已使用预览角色',
        ),
        signal,
      )
      if (run !== generation) return
      if (!model.getModelCanvasSize()) {
        throw new Live2DAdapterError(
          'model-initialization-failed',
          'Live2D 模型初始化失败，已使用预览角色',
        )
      }

      validateRuntimeContract(model)
      installTakagiModelProjection(
        model,
        projectedHeadPose,
        projectedEyeGaze,
        projectedMouseAssemblyOffset,
        projectedBlinkOpen,
      )
      bindLayoutObservers()
      layoutModel()
      applyParameterTargets()
      applyExpression()
      void applyLongMotion()
      loaded.value = true
      refreshReadyStatus()
      scheduleNextBlink(run, true)

      // The first explicit frame above starts easy-live2d's asynchronous
      // model loader. In a transparent, non-activating WKWebView the normal
      // requestAnimationFrame loop can remain throttled after `model.ready`,
      // leaving the canvas on that empty loading frame. Restart the ticker and
      // draw the first ready frame synchronously; subsequent input and motion
      // updates continue through the application ticker.
      await nextTick()
      if (run !== generation || app !== pixi || sprite !== model) return
      pixi.start()
      pixi.render()
      abortController = undefined
    } catch (reason) {
      if (run !== generation || isAbortError(reason)) return
      const error = reason instanceof Live2DAdapterError
        ? reason
        : new Live2DAdapterError(
            'model-initialization-failed',
            reason instanceof Error
              ? `Live2D 加载失败：${reason.message}`
              : 'Live2D 加载失败，已使用预览角色',
          )
      addDiagnostic({
        code: error.code,
        severity: 'error',
        message: error.message,
        blocking: true,
        ...(error.asset ? { asset: error.asset } : {}),
      })
      destroyRenderer()
      status.value = primaryDiagnosticStatus(diagnostics.value)
      abortController = undefined
    }
  }

  function validateRuntimeContract(model: Live2DSprite) {
    for (const spec of parameterMap.parameters) {
      const range = model.getParameterValueRangeById(spec.id)
      if (!range) {
        addDiagnostic({
          code: 'parameter-name-mismatch',
          severity: 'error',
          message: `缺少模型参数：${spec.id}`,
          blocking: false,
          asset: spec.id,
        })
        continue
      }
      parameterRanges.set(spec.id, range)
      if (range.min > spec.min || range.max < spec.max) {
        addDiagnostic({
          code: 'parameter-range-mismatch',
          severity: 'warning',
          message: `参数范围不匹配：${spec.id}`,
          blocking: false,
          asset: spec.id,
          expected: [`${spec.min}..${spec.max}`],
          actual: [`${range.min}..${range.max}`],
        })
      }
    }

    const motions = model.getMotions()
    motions.forEach(motion => availableMotionGroups.add(motion.group))
    const missingMotions = parameterMap.motions
      .filter(name => !availableMotionGroups.has(name))
    if (missingMotions.length) {
      addDiagnostic({
        code: 'motion-name-mismatch',
        severity: 'warning',
        message: `动作名称不匹配：${missingMotions.join('、')}`,
        blocking: false,
        expected: [...parameterMap.motions],
        actual: [...availableMotionGroups],
      })
    }

    const expressions = model.getExpressions()
    expressions.forEach(item => availableExpressions.add(item.name))
    const missingExpressions = parameterMap.expressions
      .filter(name => !availableExpressions.has(name))
    if (missingExpressions.length) {
      addDiagnostic({
        code: 'expression-name-mismatch',
        severity: 'warning',
        message: `表情名称不匹配：${missingExpressions.join('、')}`,
        blocking: false,
        expected: [...parameterMap.expressions],
        actual: [...availableExpressions],
      })
    }
  }

  const stopParameterWatch = watch(
    [inputs.keyboardHand, inputs.mouseHand],
    applyParameterTargets,
  )
  const stopExpressionWatch = watch(
    () => inputs.expression.value.revision,
    () => applyExpression(),
  )
  const stopLongMotionWatch = watch(
    () => inputs.longMotion.value.revision,
    () => void applyLongMotion(),
  )
  const stopScaleWatch = watch(characterScale, scheduleLayout)
  const stopModelPathWatch = watch(modelPath, (next, previous) => {
    if (initialized && next !== previous) void init()
  })

  onBeforeUnmount(() => {
    generation += 1
    abortController?.abort()
    abortController = undefined
    stopParameterWatch()
    stopExpressionWatch()
    stopLongMotionWatch()
    stopScaleWatch()
    stopModelPathWatch()
    destroyRenderer()
  })

  return {
    diagnostics,
    headPose,
    init,
    loaded,
    status,
  }
}

function createRestrictedModelSetting(
  contract: ModelContract,
  CubismSetting: typeof import('easy-live2d')['CubismSetting'],
) {
  const setting = new CubismSetting({
    modelJSON: contract.modelJson,
    prefixPath: contract.modelDirectoryUrl,
  })
  setting.redirectPath(({ file }) =>
    resolveLocalModelAssetUrl(file, contract.modelDirectoryUrl).href)
  return setting
}

async function loadCoreScript(signal: AbortSignal): Promise<void> {
  const coreWindow = window as Window & { Live2DCubismCore?: unknown }
  if (coreWindow.Live2DCubismCore) {
    installCubism53FrameworkCompatibility(coreWindow.Live2DCubismCore)
    return
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

  document.getElementById(CORE_SCRIPT_ID)?.remove()
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.id = CORE_SCRIPT_ID
    script.src = CUBISM_CORE_PATH

    const finish = () => {
      signal.removeEventListener('abort', abort)
      script.onload = null
      script.onerror = null
    }
    const abort = () => {
      finish()
      script.remove()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    script.onload = () => {
      finish()
      if (coreWindow.Live2DCubismCore) {
        installCubism53FrameworkCompatibility(coreWindow.Live2DCubismCore)
        resolve()
      } else {
        script.remove()
        reject(new Live2DAdapterError(
          'core-invalid',
          'Live2D Cubism Core 文件无效',
          CUBISM_CORE_PATH,
        ))
      }
    }
    script.onerror = () => {
      finish()
      script.remove()
      reject(new Live2DAdapterError(
        'core-missing',
        '缺少 Live2D Cubism Core',
        CUBISM_CORE_PATH,
      ))
    }
    signal.addEventListener('abort', abort, { once: true })
    document.head.appendChild(script)
  })
}

/**
 * Cubism Core 5.3 moved the combined render-order array from
 * `model.drawables.renderOrders` to `model.renderOrders` so it can also
 * include offscreen surfaces. easy-live2d 0.4.4 still embeds the earlier
 * Framework accessor and reads the old drawable property.
 *
 * Keep the official Core file byte-for-byte intact and add the legacy view
 * only to model instances created by the wrapper. The drawable slice is still
 * backed by the Core-owned Int32Array, so values remain live on every frame.
 */
function installCubism53FrameworkCompatibility(coreValue: unknown) {
  if (!isRecord(coreValue)) return
  const modelConstructor = coreValue.Model
  if (!isObjectLike(modelConstructor)) return
  const originalFromMoc = modelConstructor.fromMoc
  if (typeof originalFromMoc !== 'function') return
  if (modelConstructor.__takagiRenderOrderCompatibility === true) return

  modelConstructor.fromMoc = function fromMocWithLegacyRenderOrders(
    this: unknown,
    ...args: unknown[]
  ) {
    const model = Reflect.apply(originalFromMoc, this, args)
    if (!isRecord(model) || !isRecord(model.drawables)) return model

    if (
      model.drawables.renderOrders === undefined
      && model.renderOrders instanceof Int32Array
    ) {
      const drawableCount = typeof model.drawables.count === 'number'
        ? Math.max(0, Math.trunc(model.drawables.count))
        : model.renderOrders.length
      model.drawables.renderOrders = model.renderOrders.subarray(0, drawableCount)
    }

    return model
  }
  modelConstructor.__takagiRenderOrderCompatibility = true
}

/**
 * Projects corrected drawable opacity and a coherent head transform without
 * ever mutating Cubism Core-owned WASM memory. WKWebView is stricter than
 * Chromium about those live views, so the renderer receives corrected values
 * and stable reusable vertex copies only when it asks for them.
 */
function installTakagiModelProjection(
  sprite: Live2DSprite,
  getHeadPose: () => HeadPose,
  getEyeGaze: () => EyeGaze,
  getMouseAssemblyOffset: () => MouseAssemblyOffset,
  getBlinkOpen: () => number,
) {
  const spriteRecord = sprite as unknown as Record<string, unknown>
  const liveModel = spriteRecord._model
  if (!isRecord(liveModel) || typeof liveModel.getModel !== 'function') return
  const cubismModel = Reflect.apply(liveModel.getModel, liveModel, [])
  if (!isRecord(cubismModel) || cubismModel.__takagiModelProjection === true) {
    return
  }
  const coreModel = cubismModel._model
  if (
    !isRecord(coreModel)
    || !isRecord(coreModel.drawables)
    || !isRecord(coreModel.parameters)
  ) return
  const drawableIds = readStringArrayLike(coreModel.drawables.ids)
  const parameterIds = readStringArrayLike(coreModel.parameters.ids)
  const parameterValues = coreModel.parameters.values
  const originalGetOpacity = cubismModel.getDrawableOpacity
  const originalGetVertices = cubismModel.getDrawableVertices
  const originalGetVisibility = cubismModel.getDrawableDynamicFlagIsVisible
  if (
    !(parameterValues instanceof Float32Array)
    || typeof originalGetOpacity !== 'function'
    || typeof originalGetVertices !== 'function'
    || typeof originalGetVisibility !== 'function'
  ) return

  const alwaysHiddenIndices = new Set(
    [...ALWAYS_HIDDEN_DRAWABLE_IDS]
      .map(id => drawableIds.indexOf(id))
      .filter(index => index >= 0),
  )
  const closedEyeBindings = new Map(
    CLOSED_EYE_DRAWABLES
      .map(({ drawableId, parameterId }) => [
        drawableIds.indexOf(drawableId),
        parameterIds.indexOf(parameterId),
      ] as const)
      .filter(([drawableIndex, parameterIndex]) => (
        drawableIndex >= 0 && parameterIndex >= 0
      )),
  )
  const openEyeBindings = new Map(
    OPEN_EYE_DRAWABLES
      .map(({ drawableId, parameterId }) => [
        drawableIds.indexOf(drawableId),
        parameterIds.indexOf(parameterId),
      ] as const)
      .filter(([drawableIndex, parameterIndex]) => (
        drawableIndex >= 0 && parameterIndex >= 0
      )),
  )
  const headIndices = new Set(
    [...HEAD_DRAWABLE_IDS]
      .map(id => drawableIds.indexOf(id))
      .filter(index => index >= 0),
  )
  const eyeGazeIndices = new Set(
    [...EYE_GAZE_DRAWABLE_IDS]
      .map(id => drawableIds.indexOf(id))
      .filter(index => index >= 0),
  )
  const mouseAssemblyIndices = new Set(
    [...MOUSE_ASSEMBLY_DRAWABLE_IDS]
      .map(id => drawableIds.indexOf(id))
      .filter(index => index >= 0),
  )
  let anchoredMouseArm: AnchoredMouseArmProjection | undefined
  const mouseArmIndex = drawableIds.indexOf('screen_right_mouse_hand')
  const mouseSleeveIndex = drawableIds.indexOf('sleeve_screen_right')
  if (mouseArmIndex >= 0) {
    const neutralHandVertices = copyFloat32Array(Reflect.apply(
      originalGetVertices,
      cubismModel,
      [mouseArmIndex],
    ))
    const neutralSleeveVertices = mouseSleeveIndex >= 0
      ? copyFloat32Array(Reflect.apply(
          originalGetVertices,
          cubismModel,
          [mouseSleeveIndex],
        ))
      : undefined
    const rootVertices = neutralSleeveVertices ?? neutralHandVertices
    const root = rootVertices
      ? extremeXCentroid(rootVertices, 'min', 0.14)
      : undefined
    const hand = neutralHandVertices
      ? extremeXCentroid(neutralHandVertices, 'max', 0.2)
      : undefined
    if (root && hand) {
      anchoredMouseArm = {
        drawableIndices: new Set(
          [...MOUSE_ARM_DRAWABLE_IDS]
            .map(id => drawableIds.indexOf(id))
            .filter(index => index >= 0),
        ),
        root,
        hand,
      }
    }
  }

  function projectedMouseArmPose(): MouseArmPose {
    const desired = getMouseAssemblyOffset()
    const desiredX = Number.isFinite(desired.x) ? desired.x : 0
    const desiredY = Number.isFinite(desired.y) ? desired.y : 0
    if (!anchoredMouseArm) {
      return {
        a: 1,
        b: 0,
        rootX: 0,
        rootY: 0,
        offsetX: desiredX,
        offsetY: desiredY,
      }
    }

    const vectorX = anchoredMouseArm.hand.x - anchoredMouseArm.root.x
    const vectorY = anchoredMouseArm.hand.y - anchoredMouseArm.root.y
    const lengthSquared = vectorX * vectorX + vectorY * vectorY
    if (lengthSquared <= Number.EPSILON) {
      return {
        a: 1,
        b: 0,
        rootX: anchoredMouseArm.root.x,
        rootY: anchoredMouseArm.root.y,
        offsetX: 0,
        offsetY: 0,
      }
    }

    const targetX = vectorX + desiredX
    const targetY = vectorY + desiredY
    const desiredScale = Math.sqrt(
      (targetX * targetX + targetY * targetY) / lengthSquared,
    )
    const desiredRotation = Math.atan2(
      vectorX * targetY - vectorY * targetX,
      vectorX * targetX + vectorY * targetY,
    )
    const scale = Math.min(Math.max(
      desiredScale,
      MOUSE_ARM_MIN_SCALE,
    ), MOUSE_ARM_MAX_SCALE)
    const rotation = Math.min(Math.max(
      desiredRotation,
      -MOUSE_ARM_MAX_ROTATION,
    ), MOUSE_ARM_MAX_ROTATION)
    const a = scale * Math.cos(rotation)
    const b = scale * Math.sin(rotation)
    const movedHandX = anchoredMouseArm.root.x
      + a * vectorX - b * vectorY
    const movedHandY = anchoredMouseArm.root.y
      + b * vectorX + a * vectorY
    return {
      a,
      b,
      rootX: anchoredMouseArm.root.x,
      rootY: anchoredMouseArm.root.y,
      offsetX: movedHandX - anchoredMouseArm.hand.x,
      offsetY: movedHandY - anchoredMouseArm.hand.y,
    }
  }
  cubismModel.getDrawableDynamicFlagIsVisible = function getProjectedTakagiVisibility(
    this: unknown,
    drawableIndex: number,
  ) {
    const eyeOpenIndex = closedEyeBindings.get(drawableIndex)
    if (eyeOpenIndex !== undefined) {
      const eyeOpen = Math.min(
        parameterValues[eyeOpenIndex],
        clampUnitValue(getBlinkOpen()),
      )
      if (Number.isFinite(eyeOpen) && eyeOpen < 0.35) return true
    }
    return Boolean(Reflect.apply(
      originalGetVisibility,
      this,
      [drawableIndex],
    ))
  }
  cubismModel.getDrawableOpacity = function getProjectedTakagiOpacity(
    this: unknown,
    drawableIndex: number,
  ) {
    if (alwaysHiddenIndices.has(drawableIndex)) return 0
    const eyeOpenIndex = closedEyeBindings.get(drawableIndex)
    if (eyeOpenIndex !== undefined) {
      const eyeOpen = Math.min(
        parameterValues[eyeOpenIndex],
        clampUnitValue(getBlinkOpen()),
      )
      if (Number.isFinite(eyeOpen)) {
        // Keep the alternate closed-eye stroke out of ordinary squints. It
        // should fade in only near a real blink/wink; a linear `1-eyeOpen`
        // blend leaves a visible dark duplicate around TeaseSmile (0.86/0.92).
        return Math.min(Math.max((0.35 - eyeOpen) / 0.25, 0), 1)
      }
    }
    const reflectedOpacity = Reflect.apply(
      originalGetOpacity,
      this,
      [drawableIndex],
    )
    const originalOpacity = typeof reflectedOpacity === 'number'
      ? reflectedOpacity
      : 0
    const openEyeIndex = openEyeBindings.get(drawableIndex)
    if (openEyeIndex !== undefined) {
      const eyeOpen = Math.min(
        parameterValues[openEyeIndex],
        clampUnitValue(getBlinkOpen()),
      )
      if (Number.isFinite(eyeOpen)) {
        const visible = Math.min(Math.max((eyeOpen - 0.3) / 0.5, 0), 1)
        return originalOpacity * smoothstep(visible)
      }
    }
    return originalOpacity
  }

  const projectedVertices = new Map<number, Float32Array>()
  cubismModel.getDrawableVertices = function getProjectedTakagiVertices(
    this: unknown,
    drawableIndex: number,
  ) {
    const source = Reflect.apply(originalGetVertices, this, [drawableIndex])
    if (!(source instanceof Float32Array)) {
      return source
    }

    const projectsHead = headIndices.has(drawableIndex)
    const projectsEyeGaze = eyeGazeIndices.has(drawableIndex)
    const projectsMouseAssembly = mouseAssemblyIndices.has(drawableIndex)
    const projectsBlink = openEyeBindings.has(drawableIndex)
    const projectsAnchoredMouseArm = Boolean(
      anchoredMouseArm?.drawableIndices.has(drawableIndex),
    )
    if (
      !projectsHead
      && !projectsEyeGaze
      && !projectsMouseAssembly
      && !projectsBlink
      && !projectsAnchoredMouseArm
    ) return source

    const headPose = getHeadPose()
    const angleX = Number.isFinite(headPose.x) ? headPose.x : 0
    const angleY = Number.isFinite(headPose.y) ? headPose.y : 0
    const angleZ = Number.isFinite(headPose.z) ? headPose.z : 0
    const radians = projectsHead ? angleZ * HEAD_ROTATION_SCALE : 0
    const translateX = projectsHead
      ? angleX * HEAD_TRANSLATION_PER_X_DEGREE
      : 0
    const translateY = projectsHead
      ? angleY * HEAD_TRANSLATION_PER_Y_DEGREE
      : 0
    const gaze = projectsEyeGaze ? getEyeGaze() : { x: 0, y: 0 }
    const gazeX = Number.isFinite(gaze.x) ? gaze.x : 0
    const gazeY = Number.isFinite(gaze.y) ? gaze.y : 0

    let output = projectedVertices.get(drawableIndex)
    if (!output || output.length !== source.length) {
      output = new Float32Array(source.length)
      projectedVertices.set(drawableIndex, output)
    }
    output.set(source)

    if (projectsBlink) {
      const eyeOpenIndex = openEyeBindings.get(drawableIndex)
      const parameterOpen = eyeOpenIndex === undefined
        ? 1
        : clampUnitValue(parameterValues[eyeOpenIndex])
      const effectiveOpen = Math.min(parameterOpen, clampUnitValue(getBlinkOpen()))
      projectBlink(output, effectiveOpen)
    }

    if (projectsHead) {
      const cosine = Math.cos(radians)
      const sine = Math.sin(radians)
      for (let index = 0; index < output.length; index += 2) {
        const x = output[index] - HEAD_PIVOT_X
        const y = output[index + 1] - HEAD_PIVOT_Y
        output[index] = HEAD_PIVOT_X + x * cosine - y * sine + translateX
        output[index + 1] = HEAD_PIVOT_Y + x * sine + y * cosine + translateY
      }
    }

    if (projectsEyeGaze) {
      for (let index = 0; index < output.length; index += 2) {
        output[index] += gazeX
        output[index + 1] += gazeY
      }
    }

    if (projectsAnchoredMouseArm && anchoredMouseArm) {
      const pose = projectedMouseArmPose()
      for (let index = 0; index < output.length; index += 2) {
        const x = output[index] - pose.rootX
        const y = output[index + 1] - pose.rootY
        output[index] = pose.rootX + pose.a * x - pose.b * y
        output[index + 1] = pose.rootY + pose.b * x + pose.a * y
      }
    }

    if (projectsMouseAssembly) {
      const pose = projectedMouseArmPose()
      for (let index = 0; index < output.length; index += 2) {
        output[index] += pose.offsetX
        output[index + 1] += pose.offsetY
      }
    }
    return output
  }
  cubismModel.__takagiModelProjection = true
}

function projectBlink(vertices: Float32Array, eyeOpen: number) {
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let index = 1; index < vertices.length; index += 2) {
    minY = Math.min(minY, vertices[index])
    maxY = Math.max(maxY, vertices[index])
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return
  const centerY = (minY + maxY) / 2
  const verticalScale = 0.14 + 0.86 * smoothstep(clampUnitValue(eyeOpen))
  for (let index = 1; index < vertices.length; index += 2) {
    vertices[index] = centerY + (vertices[index] - centerY) * verticalScale
  }
}

function clampUnitValue(value: number) {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 1
}

function smoothstep(value: number) {
  const unit = clampUnitValue(value)
  return unit * unit * (3 - 2 * unit)
}

function copyFloat32Array(value: unknown): Float32Array | undefined {
  return value instanceof Float32Array ? new Float32Array(value) : undefined
}

function extremeXCentroid(
  vertices: Float32Array,
  side: 'min' | 'max',
  fraction: number,
) {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  for (let index = 0; index < vertices.length; index += 2) {
    minX = Math.min(minX, vertices[index])
    maxX = Math.max(maxX, vertices[index])
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || minX === maxX) {
    return
  }
  const width = maxX - minX
  const edge = side === 'min'
    ? minX + width * fraction
    : maxX - width * fraction
  let x = 0
  let y = 0
  let count = 0
  for (let index = 0; index < vertices.length; index += 2) {
    if (
      (side === 'min' && vertices[index] <= edge)
      || (side === 'max' && vertices[index] >= edge)
    ) {
      x += vertices[index]
      y += vertices[index + 1]
      count += 1
    }
  }
  return count > 0 ? { x: x / count, y: y / count } : undefined
}

function readStringArrayLike(value: unknown): string[] {
  if (!isObjectLike(value)) return []
  const length = Reflect.get(value, 'length')
  if (typeof length !== 'number' || !Number.isFinite(length) || length < 0) {
    return []
  }
  const result: string[] = []
  for (let index = 0; index < Math.trunc(length); index += 1) {
    const item = Reflect.get(value, index)
    result.push(typeof item === 'string' ? item : '')
  }
  return result
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
  signal?: AbortSignal,
): Promise<T> {
  let timer: number | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(createError()), timeoutMs)
      }),
      ...(signal
        ? [new Promise<T>((_, reject) => {
            abort = () => reject(new DOMException('Aborted', 'AbortError'))
            if (signal.aborted) {
              abort()
            } else {
              signal.addEventListener('abort', abort, { once: true })
            }
          })]
        : []),
    ])
  } finally {
    window.clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

function renderResolution(): number {
  return Math.min(
    Math.max(window.devicePixelRatio || 1, 1),
    MAX_RENDER_RESOLUTION,
  )
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function diagnosticKey(diagnostic: ModelDiagnostic): string {
  return [
    diagnostic.code,
    diagnostic.asset ?? '',
    diagnostic.message,
  ].join('|')
}

function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null
}

function isObjectLike(value: unknown): value is Record<string, any> {
  return (typeof value === 'object' && value !== null)
    || typeof value === 'function'
}
