<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import PreviewPet from './components/PreviewPet.vue'
import { useDesktopBridge } from './composables/useDesktopBridge'
import { useLive2D } from './composables/useLive2D'
import {
  loadPetSettings,
  savePetSettings,
} from './composables/petSettings'
import { usePetBrain } from './composables/usePetBrain'
import type { PetSettings } from './types'

const host = ref<HTMLElement | null>(null)
const canvas = ref<HTMLCanvasElement | null>(null)
const settings = ref<PetSettings>(loadPetSettings())
const startupPreferences = { ...settings.value }
const desktopPreferencesApplied = ref(false)

const brain = usePetBrain(() => settings.value.sensitivity)
const bridge = useDesktopBridge(brain.handleDeviceEvent)
const modelPath = computed(() => settings.value.modelPath)
const characterScale = computed(() => settings.value.characterScale)
const live2d = useLive2D(host, canvas, modelPath, {
  keyboardHand: brain.keyboardHand,
  mouseHand: brain.mouseHand,
  expression: brain.expression,
  longMotion: brain.longMotion,
  scale: characterScale,
  onPoke: brain.poke,
})

const bubbleText = computed(() =>
  settings.value.bubbleEnabled ? brain.bubble.value : '',
)
const keyboardHandTouching = computed(() => {
  const keyboard = brain.keyboardHand.value
  return Math.max(
    keyboard.active ? 1 : 0,
    keyboard.press,
    keyboard.spacePress,
    keyboard.enterPress,
    keyboard.backspacePress,
  ) > 0.16
})
const keyboardOverlayStageStyle = computed(() => ({
  transform: live2d.loaded.value
    ? `scale(${0.96 * characterScale.value})`
    : 'scale(1)',
}))
const frontHairHeadTransform = computed(() => {
  const pose = live2d.headPose.value
  const translateX = pose.x * 0.88
  const translateY = -pose.y * 0.69
  const rotation = -pose.z
  return [
    `translate(${translateX.toFixed(3)} ${translateY.toFixed(3)})`,
    `rotate(${rotation.toFixed(3)} 600 735)`,
  ].join(' ')
})

// Keep the shoulder attachment and the key target as two separate anchors.
// Moving the shoulder therefore does not drag every key target with it: the
// complete PSD arm rotates and stretches between these two fixed points.
const keyboardShoulderOffsetX = -6
const keyboardShoulderOffsetY = -10
const keyboardTargetOffsetX = 22
const keyboardTargetOffsetY = -4
const mouseShoulderOffsetX = 30
const mouseShoulderOffsetY = -10

const keyboardArmTransform = computed(() => {
  if (!keyboardHandTouching.value) return 'translate(0 0)'
  const keyboard = brain.keyboardHand.value
  const keyX = Math.min(Math.max(keyboard.keyX, -1), 1)
  const keyY = Math.min(Math.max(keyboard.keyY, 0), 1)
  const press = Math.max(
    keyboard.press,
    keyboard.spacePress,
    keyboard.enterPress,
    keyboard.backspacePress,
  )
  // The active PSD supplies one complete shoulder-to-glove arm. Rotate and
  // scale that whole source layer around its real shoulder attachment; never
  // split the arm or translate the glove independently. Because the keyboard
  // faces the character, physical-left keys appear on the viewer's right.
  // The outer group places that attachment once; every key movement below is
  // performed around the same shoulder pivot, so the sleeve cannot drift.
  // The extracted arm's alpha starts at the white sleeve tip around
  // (502, 618). This is the actual visual attachment point; the old pivot at
  // (431, 629) sat in transparent space beside the sleeve and made the
  // shoulder appear to orbit even though its coordinate was unchanged.
  const pivotX = 502
  const pivotY = 618
  const baseEndX = 478
  const baseEndY = 850
  const baseX = baseEndX - pivotX
  const baseY = baseEndY - pivotY
  // t004 depicts a compact five-column keyboard. The backend projects the
  // pictured columns to -1, -.5, 0, .5 and 1, and the pictured rows to their
  // measured depth. Because the keyboard faces Takagi, physical-left keys
  // land on the viewer's right side, hence the subtraction below.
  const targetX = baseX
    + keyboardTargetOffsetX
    - keyboardShoulderOffsetX
    - keyX * 132
  const targetY = baseY
    + keyboardTargetOffsetY
    - keyboardShoulderOffsetY
    + (keyY - 0.45) * 92
    + press * 2
  const baseAngle = Math.atan2(baseY, baseX) * 180 / Math.PI
  const targetAngle = Math.atan2(targetY, targetX) * 180 / Math.PI
  const stretch = Math.min(Math.max(
    Math.hypot(targetX, targetY) / Math.hypot(baseX, baseY),
    0.96,
  ), 1.28)
  // Align the source arm axis to the selected key and stretch only along its
  // length. The perpendicular width stays unchanged, so the sleeve and mitten
  // do not balloon sideways while the shoulder attachment remains fixed.
  return [
    `translate(${pivotX} ${pivotY})`,
    `rotate(${targetAngle.toFixed(3)})`,
    `scale(${stretch.toFixed(4)} 1)`,
    `rotate(${(-baseAngle).toFixed(3)})`,
    `translate(${-pivotX} ${-pivotY})`,
  ].join(' ')
})
const mouseGroupTransform = computed(() => {
  const mouse = brain.mouseHand.value
  const gazeX = Math.min(Math.max(mouse.gazeX, -1), 1)
  const gazeY = Math.min(Math.max(mouse.gazeY, -1), 1)
  const click = Math.max(mouse.leftClick, mouse.rightClick)
  const clickBias = (mouse.rightClick - mouse.leftClick) * 5
  const wheelBias = mouse.wheel * 4
  // The complete mouse assembly starts at the actual top of the PSD sleeve.
  // Keeping this point fixed prevents the white shoulder from orbiting away
  // from the body while the arm, mitten and physical mouse move together.
  const pivotX = 744
  const pivotY = 612
  const baseVectorX = 174
  const baseVectorY = 318
  const targetVectorX = baseVectorX + gazeX * 18 + clickBias
  const targetVectorY = baseVectorY + gazeY * 11 + click * 2 + wheelBias
  const rotation = (
    Math.atan2(targetVectorY, targetVectorX)
    - Math.atan2(baseVectorY, baseVectorX)
  ) * 180 / Math.PI
  const scale = Math.min(Math.max(
    Math.hypot(targetVectorX, targetVectorY)
      / Math.hypot(baseVectorX, baseVectorY),
    0.992,
  ), 1.022)
  return [
    `translate(${pivotX} ${pivotY})`,
    `rotate(${rotation.toFixed(3)})`,
    `scale(${scale.toFixed(4)})`,
    `translate(${-pivotX} ${-pivotY})`,
  ].join(' ')
})

watch(settings, next => {
  savePetSettings(next)
}, { deep: true })

watch(bridge.desktopState, snapshot => {
  if (desktopPreferencesApplied.value) syncDesktopSnapshot(snapshot)
}, { deep: true })

watch(bridge.autostartEnabled, enabled => {
  if (
    desktopPreferencesApplied.value
    && bridge.autostartLoaded.value
  ) {
    settings.value = { ...settings.value, autostartEnabled: enabled }
  }
})

watch(bridge.settingsRevision, revision => {
  if (revision <= 0) return
  const next = loadPetSettings()
  settings.value = {
    ...next,
    clickThrough: bridge.desktopState.value.clickThrough,
    alwaysOnTop: bridge.desktopState.value.alwaysOnTop,
    interactionPaused: bridge.desktopState.value.interactionPaused,
    autostartEnabled: bridge.autostartEnabled.value,
  }
})

onMounted(async () => {
  await nextTick()
  await Promise.all([bridge.start(), live2d.init()])
  await applyPersistedDesktopPreferences()
})

function syncDesktopSnapshot(snapshot = bridge.desktopState.value) {
  settings.value = {
    ...settings.value,
    clickThrough: snapshot.clickThrough,
    alwaysOnTop: snapshot.alwaysOnTop,
    interactionPaused: snapshot.interactionPaused,
  }
}

async function applyPersistedDesktopPreferences() {
  if (!bridge.isDesktop.value) {
    desktopPreferencesApplied.value = true
    return
  }
  const preferred = startupPreferences
  let snapshot = bridge.desktopState.value

  if (snapshot.alwaysOnTop !== preferred.alwaysOnTop) {
    snapshot = await bridge.setAlwaysOnTop(preferred.alwaysOnTop)
  }
  if (snapshot.interactionPaused !== preferred.interactionPaused) {
    snapshot = await bridge.setInteractionPaused(preferred.interactionPaused)
  }
  if (
    bridge.autostartLoaded.value
    && bridge.autostartEnabled.value !== preferred.autostartEnabled
  ) {
    await bridge.setAutostartEnabled(preferred.autostartEnabled)
  }
  // The desktop pet always starts click-through. Settings live in a separate
  // application window, so the transparent character never needs to capture
  // desktop clicks during normal use.
  if (!snapshot.clickThrough) {
    snapshot = await bridge.setClickThrough(true)
  }
  syncDesktopSnapshot(snapshot)
  settings.value = {
    ...settings.value,
    autostartEnabled: bridge.autostartEnabled.value,
  }
  desktopPreferencesApplied.value = true
}
</script>

<template>
  <main
    ref="host"
    class="pet-window"
  >
    <Transition name="bubble">
      <div v-if="bubbleText" class="speech-bubble" role="status">
        <span class="quote-mark">“</span>
        {{ bubbleText }}
      </div>
    </Transition>

    <Transition name="key-pop" mode="out-in">
      <div
        v-if="brain.keyBubble.value"
        :key="brain.keyBubbleRevision.value"
        class="key-press-bubble"
        role="status"
      >
        <strong>{{ brain.keyBubble.value }}</strong>
      </div>
    </Transition>

    <canvas
      ref="canvas"
      class="live2d-canvas"
      :class="{ visible: live2d.loaded.value }"
      aria-label="戳一下高木同学"
      @click="brain.poke"
    />
    <PreviewPet
      v-if="!live2d.loaded.value"
      :action="brain.action.value"
      :intensity="brain.intensity.value"
      :keyboard-hand="brain.keyboardHand.value"
      :mouse-hand="brain.mouseHand.value"
      :expression="brain.expression.value"
      @poke="brain.poke"
    />

    <svg
      v-if="live2d.loaded.value"
      class="t004-body-stage"
      :style="keyboardOverlayStageStyle"
      viewBox="0 0 1254 1254"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <image
        class="t004-topwear"
        href="/models/takagi/overlays/t004-topwear.png"
        width="1254"
        height="1254"
      />
    </svg>

    <svg
      v-if="live2d.loaded.value"
      class="t004-hair-stage"
      :style="keyboardOverlayStageStyle"
      viewBox="0 0 1254 1254"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <g :transform="frontHairHeadTransform">
        <image
          class="t004-front-hair"
          transform="translate(0 14) translate(600 930) scale(1.12 1.22) translate(-600 -930)"
          href="/models/takagi/overlays/t004-front-hair-unified.png"
          width="1254"
          height="1254"
        />
      </g>
    </svg>

    <svg
      v-if="live2d.loaded.value"
      class="t004-interaction-stage"
      :style="keyboardOverlayStageStyle"
      viewBox="0 0 1254 1254"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      <image
        class="t004-objects-base"
        href="/models/takagi/overlays/t004-objects-base.png"
        width="1254"
        height="1254"
      />
      <g :transform="`translate(${keyboardTargetOffsetX} ${keyboardTargetOffsetY})`">
        <image
          class="t004-keyboard-hand idle"
          :class="{ visible: !keyboardHandTouching }"
          href="/models/takagi/overlays/t004-keyboard-hand-idle.png"
          width="1254"
          height="1254"
        />
      </g>
      <g :transform="`translate(${keyboardShoulderOffsetX} ${keyboardShoulderOffsetY})`">
        <image
          class="t004-keyboard-arm active"
          :class="{ visible: keyboardHandTouching }"
          :transform="keyboardArmTransform"
          href="/models/takagi/overlays/t004-keyboard-arm-active.png"
          width="1254"
          height="1254"
        />
      </g>
      <g :transform="`translate(${mouseShoulderOffsetX} ${mouseShoulderOffsetY})`">
        <image
          class="t004-mouse-group"
          :transform="mouseGroupTransform"
          href="/models/takagi/overlays/t004-mouse-hand-and-device.png"
          width="1254"
          height="1254"
        />
      </g>
    </svg>

    <div class="combo-pill" :class="{ hot: brain.combo.value >= 12 }">
      <span class="combo-flame">✦</span>
      <strong>{{ brain.combo.value }}</strong>
      <small>COMBO</small>
    </div>

    <div v-if="bridge.error.value" class="mode-hint">
      {{ bridge.error.value }}
    </div>
  </main>
</template>
