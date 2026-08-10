#[derive(Debug, Clone, Copy)]
pub(crate) struct InputPermissionSnapshot {
    pub(crate) accessibility: bool,
    pub(crate) input_monitoring: bool,
}

impl InputPermissionSnapshot {
    pub(crate) fn granted(self) -> bool {
        self.accessibility && self.input_monitoring
    }

    pub(crate) fn denial_message(self) -> Option<&'static str> {
        match (self.accessibility, self.input_monitoring) {
            (false, false) => {
                Some("请在系统设置的“辅助功能”和“输入监控”中允许本应用，然后重新检测。")
            }
            (false, true) => {
                Some("请在系统设置 → 隐私与安全性 → 辅助功能中允许本应用，然后重新检测。")
            }
            (true, false) => {
                Some("请在系统设置 → 隐私与安全性 → 输入监控中允许本应用，然后重新检测。")
            }
            (true, true) => None,
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::{
        base::TCFType,
        boolean::CFBoolean,
        dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef},
    };

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
        static kAXTrustedCheckOptionPrompt: CFStringRef;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }

    pub(super) fn accessibility_is_trusted() -> bool {
        // SAFETY: This is Apple's read-only process trust query. It takes no
        // pointers and has no ownership or lifetime requirements.
        unsafe { AXIsProcessTrusted() != 0 }
    }

    pub(super) fn input_monitoring_is_trusted() -> bool {
        // SAFETY: This is Apple's read-only event-listening preflight query.
        // It does not request access and takes no pointers.
        unsafe { CGPreflightListenEventAccess() }
    }

    pub(super) fn request_accessibility_access() -> bool {
        // SAFETY: The exported key is a process-lifetime CoreFoundation
        // constant. Wrapping it under the get rule retains it for the local
        // dictionary, and the dictionary owns its references until dropped.
        let prompt_key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
        let options = CFDictionary::from_CFType_pairs(&[(prompt_key, CFBoolean::true_value())]);
        // SAFETY: AX reads the immutable dictionary synchronously and does not
        // retain the pointer after returning.
        unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0 }
    }

    pub(super) fn request_input_monitoring_access() -> bool {
        // SAFETY: This is Apple's process-scoped permission request. It takes
        // no pointers and returns the current authorization result.
        unsafe { CGRequestListenEventAccess() }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub(super) fn accessibility_is_trusted() -> bool {
        true
    }

    pub(super) fn input_monitoring_is_trusted() -> bool {
        true
    }

    pub(super) fn request_accessibility_access() -> bool {
        true
    }

    pub(super) fn request_input_monitoring_access() -> bool {
        true
    }
}

pub(crate) fn input_permission_snapshot() -> InputPermissionSnapshot {
    InputPermissionSnapshot {
        accessibility: platform::accessibility_is_trusted(),
        input_monitoring: platform::input_monitoring_is_trusted(),
    }
}

pub(crate) fn request_input_permissions() -> InputPermissionSnapshot {
    if !platform::accessibility_is_trusted() {
        let _ = platform::request_accessibility_access();
    }
    if !platform::input_monitoring_is_trusted() {
        let _ = platform::request_input_monitoring_access();
    }
    input_permission_snapshot()
}

#[cfg(test)]
mod tests {
    use super::InputPermissionSnapshot;

    #[test]
    fn permission_message_names_each_missing_scope() {
        assert!(InputPermissionSnapshot {
            accessibility: false,
            input_monitoring: false,
        }
        .denial_message()
        .is_some_and(|message| message.contains("辅助功能") && message.contains("输入监控")));
        assert!(InputPermissionSnapshot {
            accessibility: false,
            input_monitoring: true,
        }
        .denial_message()
        .is_some_and(|message| message.contains("辅助功能")));
        assert!(InputPermissionSnapshot {
            accessibility: true,
            input_monitoring: false,
        }
        .denial_message()
        .is_some_and(|message| message.contains("输入监控")));
        assert_eq!(
            InputPermissionSnapshot {
                accessibility: true,
                input_monitoring: true,
            }
            .denial_message(),
            None
        );
    }
}
