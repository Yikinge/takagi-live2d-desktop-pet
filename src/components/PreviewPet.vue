<script setup lang="ts">
import { computed } from 'vue'
import type {
  ExpressionTarget,
  KeyboardHandTarget,
  MouseHandTarget,
  PetAction,
} from '../types'

const props = defineProps<{
  action: PetAction
  expression: ExpressionTarget
  intensity: number
  keyboardHand: KeyboardHandTarget
  mouseHand: MouseHandTarget
}>()

defineEmits<{
  poke: []
}>()

const previewClasses = computed(() => [
  `is-${props.action}`,
  `key-zone-${props.keyboardHand.zone}`,
  `expression-${props.expression.name.toLowerCase()}`,
  {
    'is-key-active': props.keyboardHand.active
      || props.keyboardHand.press > 0.02,
    'is-mouse-active': props.mouseHand.active
      || props.mouseHand.pulse > 0.02,
  },
])

const previewStyle = computed(() => ({
  '--intensity': props.intensity,
  '--keyboard-zone': props.keyboardHand.zoneValue,
  '--key-glow': Math.max(
    props.keyboardHand.press,
    props.keyboardHand.pulse,
  ),
  '--space-press': props.keyboardHand.spacePress,
  '--enter-press': props.keyboardHand.enterPress,
  '--backspace-press': props.keyboardHand.backspacePress,
  '--mouse-x': props.mouseHand.x,
  '--mouse-y': props.mouseHand.y,
  '--mouse-glow': Math.max(
    props.mouseHand.pulse,
    Math.abs(props.mouseHand.x),
    Math.abs(props.mouseHand.y),
  ),
  '--mouse-left': props.mouseHand.leftClick,
  '--mouse-right': props.mouseHand.rightClick,
  '--mouse-wheel': Math.abs(props.mouseHand.wheel),
}))
</script>

<template>
  <button
    class="preview-pet reference-preview"
    :class="previewClasses"
    :style="previewStyle"
    aria-label="戳一下高木同学"
    @click="$emit('poke')"
  >
    <svg
      class="pet-art"
      viewBox="0 0 1254 1254"
      role="img"
      aria-label="用户提供的高木同学原画预览，画面左手操作键盘，画面右手操作鼠标"
    >
      <defs>
        <filter id="interactionGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <!--
        This fallback base is recomposed from the approved separated artwork
        with the previous keyboard and screen-left arm removed. App.vue adds
        the approved v5 keyboard and Q-style hand above both render paths.
      -->
      <image
        class="reference-art"
        href="/assets/takagi-base-no-keyboard-left-hand.png"
        x="0"
        y="0"
        width="1254"
        height="1254"
        preserveAspectRatio="xMidYMid meet"
      />

      <g class="mouse-feedback" aria-hidden="true" filter="url(#interactionGlow)">
        <ellipse cx="1001" cy="1030" rx="116" ry="102" />
        <path
          class="mouse-left-feedback"
          d="M952 984c19-24 42-32 57-31l-7 76-58-9c0-14 2-25 8-36Z"
        />
        <path
          class="mouse-right-feedback"
          d="M1009 953c28 2 51 24 55 57l-62 19 7-76Z"
        />
        <rect
          class="mouse-wheel-feedback"
          x="995"
          y="983"
          width="19"
          height="53"
          rx="9"
        />
      </g>
    </svg>
  </button>
</template>
