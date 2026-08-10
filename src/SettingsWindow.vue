<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import SettingsPopover from './components/SettingsPopover.vue'
import { useDesktopBridge } from './composables/useDesktopBridge'
import {
  loadPetSettings,
  sanitizePetSettings,
  savePetSettings,
} from './composables/petSettings'
import type { PetSettings } from './types'

const settings = ref<PetSettings>(loadPetSettings())
const desktopReady = ref(false)
const bridge = useDesktopBridge(() => {})

function syncDesktopState() {
  const snapshot = bridge.desktopState.value
  settings.value = {
    ...settings.value,
    clickThrough: snapshot.clickThrough,
    alwaysOnTop: snapshot.alwaysOnTop,
    interactionPaused: snapshot.interactionPaused,
    autostartEnabled: bridge.autostartEnabled.value,
  }
  savePetSettings(settings.value)
}

async function updateSettings(next: PetSettings) {
  const previous = settings.value
  settings.value = sanitizePetSettings(next)
  savePetSettings(settings.value)

  if (settings.value.alwaysOnTop !== previous.alwaysOnTop) {
    await bridge.setAlwaysOnTop(settings.value.alwaysOnTop)
  }
  if (settings.value.interactionPaused !== previous.interactionPaused) {
    await bridge.setInteractionPaused(settings.value.interactionPaused)
  }
  if (settings.value.clickThrough !== previous.clickThrough) {
    await bridge.setClickThrough(settings.value.clickThrough)
  }
  if (settings.value.autostartEnabled !== previous.autostartEnabled) {
    await bridge.setAutostartEnabled(settings.value.autostartEnabled)
  }

  syncDesktopState()
  await bridge.notifySettingsUpdated()
}

watch(bridge.desktopState, () => {
  if (desktopReady.value) syncDesktopState()
}, { deep: true })

watch(bridge.autostartEnabled, () => {
  if (desktopReady.value && bridge.autostartLoaded.value) syncDesktopState()
})

onMounted(async () => {
  await bridge.start()
  syncDesktopState()
  desktopReady.value = true
})
</script>

<template>
  <main class="settings-window-shell">
    <SettingsPopover
      :settings="settings"
      model-status="Live2D 模型由桌宠窗口运行"
      :model-diagnostics="[]"
      :listener-state="bridge.listenerState.value"
      :shortcut-state="bridge.shortcutState.value"
      :desktop-mode="bridge.isDesktop.value"
      :autostart-available="bridge.autostartAvailable.value"
      :show-interaction-tests="false"
      :show-key-bubble-preview="true"
      @close="bridge.hideSettingsWindow"
      @update="updateSettings"
      @recheck-permissions="bridge.recheckInputPermissions"
      @preview-key-bubble="bridge.previewKeyBubble"
    />
  </main>
</template>
