<script setup lang="ts">
import { computed } from 'vue'
import type { ModelDiagnostic } from '../composables/modelContract'
import type {
  KeyboardZone,
  ListenerState,
  PetSettings,
  ShortcutStatusPayload,
} from '../types'

type MouseDemo = 'move' | 'left' | 'right' | 'wheel-up' | 'wheel-down'

const props = defineProps<{
  autostartAvailable: boolean
  desktopMode: boolean
  listenerState: ListenerState
  modelDiagnostics: ModelDiagnostic[]
  modelStatus: string
  positionLocked: boolean
  settings: PetSettings
  showInteractionTests: boolean
  showKeyBubblePreview: boolean
  shortcutState: ShortcutStatusPayload
}>()

const emit = defineEmits<{
  close: []
  demoKeyboard: [zone: KeyboardZone]
  demoMouse: [action: MouseDemo]
  recheckPermissions: []
  previewKeyBubble: []
  setPositionLocked: [locked: boolean]
  update: [settings: PetSettings]
}>()

const listenerLabel = computed(() => ({
  starting: '正在启动输入监听',
  running: '全局互动已启用',
  paused: '全局互动已暂停',
  'permission-denied': '缺少系统输入权限',
  failed: '输入监听启动失败',
})[props.listenerState.status])

const shortcutLabel = computed(() => ({
  pending: '恢复快捷键正在注册',
  registered: '恢复快捷键已就绪',
  conflict: '恢复快捷键冲突，请使用托盘找回',
})[props.shortcutState.status])

function patch(current: PetSettings, value: Partial<PetSettings>) {
  emit('update', { ...current, ...value })
}
</script>

<template>
  <section class="settings-card" aria-label="桌宠设置" @pointerdown.stop>
    <header>
      <div>
        <p class="eyebrow">TAKAGI PET</p>
        <h2>桌宠设置</h2>
      </div>
      <button class="icon-button" aria-label="关闭设置" @click="emit('close')">×</button>
    </header>

    <div
      class="runtime-card"
      :class="`is-${listenerState.status}`"
      role="status"
    >
      <span class="status-dot" />
      <div>
        <strong>{{ listenerLabel }}</strong>
        <small>{{ listenerState.message ?? shortcutLabel }}</small>
        <small v-if="shortcutState.status !== 'registered'">
          {{ shortcutLabel }}
        </small>
      </div>
      <button
        v-if="desktopMode"
        class="text-button"
        type="button"
        @click="emit('recheckPermissions')"
      >
        {{ listenerState.status === 'permission-denied' ? '请求授权' : '重新检测' }}
      </button>
    </div>

    <p
      v-if="listenerState.status === 'permission-denied'"
      class="permission-help"
    >
      点击“请求授权”，并在 macOS 中为本应用开启“辅助功能”和“输入监控”；
      完成后请彻底退出并重新打开桌宠。
    </p>

    <label class="setting-row">
      <span>
        <strong>捉弄气泡</strong>
        <small>打字连击时显示原创台词</small>
      </span>
      <input
        type="checkbox"
        :checked="settings.bubbleEnabled"
        @change="patch(settings, { bubbleEnabled: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <label class="setting-row">
      <span>
        <strong>桌宠鼠标穿透</strong>
        <small>
          {{ positionLocked
            ? '每次启动默认开启，也可从菜单栏切换'
            : '移动模式会临时关闭，固定后自动恢复' }}
        </small>
      </span>
      <input
        type="checkbox"
        :checked="settings.clickThrough"
        :disabled="!desktopMode || !positionLocked"
        @change="patch(settings, { clickThrough: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <label class="setting-row">
      <span>
        <strong>始终置顶</strong>
        <small>让桌宠保持在其他窗口上方</small>
      </span>
      <input
        type="checkbox"
        :checked="settings.alwaysOnTop"
        :disabled="!desktopMode"
        @change="patch(settings, { alwaysOnTop: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <label class="setting-row">
      <span>
        <strong>暂停全局互动</strong>
        <small>停止监听并清空瞬时按键状态</small>
      </span>
      <input
        type="checkbox"
        :checked="settings.interactionPaused"
        :disabled="!desktopMode"
        @change="patch(settings, { interactionPaused: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <label class="setting-row">
      <span>
        <strong>随系统启动</strong>
        <small>默认关闭，可随时撤销</small>
      </span>
      <input
        type="checkbox"
        :checked="settings.autostartEnabled"
        :disabled="!desktopMode || !autostartAvailable"
        @change="patch(settings, { autostartEnabled: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <label class="setting-stack">
      <span>
        <strong>角色缩放</strong>
        <small>{{ Math.round(settings.characterScale * 100) }}%</small>
      </span>
      <input
        type="range"
        min="0.4"
        max="1"
        step="0.05"
        :value="settings.characterScale"
        @input="patch(settings, { characterScale: Number(($event.target as HTMLInputElement).value) })"
      />
    </label>

    <label class="setting-stack">
      <span>
        <strong>互动灵敏度</strong>
        <small>{{ settings.sensitivity }}%</small>
      </span>
      <input
        type="range"
        min="30"
        max="100"
        :value="settings.sensitivity"
        @input="patch(settings, { sensitivity: Number(($event.target as HTMLInputElement).value) })"
      />
    </label>

    <div v-if="showKeyBubblePreview" class="feature-preview-row">
      <span>
        <strong>按键提示预览</strong>
        <small>在桌宠左上角模拟显示 W</small>
      </span>
      <button
        class="text-button"
        type="button"
        @click="emit('previewKeyBubble')"
      >
        测试 W 按键提示
      </button>
    </div>

    <div class="memory-row" :class="{ 'is-moving': !positionLocked }">
      <span aria-hidden="true">{{ positionLocked ? '⌖' : '✥' }}</span>
      <div>
        <strong>{{ positionLocked ? '桌宠位置已固定' : '正在移动桌宠位置' }}</strong>
        <small>
          {{ positionLocked
            ? '点击移动后拖拽桌宠，固定时自动恢复鼠标穿透'
            : '拖到任意位置，然后点击右侧按钮固定' }}
        </small>
      </div>
      <button
        class="text-button position-button"
        type="button"
        :disabled="!desktopMode"
        @click="emit('setPositionLocked', !positionLocked)"
      >
        {{ positionLocked ? '移动位置' : '固定当前位置' }}
      </button>
    </div>

    <section
      v-if="showInteractionTests"
      class="interaction-tests"
      aria-label="互动动作测试"
    >
      <div class="section-heading">
        <strong>权限外动作测试</strong>
        <small>不读取真实输入</small>
      </div>
      <div class="test-group">
        <span>画面左手 · 键盘</span>
        <div class="test-buttons">
          <button @click="emit('demoKeyboard', 'left')">左区</button>
          <button @click="emit('demoKeyboard', 'center')">中区</button>
          <button @click="emit('demoKeyboard', 'right')">右区</button>
          <button @click="emit('demoKeyboard', 'space')">Space</button>
          <button @click="emit('demoKeyboard', 'enter')">Enter</button>
          <button @click="emit('demoKeyboard', 'backspace')">⌫</button>
        </div>
      </div>
      <div class="test-group">
        <span>画面右手 · 鼠标</span>
        <div class="test-buttons">
          <button @click="emit('demoMouse', 'move')">移动</button>
          <button @click="emit('demoMouse', 'left')">左键</button>
          <button @click="emit('demoMouse', 'right')">右键</button>
          <button @click="emit('demoMouse', 'wheel-up')">滚轮↑</button>
          <button @click="emit('demoMouse', 'wheel-down')">滚轮↓</button>
        </div>
      </div>
    </section>

    <div class="model-card">
      <span class="status-dot" />
      <div>
        <strong>{{ modelStatus }}</strong>
        <small>模型入口：{{ settings.modelPath }}</small>
      </div>
    </div>

    <ul v-if="modelDiagnostics.length" class="diagnostic-list">
      <li
        v-for="diagnostic in modelDiagnostics"
        :key="`${diagnostic.code}:${diagnostic.asset ?? ''}`"
        :class="`is-${diagnostic.severity}`"
      >
        <strong>{{ diagnostic.message }}</strong>
        <small v-if="diagnostic.asset">{{ diagnostic.asset }}</small>
      </li>
    </ul>
  </section>
</template>
