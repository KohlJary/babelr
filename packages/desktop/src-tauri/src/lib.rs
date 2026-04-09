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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Babelr desktop app");
}
