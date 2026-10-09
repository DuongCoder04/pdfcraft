#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::env;
use std::fs;
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Deserialize)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

#[tauri::command]
async fn open_files(app: tauri::AppHandle, filters: Vec<FileFilter>) -> Result<Vec<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file();

    for filter in filters {
        let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(filter.name, &exts);
    }

    builder.pick_files(move |paths| {
        let _ = tx.send(paths);
    });

    match rx.recv().map_err(|e| e.to_string())? {
        Some(paths) => {
            let mut result = Vec::new();
            for path in paths {
                let resolved_path = path.into_path().map_err(|e| e.to_string())?;
                result.push(resolved_path.display().to_string());
            }
            Ok(result)
        }
        None => Ok(vec![]),
    }
}

#[tauri::command]
async fn save_file(app: tauri::AppHandle, suggested_name: String, filters: Vec<FileFilter>) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file().set_file_name(suggested_name);

    for filter in filters {
        let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(filter.name, &exts);
    }

    builder.save_file(move |path| {
        let _ = tx.send(path);
    });

    match rx.recv().map_err(|e| e.to_string())? {
        Some(path) => {
            let resolved_path = path.into_path().map_err(|e| e.to_string())?;
            Ok(resolved_path.display().to_string())
        }
        None => Err("No file selected".to_string()),
    }
}

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_temp_dir() -> String {
    env::temp_dir().display().to_string()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Invalid URL scheme".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Unsupported platform for opening URL".to_string())
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Mitigate WebKitGTK / Mesa EGL display initialization failure under modern Wayland (EGL_BAD_PARAMETER)
        if env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            #[allow(unused_unsafe)]
            unsafe {
                env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(exe_path) = env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                let data_dir = exe_dir.join("data");
                let portable_marker = exe_dir.join("portable.txt");
                let is_portable = exe_path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_lowercase().contains("portable"))
                    .unwrap_or(false)
                    || data_dir.exists()
                    || portable_marker.exists();

                if is_portable {
                    let _ = fs::create_dir_all(&data_dir);
                    #[allow(unused_unsafe)]
                    unsafe {
                        env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data_dir);
                    }
                }
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            open_files,
            save_file,
            read_file,
            write_file,
            get_temp_dir,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
