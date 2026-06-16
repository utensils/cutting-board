//! macOS PNG pasteboard integration.
//!
//! `copy_png_to_clipboard` writes already-encoded PNG bytes to the general
//! pasteboard as `NSPasteboardTypePNG` (preferred for Slack/Figma paste
//! fidelity — no re-encode). `read_clipboard_image` reads a PNG (or converts a
//! TIFF) from the pasteboard and returns base64 (no `data:` prefix).
//!
//! All AppKit work runs on the main thread via `run_on_main_thread` because
//! `NSPasteboard` / `NSBitmapImageRep` are not guaranteed thread-safe.

use tauri::{AppHandle, Manager};

use crate::state::AppState;

/// Write PNG bytes to the macOS pasteboard as `NSPasteboardTypePNG`.
///
/// The bytes are ALREADY PNG (the tldraw export); we never re-encode them.
#[tauri::command]
pub fn copy_png_to_clipboard(app: AppHandle, png: Vec<u8>) -> Result<(), String> {
    // Suppress auto-hide-on-blur while the pasteboard write happens; some
    // environments transiently shuffle focus during clipboard activity.
    let state = app.state::<AppState>();
    let guard = crate::window::SuppressGuard::new(&state);

    let result = imp::copy_png(&app, png);
    drop(guard);
    result
}

/// Return the current clipboard image as a base64 PNG (no `data:` prefix), or
/// `None`. Prefers `NSPasteboardTypePNG`; falls back to converting a
/// `NSPasteboardTypeTIFF` via `NSBitmapImageRep`.
#[tauri::command]
pub fn read_clipboard_image(app: AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<AppState>();
    let guard = crate::window::SuppressGuard::new(&state);

    let result = imp::read_image(&app);
    drop(guard);
    result
}

#[cfg(target_os = "macos")]
mod imp {
    use super::base64_min::encode as b64_encode;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardTypePNG,
        NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSData, NSDictionary};
    use std::sync::mpsc;
    use tauri::AppHandle;

    /// Run `f` on the main thread and return its result, propagating panics as
    /// `Err` strings.
    fn on_main<T, F>(app: &AppHandle, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce() -> T + Send + 'static,
    {
        let (tx, rx) = mpsc::channel::<T>();
        app.run_on_main_thread(move || {
            let _ = tx.send(f());
        })
        .map_err(|e| format!("run_on_main_thread: {e}"))?;
        rx.recv()
            .map_err(|e| format!("main-thread task dropped: {e}"))
    }

    pub fn copy_png(app: &AppHandle, png: Vec<u8>) -> Result<(), String> {
        on_main(app, move || {
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            let data = NSData::with_bytes(&png);
            // SAFETY: writing data for a system-defined type on the main thread.
            let ok = unsafe { pasteboard.setData_forType(Some(&data), NSPasteboardTypePNG) };
            if ok {
                Ok(())
            } else {
                Err("NSPasteboard setData:forType: returned false".to_string())
            }
        })?
    }

    pub fn read_image(app: &AppHandle) -> Result<Option<String>, String> {
        on_main(app, || {
            let pasteboard = NSPasteboard::generalPasteboard();

            // 1) Prefer raw PNG.
            if let Some(data) = unsafe { pasteboard.dataForType(NSPasteboardTypePNG) } {
                return Ok(Some(b64_encode(&data.to_vec())));
            }

            // 2) Fall back to TIFF -> PNG via NSBitmapImageRep.
            if let Some(tiff) = unsafe { pasteboard.dataForType(NSPasteboardTypeTIFF) } {
                let Some(rep) = NSBitmapImageRep::imageRepWithData(&tiff) else {
                    return Err("could not decode TIFF from pasteboard".to_string());
                };
                let props = NSDictionary::new();
                // SAFETY: re-encoding the decoded representation as PNG with an
                // empty (default) properties dictionary.
                let png = unsafe {
                    rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
                };
                return match png {
                    Some(png) => Ok(Some(b64_encode(&png.to_vec()))),
                    None => Err("TIFF->PNG conversion failed".to_string()),
                };
            }

            Ok(None)
        })?
    }
}

/// Minimal base64 encoder (RFC 4648, standard alphabet, with padding) so we do
/// not pull in an extra crate just for clipboard reads.
#[cfg(target_os = "macos")]
mod base64_min {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(ALPHABET[((n >> 18) & 0x3f) as usize] as char);
            out.push(ALPHABET[((n >> 12) & 0x3f) as usize] as char);
            if chunk.len() > 1 {
                out.push(ALPHABET[((n >> 6) & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
            if chunk.len() > 2 {
                out.push(ALPHABET[(n & 0x3f) as usize] as char);
            } else {
                out.push('=');
            }
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::encode;

        #[test]
        fn matches_known_vectors() {
            assert_eq!(encode(b""), "");
            assert_eq!(encode(b"f"), "Zg==");
            assert_eq!(encode(b"fo"), "Zm8=");
            assert_eq!(encode(b"foo"), "Zm9v");
            assert_eq!(encode(b"foob"), "Zm9vYg==");
            assert_eq!(encode(b"fooba"), "Zm9vYmE=");
            assert_eq!(encode(b"foobar"), "Zm9vYmFy");
        }

        #[test]
        fn encodes_binary_png_signature() {
            // PNG magic bytes.
            let png = [0x89u8, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
            assert_eq!(encode(&png), "iVBORw0KGgo=");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::AppHandle;

    pub fn copy_png(_app: &AppHandle, _png: Vec<u8>) -> Result<(), String> {
        unimplemented!("clipboard PNG write is only implemented on macOS")
    }

    pub fn read_image(_app: &AppHandle) -> Result<Option<String>, String> {
        Ok(None)
    }
}
