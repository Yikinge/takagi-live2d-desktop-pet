import { createApp } from 'vue'
import App from './App.vue'
import SettingsWindow from './SettingsWindow.vue'
import './style.css'

const isSettingsWindow = new URLSearchParams(window.location.search)
  .get('window') === 'settings'

createApp(isSettingsWindow ? SettingsWindow : App).mount('#app')
