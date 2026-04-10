// SPDX-License-Identifier: Hippocratic-3.0
use tauri::{Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Handle deep links (babelr://invite/CODE)
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event| {
                let url = event.payload();
                if let Some(code) = url.strip_prefix("babelr://invite/") {
                    // Navigate the webview to the invite URL
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.eval(&format!(
                            "window.location.hash = '/invite/{}'",
                            code
                        ));
                    }
                }
            });

            // Linux: enable MediaStream + WebRTC in the embedded webview
            // and auto-grant microphone permission requests. Without this,
            // webkit2gtk denies getUserMedia and voice channels silently
            // fail to connect.
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
                    let wv = webview.inner();
                    if let Some(settings) = wv.settings() {
                        settings.set_enable_media_stream(true);
                        settings.set_enable_webrtc(true);
                        settings.set_media_playback_requires_user_gesture(false);
                        settings.set_enable_mediasource(true);
                    }
                    wv.connect_permission_request(|_, request| {
                        request.allow();
                        true
                    });
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Babelr desktop app");
}
