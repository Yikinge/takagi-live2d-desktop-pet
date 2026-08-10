use rdev::{Button, Key};
use serde::Serialize;
use std::time::Duration;

const POINTER_DEAD_ZONE: f64 = 0.5;
const POINTER_SPEED_AT_MAX: f64 = 160.0;
const WHEEL_INTENSITY_AT_MAX: f64 = 6.0;
const MAX_POINTER_STEP: f64 = 500.0;
const POSITION_BASELINE_IDLE_FRAMES: u8 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum KeyboardZone {
    Left,
    Center,
    Right,
    Space,
    Enter,
    Backspace,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ButtonState {
    Pressed,
    Released,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Cadence {
    Slow,
    Normal,
    Fast,
    Burst,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MouseButton {
    Left,
    Right,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WheelDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ListenerStatus {
    Starting,
    Running,
    Paused,
    PermissionDenied,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub(crate) enum InteractionEvent {
    Keyboard {
        zone: KeyboardZone,
        #[serde(rename = "keyX")]
        key_x: f64,
        #[serde(rename = "keyY")]
        key_y: f64,
        #[serde(rename = "keyLabel")]
        key_label: &'static str,
        state: ButtonState,
        cadence: Cadence,
    },
    MouseMove {
        x: i8,
        y: i8,
        speed: f64,
        #[serde(rename = "gazeX", skip_serializing_if = "Option::is_none")]
        gaze_x: Option<f64>,
        #[serde(rename = "gazeY", skip_serializing_if = "Option::is_none")]
        gaze_y: Option<f64>,
    },
    MouseButton {
        button: MouseButton,
        state: ButtonState,
    },
    MouseWheel {
        direction: WheelDirection,
        intensity: f64,
    },
    ListenerStatus {
        status: ListenerStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
}

impl InteractionEvent {
    pub(crate) fn listener_status(
        status: ListenerStatus,
        message: Option<impl Into<String>>,
    ) -> Self {
        Self::ListenerStatus {
            status,
            message: message.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct KeyboardTarget {
    pub(crate) zone: KeyboardZone,
    /// Anonymous horizontal position on the keyboard, from physical left to right.
    pub(crate) x: f64,
    /// Anonymous depth on the keyboard: 0 is nearest the character, 1 is farthest.
    pub(crate) y: f64,
}

const fn keyboard_target(zone: KeyboardZone, x: f64, y: f64) -> KeyboardTarget {
    KeyboardTarget { zone, x, y }
}

/// Convert a concrete key into an anonymous animation target immediately.
/// No key identity or typed content crosses IPC or is persisted.
pub(crate) fn classify_key_target(key: Key) -> KeyboardTarget {
    use Key::*;

    match key {
        // The illustrated keyboard is a compact five-column board facing the
        // character. Its visible alphanumeric rows are Z-X-C-V-B, A-S-D-F-G,
        // Q-W-E-R-T and 1-2-3-4-5. Column coordinates run in physical-keyboard
        // order; the frontend mirrors them for the viewer-facing projection.
        Space => keyboard_target(KeyboardZone::Space, -0.86, 0.00),
        Return | KpReturn => keyboard_target(KeyboardZone::Enter, -1.0, 0.58),
        Backspace | Delete | KpDelete => keyboard_target(KeyboardZone::Backspace, 1.0, 0.04),

        ControlLeft | MetaLeft => keyboard_target(KeyboardZone::Left, -0.94, 0.02),
        Alt => keyboard_target(KeyboardZone::Left, -0.58, 0.02),
        AltGr => keyboard_target(KeyboardZone::Right, 0.58, 0.02),
        ControlRight | MetaRight => keyboard_target(KeyboardZone::Right, 0.94, 0.02),
        ShiftLeft => keyboard_target(KeyboardZone::Left, -0.94, 0.23),
        ShiftRight => keyboard_target(KeyboardZone::Right, 0.94, 0.23),
        CapsLock => keyboard_target(KeyboardZone::Left, -0.97, 0.48),
        Tab => keyboard_target(KeyboardZone::Left, -0.98, 0.73),

        KeyZ => keyboard_target(KeyboardZone::Left, -1.0, 0.17),
        KeyX => keyboard_target(KeyboardZone::Left, -0.5, 0.17),
        KeyC => keyboard_target(KeyboardZone::Left, 0.0, 0.17),
        KeyV => keyboard_target(KeyboardZone::Center, 0.5, 0.17),
        KeyB => keyboard_target(KeyboardZone::Center, 1.0, 0.17),
        KeyN | KeyM | Comma | Dot | Slash => keyboard_target(KeyboardZone::Right, 1.0, 0.17),

        KeyA => keyboard_target(KeyboardZone::Left, -1.0, 0.45),
        KeyS => keyboard_target(KeyboardZone::Left, -0.5, 0.45),
        KeyD => keyboard_target(KeyboardZone::Left, 0.0, 0.45),
        KeyF => keyboard_target(KeyboardZone::Left, 0.5, 0.45),
        KeyG => keyboard_target(KeyboardZone::Center, 1.0, 0.45),
        KeyH => keyboard_target(KeyboardZone::Center, 1.0, 0.45),
        KeyJ | KeyK | KeyL | SemiColon | Quote => keyboard_target(KeyboardZone::Right, 1.0, 0.45),

        KeyQ => keyboard_target(KeyboardZone::Left, -1.0, 0.73),
        KeyW => keyboard_target(KeyboardZone::Left, -0.5, 0.73),
        KeyE => keyboard_target(KeyboardZone::Left, 0.0, 0.73),
        KeyR => keyboard_target(KeyboardZone::Left, 0.5, 0.73),
        KeyT => keyboard_target(KeyboardZone::Center, 1.0, 0.73),
        KeyY | KeyU | KeyI | KeyO | KeyP | LeftBracket | RightBracket | BackSlash => {
            keyboard_target(KeyboardZone::Right, 1.0, 0.73)
        }

        BackQuote => keyboard_target(KeyboardZone::Left, -1.0, 0.97),
        Num1 => keyboard_target(KeyboardZone::Left, -1.0, 0.98),
        Num2 => keyboard_target(KeyboardZone::Left, -0.5, 0.98),
        Num3 => keyboard_target(KeyboardZone::Left, 0.0, 0.98),
        Num4 => keyboard_target(KeyboardZone::Left, 0.5, 0.98),
        Num5 => keyboard_target(KeyboardZone::Center, 1.0, 0.98),
        Num6 | Num7 | Num8 | Num9 | Num0 => keyboard_target(KeyboardZone::Right, 1.0, 0.98),
        Minus | Equal => keyboard_target(KeyboardZone::Right, 1.0, 0.97),

        KpMinus | KpPlus | KpMultiply | KpDivide | Kp0 | Kp1 | Kp2 | Kp3 | Kp4 | Kp5 | Kp6
        | Kp7 | Kp8 | Kp9 => keyboard_target(KeyboardZone::Right, 1.0, 0.62),

        _ => keyboard_target(KeyboardZone::Other, 0.0, 0.50),
    }
}

pub(crate) fn classify_key(key: Key) -> KeyboardZone {
    classify_key_target(key).zone
}

/// A short, non-persistent physical-key label for the on-screen key bubble.
/// It deliberately avoids `Event::name`, so composed text and the user's
/// actual typed content never cross the backend/frontend boundary.
pub(crate) const fn display_key_label(key: Key) -> &'static str {
    use Key::*;

    match key {
        KeyA => "A",
        KeyB => "B",
        KeyC => "C",
        KeyD => "D",
        KeyE => "E",
        KeyF => "F",
        KeyG => "G",
        KeyH => "H",
        KeyI => "I",
        KeyJ => "J",
        KeyK => "K",
        KeyL => "L",
        KeyM => "M",
        KeyN => "N",
        KeyO => "O",
        KeyP => "P",
        KeyQ => "Q",
        KeyR => "R",
        KeyS => "S",
        KeyT => "T",
        KeyU => "U",
        KeyV => "V",
        KeyW => "W",
        KeyX => "X",
        KeyY => "Y",
        KeyZ => "Z",
        Num0 => "0",
        Num1 => "1",
        Num2 => "2",
        Num3 => "3",
        Num4 => "4",
        Num5 => "5",
        Num6 => "6",
        Num7 => "7",
        Num8 => "8",
        Num9 => "9",
        Space => "Space",
        Return | KpReturn => "Enter",
        Backspace => "Backspace",
        Delete | KpDelete => "Delete",
        Tab => "Tab",
        Escape => "Esc",
        CapsLock => "Caps Lock",
        ShiftLeft | ShiftRight => "Shift",
        ControlLeft | ControlRight => "Control",
        MetaLeft | MetaRight => "Command",
        Alt | AltGr => "Option",
        Function => "Fn",
        LeftArrow => "←",
        RightArrow => "→",
        UpArrow => "↑",
        DownArrow => "↓",
        Home => "Home",
        End => "End",
        PageUp => "Page Up",
        PageDown => "Page Down",
        Insert => "Insert",
        F1 => "F1",
        F2 => "F2",
        F3 => "F3",
        F4 => "F4",
        F5 => "F5",
        F6 => "F6",
        F7 => "F7",
        F8 => "F8",
        F9 => "F9",
        F10 => "F10",
        F11 => "F11",
        F12 => "F12",
        BackQuote => "`",
        Minus => "-",
        Equal => "=",
        LeftBracket => "[",
        RightBracket => "]",
        SemiColon => ";",
        Quote => "'",
        BackSlash | IntlBackslash => "\\",
        Comma => ",",
        Dot => ".",
        Slash => "/",
        Kp0 => "Num 0",
        Kp1 => "Num 1",
        Kp2 => "Num 2",
        Kp3 => "Num 3",
        Kp4 => "Num 4",
        Kp5 => "Num 5",
        Kp6 => "Num 6",
        Kp7 => "Num 7",
        Kp8 => "Num 8",
        Kp9 => "Num 9",
        KpMinus => "Num -",
        KpPlus => "Num +",
        KpMultiply => "Num ×",
        KpDivide => "Num ÷",
        PrintScreen => "Print Screen",
        ScrollLock => "Scroll Lock",
        Pause => "Pause",
        NumLock => "Num Lock",
        Unknown(_) => "其他键",
    }
}

pub(crate) fn classify_button(button: Button) -> MouseButton {
    match button {
        Button::Left => MouseButton::Left,
        Button::Right => MouseButton::Right,
        Button::Middle | Button::Unknown(_) => MouseButton::Other,
    }
}

pub(crate) fn cadence_from_interval(interval: Option<Duration>) -> Cadence {
    let Some(interval) = interval else {
        return Cadence::Slow;
    };

    if interval <= Duration::from_millis(70) {
        Cadence::Burst
    } else if interval <= Duration::from_millis(160) {
        Cadence::Fast
    } else if interval <= Duration::from_millis(350) {
        Cadence::Normal
    } else {
        Cadence::Slow
    }
}

fn quantize_axis(delta: f64) -> i8 {
    if !delta.is_finite() || delta.abs() < POINTER_DEAD_ZONE {
        0
    } else if delta.is_sign_positive() {
        1
    } else {
        -1
    }
}

fn normalize(value: f64, value_at_max: f64) -> f64 {
    if !value.is_finite() || value <= 0.0 || value_at_max <= 0.0 {
        0.0
    } else {
        (value / value_at_max).clamp(0.0, 1.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct DisplayBounds {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

/// Converts an absolute pointer position to a privacy-safe position within
/// the display that contains it. Positions in gaps between displays (or past
/// an outer display edge) deliberately return `None`, allowing the frontend
/// to hold the last valid gaze instead of snapping back to the center.
pub(crate) fn normalize_pointer_in_display(
    x: f64,
    y: f64,
    bounds: DisplayBounds,
) -> Option<(f64, f64)> {
    if !x.is_finite()
        || !y.is_finite()
        || !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || x < bounds.x
        || y < bounds.y
        || x >= bounds.x + bounds.width
        || y >= bounds.y + bounds.height
    {
        return None;
    }

    Some((
        (((x - bounds.x) / bounds.width) * 2.0 - 1.0).clamp(-1.0, 1.0),
        (((y - bounds.y) / bounds.height) * 2.0 - 1.0).clamp(-1.0, 1.0),
    ))
}

#[derive(Debug, Default)]
pub(crate) struct PointerAccumulator {
    last_position: Option<(f64, f64)>,
    delta_x: f64,
    delta_y: f64,
    distance: f64,
    wheel_y: i64,
    position_idle_frames: u8,
    gaze_position: Option<(f64, f64)>,
    gaze_dirty: bool,
}

impl PointerAccumulator {
    pub(crate) fn observe_position(&mut self, x: f64, y: f64, gaze_position: Option<(f64, f64)>) {
        if !x.is_finite() || !y.is_finite() {
            self.last_position = None;
            return;
        }

        if let Some((gaze_x, gaze_y)) = gaze_position.filter(|(gaze_x, gaze_y)| {
            gaze_x.is_finite()
                && gaze_y.is_finite()
                && (-1.0..=1.0).contains(gaze_x)
                && (-1.0..=1.0).contains(gaze_y)
        }) {
            let changed = self.gaze_position.is_none_or(|(previous_x, previous_y)| {
                (gaze_x - previous_x).abs() > f64::EPSILON
                    || (gaze_y - previous_y).abs() > f64::EPSILON
            });
            self.gaze_position = Some((gaze_x, gaze_y));
            self.gaze_dirty |= changed;
        }

        let Some((previous_x, previous_y)) = self.last_position.replace((x, y)) else {
            self.position_idle_frames = 0;
            return;
        };

        self.position_idle_frames = 0;
        let step_x = (x - previous_x).clamp(-MAX_POINTER_STEP, MAX_POINTER_STEP);
        let step_y = (y - previous_y).clamp(-MAX_POINTER_STEP, MAX_POINTER_STEP);
        self.delta_x += step_x;
        self.delta_y += step_y;
        self.distance += step_x.hypot(step_y);
    }

    pub(crate) fn observe_wheel(&mut self, delta_y: i64) {
        self.wheel_y = self.wheel_y.saturating_add(delta_y);
    }

    pub(crate) fn take_events(&mut self) -> Vec<InteractionEvent> {
        let mut events = Vec::with_capacity(2);
        let observed_motion = self.distance > 0.0;

        let x = quantize_axis(self.delta_x);
        let y = quantize_axis(self.delta_y);
        if x != 0 || y != 0 || self.gaze_dirty {
            let (gaze_x, gaze_y) = self.gaze_position.map_or((None, None), |(gaze_x, gaze_y)| {
                (Some(gaze_x), Some(gaze_y))
            });
            events.push(InteractionEvent::MouseMove {
                x,
                y,
                speed: normalize(self.distance, POINTER_SPEED_AT_MAX),
                gaze_x,
                gaze_y,
            });
        }

        if self.wheel_y != 0 {
            let direction = if self.wheel_y.is_positive() {
                WheelDirection::Up
            } else {
                WheelDirection::Down
            };
            events.push(InteractionEvent::MouseWheel {
                direction,
                intensity: normalize(self.wheel_y.unsigned_abs() as f64, WHEEL_INTENSITY_AT_MAX),
            });
        }

        self.delta_x = 0.0;
        self.delta_y = 0.0;
        self.distance = 0.0;
        self.wheel_y = 0;
        self.gaze_dirty = false;

        if observed_motion {
            self.position_idle_frames = 0;
        } else {
            self.position_idle_frames = self.position_idle_frames.saturating_add(1);
            if self.position_idle_frames >= POSITION_BASELINE_IDLE_FRAMES {
                // Absolute coordinates are needed only as a short-lived
                // baseline for the next delta; never retain an idle position.
                self.last_position = None;
                self.position_idle_frames = 0;
            }
        }
        events
    }

    pub(crate) fn reset(&mut self) {
        self.last_position = None;
        self.delta_x = 0.0;
        self.delta_y = 0.0;
        self.distance = 0.0;
        self.wheel_y = 0;
        self.position_idle_frames = 0;
        self.gaze_position = None;
        self.gaze_dirty = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_special_keys_into_animation_zones() {
        assert_eq!(classify_key(Key::Space), KeyboardZone::Space);
        assert_eq!(classify_key(Key::Return), KeyboardZone::Enter);
        assert_eq!(classify_key(Key::KpReturn), KeyboardZone::Enter);
        assert_eq!(classify_key(Key::Backspace), KeyboardZone::Backspace);
        assert_eq!(classify_key(Key::Delete), KeyboardZone::Backspace);
    }

    #[test]
    fn exposes_only_short_physical_labels_for_the_key_bubble() {
        assert_eq!(display_key_label(Key::KeyW), "W");
        assert_eq!(display_key_label(Key::Space), "Space");
        assert_eq!(display_key_label(Key::MetaLeft), "Command");
        assert_eq!(display_key_label(Key::Unknown(42)), "其他键");
    }

    #[test]
    fn classifies_three_physical_keyboard_zones() {
        assert_eq!(classify_key(Key::KeyW), KeyboardZone::Left);
        assert_eq!(classify_key(Key::KeyA), KeyboardZone::Left);
        assert_eq!(classify_key(Key::KeyS), KeyboardZone::Left);
        assert_eq!(classify_key(Key::KeyD), KeyboardZone::Left);
        assert_eq!(classify_key(Key::KeyG), KeyboardZone::Center);
        assert_eq!(classify_key(Key::KeyJ), KeyboardZone::Right);
        assert_eq!(classify_key(Key::Escape), KeyboardZone::Other);
    }

    #[test]
    fn maps_keys_within_one_zone_to_distinct_anonymous_targets() {
        let w = classify_key_target(Key::KeyW);
        let a = classify_key_target(Key::KeyA);
        let s = classify_key_target(Key::KeyS);
        let d = classify_key_target(Key::KeyD);
        assert_eq!(w.zone, KeyboardZone::Left);
        assert_eq!(a.zone, KeyboardZone::Left);
        assert_ne!((w.x, w.y), (a.x, a.y));
        assert_ne!((a.x, a.y), (s.x, s.y));
        assert_ne!((s.x, s.y), (d.x, d.y));
        for target in [w, a, s, d] {
            assert!((-1.0..=1.0).contains(&target.x));
            assert!((0.0..=1.0).contains(&target.y));
        }
    }

    #[test]
    fn maps_the_pictured_five_column_keyboard_one_to_one() {
        let rows = [
            (
                [Key::KeyZ, Key::KeyX, Key::KeyC, Key::KeyV, Key::KeyB],
                0.17,
            ),
            (
                [Key::KeyA, Key::KeyS, Key::KeyD, Key::KeyF, Key::KeyG],
                0.45,
            ),
            (
                [Key::KeyQ, Key::KeyW, Key::KeyE, Key::KeyR, Key::KeyT],
                0.73,
            ),
            (
                [Key::Num1, Key::Num2, Key::Num3, Key::Num4, Key::Num5],
                0.98,
            ),
        ];
        let pictured_columns = [-1.0, -0.5, 0.0, 0.5, 1.0];

        for (keys, pictured_row) in rows {
            for (key, pictured_column) in keys.into_iter().zip(pictured_columns) {
                let target = classify_key_target(key);
                assert_eq!(target.x, pictured_column);
                assert_eq!(target.y, pictured_row);
            }
        }

        assert_eq!(
            classify_key_target(Key::Space),
            keyboard_target(KeyboardZone::Space, -0.86, 0.0)
        );
        assert_eq!(
            classify_key_target(Key::Return),
            keyboard_target(KeyboardZone::Enter, -1.0, 0.58)
        );
    }

    #[test]
    fn classifies_only_left_and_right_mouse_buttons_by_name() {
        assert_eq!(classify_button(Button::Left), MouseButton::Left);
        assert_eq!(classify_button(Button::Right), MouseButton::Right);
        assert_eq!(classify_button(Button::Middle), MouseButton::Other);
        assert_eq!(classify_button(Button::Unknown(7)), MouseButton::Other);
    }

    #[test]
    fn quantizes_typing_cadence_at_stable_boundaries() {
        assert_eq!(cadence_from_interval(None), Cadence::Slow);
        assert_eq!(
            cadence_from_interval(Some(Duration::from_millis(351))),
            Cadence::Slow
        );
        assert_eq!(
            cadence_from_interval(Some(Duration::from_millis(350))),
            Cadence::Normal
        );
        assert_eq!(
            cadence_from_interval(Some(Duration::from_millis(160))),
            Cadence::Fast
        );
        assert_eq!(
            cadence_from_interval(Some(Duration::from_millis(70))),
            Cadence::Burst
        );
    }

    #[test]
    fn coalesces_absolute_positions_into_bounded_relative_motion() {
        let mut pointer = PointerAccumulator::default();
        pointer.observe_position(4_000.0, 2_000.0, Some((0.25, -0.5)));
        pointer.observe_position(4_020.0, 1_990.0, Some((0.3, -0.55)));

        let events = pointer.take_events();
        let json = serde_json::to_value(&events[0]).expect("serialize mouse movement");
        assert_eq!(json["kind"], "mouse-move");
        assert_eq!(json["x"], 1);
        assert_eq!(json["y"], -1);
        assert!(json["speed"]
            .as_f64()
            .is_some_and(|speed| { (0.0..=1.0).contains(&speed) }));
        assert!(!json.to_string().contains("4000"));
        assert!(!json.to_string().contains("2000"));
        assert_eq!(json["gazeX"], 0.3);
        assert_eq!(json["gazeY"], -0.55);
    }

    #[test]
    fn discards_an_idle_absolute_position_baseline() {
        let mut pointer = PointerAccumulator::default();
        pointer.observe_position(4_000.0, 2_000.0, None);
        for _ in 0..POSITION_BASELINE_IDLE_FRAMES {
            assert!(pointer.take_events().is_empty());
        }

        pointer.observe_position(4_020.0, 1_990.0, None);
        assert!(pointer.take_events().is_empty());
    }

    #[test]
    fn normalizes_pointer_inside_one_display_and_rejects_outside_points() {
        let bounds = DisplayBounds {
            x: -1_920.0,
            y: 0.0,
            width: 1_920.0,
            height: 1_080.0,
        };
        assert_eq!(
            normalize_pointer_in_display(-960.0, 540.0, bounds),
            Some((0.0, 0.0))
        );
        assert_eq!(
            normalize_pointer_in_display(-1_920.0, 0.0, bounds),
            Some((-1.0, -1.0))
        );
        assert_eq!(normalize_pointer_in_display(0.0, 540.0, bounds), None);
        assert_eq!(normalize_pointer_in_display(-960.0, 1_080.0, bounds), None);
    }

    #[test]
    fn emits_gaze_on_first_in_bounds_sample_without_a_relative_impulse() {
        let mut pointer = PointerAccumulator::default();
        pointer.observe_position(500.0, 400.0, Some((0.5, -0.25)));
        let events = pointer.take_events();
        assert_eq!(
            serde_json::to_value(&events[0]).expect("serialize gaze"),
            json!({
                "kind": "mouse-move",
                "x": 0,
                "y": 0,
                "speed": 0.0,
                "gazeX": 0.5,
                "gazeY": -0.25
            })
        );
    }

    #[test]
    fn coalesces_wheel_delta_into_direction_and_bounded_intensity() {
        let mut pointer = PointerAccumulator::default();
        pointer.observe_wheel(2);
        pointer.observe_wheel(8);

        let events = pointer.take_events();
        assert_eq!(
            serde_json::to_value(&events[0]).expect("serialize wheel"),
            json!({
                "kind": "mouse-wheel",
                "direction": "up",
                "intensity": 1.0
            })
        );
    }

    #[test]
    fn serializes_the_exact_privacy_safe_wire_shapes() {
        let keyboard = InteractionEvent::Keyboard {
            zone: KeyboardZone::Left,
            key_x: -0.7,
            key_y: 0.74,
            key_label: "W",
            state: ButtonState::Pressed,
            cadence: Cadence::Fast,
        };
        let button = InteractionEvent::MouseButton {
            button: MouseButton::Right,
            state: ButtonState::Released,
        };
        let status = InteractionEvent::listener_status(ListenerStatus::Running, None::<String>);

        assert_eq!(
            serde_json::to_value(keyboard).expect("serialize keyboard"),
            json!({
                "kind": "keyboard",
                "zone": "left",
                "keyX": -0.7,
                "keyY": 0.74,
                "keyLabel": "W",
                "state": "pressed",
                "cadence": "fast"
            })
        );
        assert_eq!(
            serde_json::to_value(button).expect("serialize button"),
            json!({
                "kind": "mouse-button",
                "button": "right",
                "state": "released"
            })
        );
        assert_eq!(
            serde_json::to_value(status).expect("serialize listener status"),
            json!({
                "kind": "listener-status",
                "status": "running"
            })
        );
    }
}
