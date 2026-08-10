mod input;
mod permissions;

use input::{
    cadence_from_interval, classify_button, classify_key_target, display_key_label,
    normalize_pointer_in_display, ButtonState, Cadence, DisplayBounds, InteractionEvent,
    KeyboardTarget, KeyboardZone, ListenerStatus, PointerAccumulator,
};
use permissions::{input_permission_snapshot, request_input_permissions};
use rdev::{listen, Event, EventType, Key};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const MAIN_WINDOW_LABEL: &str = "main";
const SETTINGS_WINDOW_LABEL: &str = "settings";
const DEVICE_EVENT_NAME: &str = "device-changed";
const DESKTOP_STATE_EVENT_NAME: &str = "desktop-state-changed";
const SHORTCUT_STATUS_EVENT_NAME: &str = "shortcut-status-changed";
const SETTINGS_UPDATED_EVENT_NAME: &str = "pet-settings-updated";
const DESKTOP_ERROR_EVENT_NAME: &str = "desktop-operation-error";
const POINTER_FRAME_TIME: Duration = Duration::from_millis(16);
const PERMISSION_RECHECK_INTERVAL: Duration = Duration::from_secs(2);
const KEY_RELEASE_WATCHDOG: Duration = Duration::from_secs(8);

#[derive(Debug, Clone)]
struct StoredListenerStatus {
    status: ListenerStatus,
    message: Option<String>,
}

impl Default for StoredListenerStatus {
    fn default() -> Self {
        Self {
            status: ListenerStatus::Starting,
            message: Some("等待全局输入监听启动。".to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum ShortcutRegistration {
    Pending,
    Registered,
    Conflict,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutStatusPayload {
    accelerator: &'static str,
    status: ShortcutRegistration,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

impl Default for ShortcutStatusPayload {
    fn default() -> Self {
        Self {
            accelerator: "CommandOrControl+Shift+T",
            status: ShortcutRegistration::Pending,
            message: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopStateSnapshot {
    interaction_paused: bool,
    click_through: bool,
    always_on_top: bool,
    visible: bool,
    shortcut: ShortcutStatusPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopOperationError {
    operation: &'static str,
    message: String,
}

#[derive(Debug)]
struct CadenceRuntime {
    last_press: Option<Instant>,
    current: Cadence,
}

impl Default for CadenceRuntime {
    fn default() -> Self {
        Self {
            last_press: None,
            current: Cadence::Slow,
        }
    }
}

impl CadenceRuntime {
    fn for_state(&mut self, state: ButtonState) -> Cadence {
        if state == ButtonState::Pressed {
            let now = Instant::now();
            let interval = self
                .last_press
                .map(|last| now.saturating_duration_since(last));
            self.current = cadence_from_interval(interval);
            self.last_press = Some(now);
        }
        self.current
    }

    fn reset(&mut self) {
        self.last_press = None;
        self.current = Cadence::Slow;
    }
}

#[derive(Debug, Clone, Copy)]
struct PressedKey {
    zone: KeyboardZone,
    key_x: f64,
    key_y: f64,
    cadence: Cadence,
    last_seen: Instant,
}

#[derive(Debug, Default)]
struct BackendState {
    listener_started: AtomicBool,
    listener_generation: AtomicU64,
    permission_available: AtomicBool,
    permission_prompt_requested: AtomicBool,
    permission_revoked_after_start: AtomicBool,
    interaction_paused: AtomicBool,
    click_through: AtomicBool,
    always_on_top: AtomicBool,
    visible: AtomicBool,
    listener_lifecycle: Mutex<()>,
    listener_status: Mutex<StoredListenerStatus>,
    shortcut_status: Mutex<ShortcutStatusPayload>,
    pressed_keys: Mutex<HashMap<Key, PressedKey>>,
    cadence: Mutex<CadenceRuntime>,
    pointer: Mutex<PointerAccumulator>,
}

impl BackendState {
    fn listener_event(&self) -> InteractionEvent {
        let stored = lock_unpoisoned(&self.listener_status);
        InteractionEvent::listener_status(stored.status, stored.message.clone())
    }

    fn set_listener_status(
        &self,
        app: &AppHandle,
        status: ListenerStatus,
        message: Option<impl Into<String>>,
    ) -> InteractionEvent {
        let event = InteractionEvent::listener_status(status, message);
        if let InteractionEvent::ListenerStatus { status, message } = &event {
            *lock_unpoisoned(&self.listener_status) = StoredListenerStatus {
                status: *status,
                message: message.clone(),
            };
        }
        emit_to_main(app, DEVICE_EVENT_NAME, event.clone());
        event
    }

    fn desktop_snapshot(&self) -> DesktopStateSnapshot {
        DesktopStateSnapshot {
            interaction_paused: self.interaction_paused.load(Ordering::Acquire),
            click_through: self.click_through.load(Ordering::Acquire),
            always_on_top: self.always_on_top.load(Ordering::Acquire),
            visible: self.visible.load(Ordering::Acquire),
            shortcut: lock_unpoisoned(&self.shortcut_status).clone(),
        }
    }

    fn emit_desktop_snapshot(&self, app: &AppHandle) -> DesktopStateSnapshot {
        let snapshot = self.desktop_snapshot();
        emit_to_main(app, DESKTOP_STATE_EVENT_NAME, snapshot.clone());
        snapshot
    }

    fn set_shortcut_status(&self, app: &AppHandle, payload: ShortcutStatusPayload) {
        *lock_unpoisoned(&self.shortcut_status) = payload.clone();
        emit_to_main(app, SHORTCUT_STATUS_EVENT_NAME, payload);
    }

    fn reset_transient_input(&self) {
        lock_unpoisoned(&self.pressed_keys).clear();
        lock_unpoisoned(&self.cadence).reset();
        lock_unpoisoned(&self.pointer).reset();
    }

    fn begin_key_press(&self, key: Key) -> Option<(KeyboardTarget, Cadence, &'static str)> {
        let now = Instant::now();
        let mut pressed_keys = lock_unpoisoned(&self.pressed_keys);

        if let Some(pressed) = pressed_keys.get_mut(&key) {
            // OS auto-repeat is not a second physical key-down. Refreshing the
            // watchdog prevents one eventual key-up from leaving an inflated
            // semantic press count in the frontend.
            pressed.last_seen = now;
            return None;
        }

        let target = classify_key_target(key);
        let cadence = lock_unpoisoned(&self.cadence).for_state(ButtonState::Pressed);
        pressed_keys.insert(
            key,
            PressedKey {
                zone: target.zone,
                key_x: target.x,
                key_y: target.y,
                cadence,
                last_seen: now,
            },
        );
        Some((target, cadence, display_key_label(key)))
    }

    fn finish_key_release(&self, key: Key) -> Option<(KeyboardTarget, Cadence, &'static str)> {
        lock_unpoisoned(&self.pressed_keys)
            .remove(&key)
            .map(|pressed| {
                (
                    KeyboardTarget {
                        zone: pressed.zone,
                        x: pressed.key_x,
                        y: pressed.key_y,
                    },
                    pressed.cadence,
                    display_key_label(key),
                )
            })
    }

    fn take_stale_key_releases(
        &self,
        now: Instant,
    ) -> Vec<(KeyboardTarget, Cadence, &'static str)> {
        let mut pressed_keys = lock_unpoisoned(&self.pressed_keys);
        let stale_keys: Vec<Key> = pressed_keys
            .iter()
            .filter_map(|(key, pressed)| {
                (now.saturating_duration_since(pressed.last_seen) >= KEY_RELEASE_WATCHDOG)
                    .then_some(*key)
            })
            .collect();

        stale_keys
            .into_iter()
            .filter_map(|key| pressed_keys.remove(&key).map(|pressed| (key, pressed)))
            .map(|(key, pressed)| {
                (
                    KeyboardTarget {
                        zone: pressed.zone,
                        x: pressed.key_x,
                        y: pressed.key_y,
                    },
                    pressed.cadence,
                    display_key_label(key),
                )
            })
            .collect()
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn emit_to_main<T>(app: &AppHandle, event_name: &str, payload: T)
where
    T: Serialize + Clone,
{
    let _ = app.emit_to(MAIN_WINDOW_LABEL, event_name, payload);
}

fn emit_desktop_error(app: &AppHandle, operation: &'static str, message: impl Into<String>) {
    emit_to_main(
        app,
        DESKTOP_ERROR_EVENT_NAME,
        DesktopOperationError {
            operation,
            message: message.into(),
        },
    );
}

fn emit_keyboard_event(
    app: &AppHandle,
    target: KeyboardTarget,
    key_label: &'static str,
    state: ButtonState,
    cadence: Cadence,
) {
    emit_to_main(
        app,
        DEVICE_EVENT_NAME,
        InteractionEvent::Keyboard {
            zone: target.zone,
            key_x: target.x,
            key_y: target.y,
            key_label,
            state,
            cadence,
        },
    );
}

#[cfg(target_os = "macos")]
fn normalized_pointer_position(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64)> {
    use core_graphics::display::CGDisplay;

    // Querying Tauri first keeps this calculation aligned with the same
    // display topology used by the windowing runtime. CoreGraphics bounds are
    // then used because rdev's CGEvent coordinates live in that exact logical
    // coordinate space, including negative origins and mixed-DPI displays.
    app.monitor_from_point(x, y).ok().flatten()?;
    CGDisplay::active_displays()
        .ok()?
        .into_iter()
        .find_map(|display_id| {
            let bounds = CGDisplay::new(display_id).bounds();
            normalize_pointer_in_display(
                x,
                y,
                DisplayBounds {
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                },
            )
        })
}

#[cfg(not(target_os = "macos"))]
fn normalized_pointer_position(app: &AppHandle, x: f64, y: f64) -> Option<(f64, f64)> {
    let monitor = app.monitor_from_point(x, y).ok().flatten()?;
    let scale = monitor.scale_factor();
    let position = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    normalize_pointer_in_display(
        x,
        y,
        DisplayBounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        },
    )
}

fn handle_device_event_type(app: &AppHandle, state: &Arc<BackendState>, event_type: EventType) {
    if state.interaction_paused.load(Ordering::Acquire)
        || !state.permission_available.load(Ordering::Acquire)
    {
        return;
    }

    match event_type {
        EventType::KeyPress(key) => {
            if let Some((target, cadence, key_label)) = state.begin_key_press(key) {
                emit_keyboard_event(app, target, key_label, ButtonState::Pressed, cadence);
            }
        }
        EventType::KeyRelease(key) => {
            // Ignore an unmatched release (for example one received after
            // pause/reset); the frontend never saw a corresponding press.
            if let Some((target, cadence, key_label)) = state.finish_key_release(key) {
                emit_keyboard_event(app, target, key_label, ButtonState::Released, cadence);
            }
        }
        EventType::ButtonPress(button) => {
            emit_to_main(
                app,
                DEVICE_EVENT_NAME,
                InteractionEvent::MouseButton {
                    button: classify_button(button),
                    state: ButtonState::Pressed,
                },
            );
        }
        EventType::ButtonRelease(button) => {
            emit_to_main(
                app,
                DEVICE_EVENT_NAME,
                InteractionEvent::MouseButton {
                    button: classify_button(button),
                    state: ButtonState::Released,
                },
            );
        }
        EventType::MouseMove { x, y } => {
            let gaze_position = normalized_pointer_position(app, x, y);
            lock_unpoisoned(&state.pointer).observe_position(x, y, gaze_position);
        }
        EventType::Wheel { delta_y, .. } => {
            lock_unpoisoned(&state.pointer).observe_wheel(delta_y);
        }
    }
}

fn run_pointer_ticker(app: AppHandle, state: Arc<BackendState>, generation: u64) {
    let mut last_permission_check = Instant::now();

    loop {
        thread::sleep(POINTER_FRAME_TIME);

        if !state.listener_started.load(Ordering::Acquire)
            || state.listener_generation.load(Ordering::Acquire) != generation
        {
            break;
        }

        if last_permission_check.elapsed() >= PERMISSION_RECHECK_INTERVAL {
            last_permission_check = Instant::now();
            let permissions = input_permission_snapshot();
            if !permissions.granted() {
                let _lifecycle_guard = lock_unpoisoned(&state.listener_lifecycle);
                if state.listener_started.load(Ordering::Acquire)
                    && state.listener_generation.load(Ordering::Acquire) == generation
                    && state.permission_available.swap(false, Ordering::AcqRel)
                {
                    state
                        .permission_revoked_after_start
                        .store(true, Ordering::Release);
                    state.reset_transient_input();
                    state.set_listener_status(
                        &app,
                        ListenerStatus::PermissionDenied,
                        permissions.denial_message(),
                    );
                }
            }
        }

        let _lifecycle_guard = lock_unpoisoned(&state.listener_lifecycle);
        if !state.listener_started.load(Ordering::Acquire)
            || state.listener_generation.load(Ordering::Acquire) != generation
        {
            break;
        }

        if state.interaction_paused.load(Ordering::Acquire)
            || !state.permission_available.load(Ordering::Acquire)
        {
            lock_unpoisoned(&state.pointer).reset();
            continue;
        }

        for (target, cadence, key_label) in state.take_stale_key_releases(Instant::now()) {
            emit_keyboard_event(&app, target, key_label, ButtonState::Released, cadence);
        }

        for event in lock_unpoisoned(&state.pointer).take_events() {
            emit_to_main(&app, DEVICE_EVENT_NAME, event);
        }
    }
}

fn start_listener(app: &AppHandle, state: Arc<BackendState>) -> InteractionEvent {
    let _lifecycle_guard = lock_unpoisoned(&state.listener_lifecycle);
    let mut permissions = input_permission_snapshot();
    if !permissions.granted()
        && std::env::var_os("TAKAGI_QA_SKIP_PERMISSION_PROMPT").is_none()
        && !state
            .permission_prompt_requested
            .swap(true, Ordering::AcqRel)
    {
        permissions = request_input_permissions();
    }
    if !permissions.granted() {
        state.permission_available.store(false, Ordering::Release);
        return state.set_listener_status(
            app,
            ListenerStatus::PermissionDenied,
            permissions.denial_message(),
        );
    }

    if state
        .listener_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return state.listener_event();
    }
    let generation = state
        .listener_generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);

    state.permission_available.store(true, Ordering::Release);
    state
        .permission_revoked_after_start
        .store(false, Ordering::Release);
    state.reset_transient_input();
    let starting = state.set_listener_status(
        app,
        ListenerStatus::Starting,
        Some("正在启动本地全局输入监听。"),
    );

    let listener_app = app.clone();
    let listener_state = state.clone();
    let spawn_result = thread::Builder::new()
        .name("takagi-global-input".to_string())
        .spawn(move || {
            let ticker_app = listener_app.clone();
            let ticker_state = listener_state.clone();
            if thread::Builder::new()
                .name("takagi-input-frame-coalescer".to_string())
                .spawn(move || run_pointer_ticker(ticker_app, ticker_state, generation))
                .is_err()
            {
                let _lifecycle_guard = lock_unpoisoned(&listener_state.listener_lifecycle);
                listener_state
                    .permission_available
                    .store(false, Ordering::Release);
                listener_state.reset_transient_input();
                listener_state.set_listener_status(
                    &listener_app,
                    ListenerStatus::Failed,
                    Some("无法启动输入事件合并线程。"),
                );
                listener_state
                    .listener_started
                    .store(false, Ordering::Release);
                return;
            }

            let callback_app = listener_app.clone();
            let callback_state = listener_state.clone();
            listener_state.set_listener_status(
                &listener_app,
                if listener_state.interaction_paused.load(Ordering::Acquire) {
                    ListenerStatus::Paused
                } else {
                    ListenerStatus::Running
                },
                None::<String>,
            );

            let listen_result = listen(move |event| {
                // rdev materializes a layout-derived `name` field internally.
                // Drop it before classification and never inspect, emit, log,
                // retain, or persist its contents.
                let Event {
                    event_type, name, ..
                } = event;
                drop(name);
                handle_device_event_type(&callback_app, &callback_state, event_type);
            });

            let _lifecycle_guard = lock_unpoisoned(&listener_state.listener_lifecycle);
            listener_state
                .permission_available
                .store(false, Ordering::Release);
            listener_state.reset_transient_input();

            let message = if listen_result.is_err() {
                "全局输入监听意外停止；请重新检测权限后重试。"
            } else {
                "全局输入监听已停止；请重新检测权限后重试。"
            };
            listener_state.set_listener_status(
                &listener_app,
                ListenerStatus::Failed,
                Some(message),
            );
            listener_state
                .listener_started
                .store(false, Ordering::Release);
        });

    if spawn_result.is_err() {
        state.permission_available.store(false, Ordering::Release);
        state.reset_transient_input();
        let failed = state.set_listener_status(
            app,
            ListenerStatus::Failed,
            Some("无法创建全局输入监听线程。"),
        );
        state.listener_started.store(false, Ordering::Release);
        return failed;
    }

    starting
}

#[tauri::command]
fn start_device_listening(app: AppHandle, state: State<'_, Arc<BackendState>>) -> InteractionEvent {
    start_listener(&app, state.inner().clone())
}

#[tauri::command]
fn recheck_input_permissions(
    app: AppHandle,
    state: State<'_, Arc<BackendState>>,
) -> InteractionEvent {
    let lifecycle_guard = lock_unpoisoned(&state.listener_lifecycle);
    let mut permissions = input_permission_snapshot();
    if !permissions.granted() {
        permissions = request_input_permissions();
    }
    if !permissions.granted() {
        state.permission_available.store(false, Ordering::Release);
        return state.set_listener_status(
            &app,
            ListenerStatus::PermissionDenied,
            permissions.denial_message(),
        );
    }

    if state.listener_started.load(Ordering::Acquire)
        && state.permission_revoked_after_start.load(Ordering::Acquire)
    {
        return state.set_listener_status(
            &app,
            ListenerStatus::Failed,
            Some("权限已恢复，但监听需要重启应用后才能安全重建。"),
        );
    }

    if state.listener_started.load(Ordering::Acquire) {
        state.permission_available.store(true, Ordering::Release);
        let status = if state.interaction_paused.load(Ordering::Acquire) {
            ListenerStatus::Paused
        } else {
            ListenerStatus::Running
        };
        return state.set_listener_status(&app, status, None::<String>);
    }

    drop(lifecycle_guard);
    start_listener(&app, state.inner().clone())
}

#[tauri::command]
fn get_listener_status(state: State<'_, Arc<BackendState>>) -> InteractionEvent {
    state.listener_event()
}

fn set_interaction_paused_internal(
    app: &AppHandle,
    state: &Arc<BackendState>,
    paused: bool,
) -> DesktopStateSnapshot {
    state.interaction_paused.store(paused, Ordering::Release);
    state.reset_transient_input();

    if paused {
        state.set_listener_status(
            app,
            ListenerStatus::Paused,
            Some("全局互动已暂停；不会向界面转发输入动作。"),
        );
    } else if state.listener_started.load(Ordering::Acquire)
        && state.permission_available.load(Ordering::Acquire)
    {
        state.set_listener_status(app, ListenerStatus::Running, None::<String>);
    } else {
        let _ = start_listener(app, state.clone());
    }

    state.emit_desktop_snapshot(app)
}

#[tauri::command]
fn set_interaction_paused(
    app: AppHandle,
    state: State<'_, Arc<BackendState>>,
    paused: bool,
) -> DesktopStateSnapshot {
    set_interaction_paused_internal(&app, state.inner(), paused)
}

fn main_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "找不到桌宠主窗口。".to_string())
}

fn set_click_through_internal(
    app: &AppHandle,
    state: &Arc<BackendState>,
    enabled: bool,
) -> Result<DesktopStateSnapshot, String> {
    let window = main_window(app)?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|_| "无法更新鼠标穿透状态。".to_string())?;
    state.click_through.store(enabled, Ordering::Release);
    Ok(state.emit_desktop_snapshot(app))
}

#[tauri::command]
fn set_click_through(
    app: AppHandle,
    state: State<'_, Arc<BackendState>>,
    enabled: bool,
) -> Result<DesktopStateSnapshot, String> {
    set_click_through_internal(&app, state.inner(), enabled)
}

#[tauri::command]
fn set_always_on_top(
    app: AppHandle,
    state: State<'_, Arc<BackendState>>,
    enabled: bool,
) -> Result<DesktopStateSnapshot, String> {
    let window = main_window(&app)?;
    window
        .set_always_on_top(enabled)
        .map_err(|_| "无法更新窗口置顶状态。".to_string())?;
    state.always_on_top.store(enabled, Ordering::Release);
    Ok(state.emit_desktop_snapshot(&app))
}

fn show_main_window_internal(
    app: &AppHandle,
    state: &Arc<BackendState>,
) -> Result<DesktopStateSnapshot, String> {
    let window = main_window(app)?;
    window
        .unminimize()
        .map_err(|_| "无法恢复桌宠窗口。".to_string())?;
    window
        .show()
        .map_err(|_| "无法显示桌宠窗口。".to_string())?;

    state.visible.store(true, Ordering::Release);
    Ok(state.emit_desktop_snapshot(app))
}

fn set_main_window_visible_internal(
    app: &AppHandle,
    state: &Arc<BackendState>,
    visible: bool,
) -> Result<DesktopStateSnapshot, String> {
    if visible {
        return show_main_window_internal(app, state);
    }

    main_window(app)?
        .hide()
        .map_err(|_| "无法隐藏桌宠窗口。".to_string())?;
    state.visible.store(false, Ordering::Release);
    Ok(state.emit_desktop_snapshot(app))
}

#[tauri::command]
fn set_main_window_visible(
    app: AppHandle,
    state: State<'_, Arc<BackendState>>,
    visible: bool,
) -> Result<DesktopStateSnapshot, String> {
    set_main_window_visible_internal(&app, state.inner(), visible)
}

#[tauri::command]
fn show_main_window(
    app: AppHandle,
    state: State<'_, Arc<BackendState>>,
) -> Result<DesktopStateSnapshot, String> {
    show_main_window_internal(&app, state.inner())
}

fn settings_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(SETTINGS_WINDOW_LABEL)
        .ok_or_else(|| "找不到桌宠设置窗口。".to_string())
}

fn show_settings_window(app: &AppHandle) -> Result<(), String> {
    let window = settings_window(app)?;
    window
        .unminimize()
        .map_err(|_| "无法恢复设置窗口。".to_string())?;
    window
        .show()
        .map_err(|_| "无法显示设置窗口。".to_string())?;
    window
        .set_focus()
        .map_err(|_| "无法聚焦设置窗口。".to_string())
}

#[tauri::command]
fn open_settings(
    app: AppHandle,
    state: State<'_, Arc<BackendState>>,
) -> Result<DesktopStateSnapshot, String> {
    show_settings_window(&app)?;
    Ok(state.desktop_snapshot())
}

#[tauri::command]
fn hide_settings_window(app: AppHandle) -> Result<(), String> {
    settings_window(&app)?
        .hide()
        .map_err(|_| "无法隐藏设置窗口。".to_string())
}

#[tauri::command]
fn notify_settings_updated(app: AppHandle) {
    emit_to_main(&app, SETTINGS_UPDATED_EVENT_NAME, ());
}

#[tauri::command]
fn preview_key_bubble(app: AppHandle) {
    let key = Key::KeyW;
    let target = classify_key_target(key);
    let label = display_key_label(key);
    emit_keyboard_event(&app, target, label, ButtonState::Pressed, Cadence::Normal);

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(180));
        emit_keyboard_event(&app, target, label, ButtonState::Released, Cadence::Normal);
    });
}

#[tauri::command]
fn get_desktop_state(state: State<'_, Arc<BackendState>>) -> DesktopStateSnapshot {
    state.desktop_snapshot()
}

#[cfg(desktop)]
#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|_| "无法读取随系统启动状态。".to_string())
}

#[cfg(desktop)]
#[tauri::command]
fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let autostart = app.autolaunch();
    let result = if enabled {
        autostart.enable()
    } else {
        autostart.disable()
    };
    result.map_err(|_| "无法更新随系统启动状态。".to_string())?;
    autostart
        .is_enabled()
        .map_err(|_| "随系统启动状态已更新，但无法重新读取。".to_string())
}

#[cfg(desktop)]
fn recovery_shortcut() -> Shortcut {
    let command_or_control = if cfg!(target_os = "macos") {
        Modifiers::SUPER
    } else {
        Modifiers::CONTROL
    };
    Shortcut::new(Some(command_or_control | Modifiers::SHIFT), Code::KeyT)
}

#[cfg(desktop)]
fn toggle_click_through_from_recovery_shortcut(app: &AppHandle) {
    let state = app.state::<Arc<BackendState>>().inner().clone();
    let result = if !state.visible.load(Ordering::Acquire) {
        show_main_window_internal(app, &state)
    } else {
        let enabled = !state.click_through.load(Ordering::Acquire);
        set_click_through_internal(app, &state, enabled)
    };

    if let Err(message) = result {
        emit_desktop_error(app, "toggle-click-through-shortcut", message);
    }
}

#[cfg(desktop)]
fn register_recovery_shortcut(app: &tauri::App) {
    let state = app.state::<Arc<BackendState>>().inner().clone();
    let status = match app.handle().global_shortcut().register(recovery_shortcut()) {
        Ok(()) => ShortcutStatusPayload {
            accelerator: "CommandOrControl+Shift+T",
            status: ShortcutRegistration::Registered,
            message: None,
        },
        Err(_) => ShortcutStatusPayload {
            accelerator: "CommandOrControl+Shift+T",
            status: ShortcutRegistration::Conflict,
            message: Some(
                "快捷键注册失败，可能已被其他应用占用；请使用系统托盘恢复桌宠。".to_string(),
            ),
        },
    };
    state.set_shortcut_status(app.handle(), status);
}

#[cfg(desktop)]
fn build_tray_icon() -> Image<'static> {
    const SIZE: u32 = 22;
    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f64 - 10.5;
            let dy = y as f64 - 11.0;
            let head = dx * dx / 78.0 + dy * dy / 72.0 <= 1.0;
            let left_ear = x >= 3 && x <= 8 && y >= 1 && y <= 7 && x + y <= 10;
            let right_ear = x >= 13 && x <= 18 && y >= 1 && y <= 7 && (SIZE - x) + y <= 9;
            let eye =
                ((x == 8 || x == 14) && (y == 10 || y == 11)) || (y == 15 && (9..=13).contains(&x));
            let opaque = head || left_ear || right_ear;
            let alpha = if eye {
                0
            } else if opaque {
                255
            } else {
                0
            };
            let index = ((y * SIZE + x) * 4) as usize;
            rgba[index] = 0;
            rgba[index + 1] = 0;
            rgba[index + 2] = 0;
            rgba[index + 3] = alpha;
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}

#[cfg(desktop)]
fn handle_tray_menu(app: &AppHandle, id: &str) {
    let state = app.state::<Arc<BackendState>>().inner().clone();
    let result = match id {
        "tray-toggle-window" => {
            set_main_window_visible_internal(app, &state, !state.visible.load(Ordering::Acquire))
                .map(|_| ())
        }
        "tray-toggle-interaction" => {
            let paused = !state.interaction_paused.load(Ordering::Acquire);
            set_interaction_paused_internal(app, &state, paused);
            Ok(())
        }
        "tray-toggle-click-through" => {
            let enabled = !state.click_through.load(Ordering::Acquire);
            set_click_through_internal(app, &state, enabled).map(|_| ())
        }
        "tray-open-settings" => show_settings_window(app),
        "tray-quit" => {
            app.exit(0);
            Ok(())
        }
        _ => Ok(()),
    };

    if let Err(message) = result {
        emit_desktop_error(app, "tray-menu", message);
    }
}

#[cfg(desktop)]
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let toggle_window =
        MenuItem::with_id(app, "tray-toggle-window", "显示/隐藏", true, None::<&str>)?;
    let toggle_interaction = MenuItem::with_id(
        app,
        "tray-toggle-interaction",
        "暂停/启用全局互动",
        true,
        None::<&str>,
    )?;
    let toggle_click_through = MenuItem::with_id(
        app,
        "tray-toggle-click-through",
        "开启/关闭鼠标穿透",
        true,
        None::<&str>,
    )?;
    let open_settings =
        MenuItem::with_id(app, "tray-open-settings", "打开设置", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &toggle_window,
            &toggle_interaction,
            &toggle_click_through,
            &open_settings,
            &separator,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("takagi-main-tray")
        .icon(build_tray_icon())
        .icon_as_template(true)
        .tooltip("高木同学桌宠")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_tray_menu(app, event.id().as_ref()))
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(BackendState::default());

    #[cfg(desktop)]
    let shortcut = recovery_shortcut();

    let builder = tauri::Builder::default().manage(state);

    #[cfg(desktop)]
    let builder = builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, registered_shortcut, event| {
                    if registered_shortcut == &shortcut && event.state() == ShortcutState::Pressed {
                        toggle_click_through_from_recovery_shortcut(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        );

    builder
        .invoke_handler(tauri::generate_handler![
            start_device_listening,
            recheck_input_permissions,
            get_listener_status,
            set_interaction_paused,
            set_click_through,
            set_always_on_top,
            set_main_window_visible,
            show_main_window,
            open_settings,
            hide_settings_window,
            notify_settings_updated,
            preview_key_bubble,
            get_desktop_state,
            get_autostart_enabled,
            set_autostart_enabled,
        ])
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let state = app.state::<Arc<BackendState>>();
                if window.set_ignore_cursor_events(true).is_ok() {
                    state.click_through.store(true, Ordering::Release);
                } else {
                    emit_desktop_error(
                        app.handle(),
                        "startup-click-through",
                        "启动时无法开启鼠标穿透。",
                    );
                }
                state
                    .visible
                    .store(window.is_visible().unwrap_or(true), Ordering::Release);
                state
                    .always_on_top
                    .store(window.is_always_on_top().unwrap_or(true), Ordering::Release);
            }

            #[cfg(desktop)]
            {
                setup_tray(app)?;
                register_recovery_shortcut(app);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == SETTINGS_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Takagi Desktop Pet");
}

#[cfg(test)]
mod backend_tests {
    use super::*;

    #[test]
    fn deduplicates_key_repeat_and_matches_one_semantic_release() {
        let state = BackendState::default();

        assert!(state.begin_key_press(Key::KeyA).is_some());
        assert!(state.begin_key_press(Key::KeyA).is_none());
        assert_eq!(
            state.finish_key_release(Key::KeyA),
            Some((classify_key_target(Key::KeyA), Cadence::Slow, "A"))
        );
        assert!(state.finish_key_release(Key::KeyA).is_none());
    }

    #[test]
    fn expires_lost_key_up_without_retaining_raw_key_identity() {
        let state = BackendState::default();
        assert!(state.begin_key_press(Key::KeyJ).is_some());

        let releases = state.take_stale_key_releases(Instant::now() + KEY_RELEASE_WATCHDOG);
        assert_eq!(
            releases,
            vec![(classify_key_target(Key::KeyJ), Cadence::Slow, "J")]
        );
        assert!(lock_unpoisoned(&state.pressed_keys).is_empty());
    }
}
