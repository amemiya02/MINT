//! Whether this copy of MINT can update itself.
//!
//! The updater plugin is always registered so the app starts the same way in
//! every build, but a check only makes sense for a release build that was given
//! the updater public key (injected by the release workflow, see CONTRIBUTING.md)
//! and installed in a form the updater can replace.

use serde_json::Value;

/// How this copy of MINT was built and installed.
#[derive(Debug, Clone, Copy)]
pub struct Build {
    /// A debug build (`pnpm dev`, `cargo test`).
    pub debug: bool,
    /// On Linux, only the AppImage can replace itself; deb and rpm installs are
    /// updated by the package manager.
    pub linux_package_install: bool,
}

impl Build {
    pub fn current() -> Self {
        Self {
            debug: cfg!(debug_assertions),
            linux_package_install: cfg!(target_os = "linux")
                && std::env::var_os("APPIMAGE").is_none(),
        }
    }
}

/// `updater` is the `plugins.updater` object of the Tauri configuration.
pub fn supported(updater: Option<&Value>, build: Build) -> bool {
    if build.debug || build.linux_package_install {
        return false;
    }
    let Some(updater) = updater else {
        return false;
    };
    let has_pubkey = updater
        .get("pubkey")
        .and_then(Value::as_str)
        .is_some_and(|key| !key.trim().is_empty());
    let has_endpoint = updater
        .get("endpoints")
        .and_then(Value::as_array)
        .is_some_and(|endpoints| !endpoints.is_empty());
    has_pubkey && has_endpoint
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RELEASE: Build = Build {
        debug: false,
        linux_package_install: false,
    };

    fn configured() -> Value {
        json!({
            "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk=",
            "endpoints": ["https://github.com/amemiya02/MINT/releases/latest/download/latest.json"]
        })
    }

    #[test]
    fn a_release_build_with_key_and_endpoint_can_update() {
        assert!(supported(Some(&configured()), RELEASE));
    }

    #[test]
    fn without_a_public_key_updates_are_unavailable() {
        let mut config = configured();
        config["pubkey"] = json!("");
        assert!(!supported(Some(&config), RELEASE));
        assert!(!supported(None, RELEASE));
    }

    #[test]
    fn without_an_endpoint_updates_are_unavailable() {
        let mut config = configured();
        config["endpoints"] = json!([]);
        assert!(!supported(Some(&config), RELEASE));
    }

    #[test]
    fn debug_builds_never_update() {
        let build = Build {
            debug: true,
            ..RELEASE
        };
        assert!(!supported(Some(&configured()), build));
    }

    #[test]
    fn linux_package_installs_are_left_to_the_package_manager() {
        let build = Build {
            linux_package_install: true,
            ..RELEASE
        };
        assert!(!supported(Some(&configured()), build));
    }
}
