//! Enumerates installed applications for @ mentions in the input box (operation targets for computer use).
//!
//! The semantics are "installed" rather than "running" - cua-driver's own `list_apps`
//! reports running processes, whereas @ mentions target things not yet launched,
//! such as "open Safari and do ...", so the host scans the application directories itself.
//!
//! macOS: scans the top-level `.app` bundles under `/Applications`, `/System/Applications`
//! and `~/Applications`, reading `Contents/Info.plist` for the bundle id and display name.
//!
//! Windows: scans `.lnk` shortcuts under the system and user Start Menu `Programs`
//! directories (which matches users' mental boundary of "installed apps they can launch"),
//! resolving shortcuts to the target `.exe` absolute path as a stable identity - Windows has
//! no bundle id, so `bundle_id` is left empty and the whole frontend chain
//! (token/identity key/icon registry) falls back to the path. MSIX/UWP apps do not put
//! `.lnk` files in the Start Menu and are not covered for now.
//!
//! Other platforms return an empty list - cua-driver addresses by process name/window there,
//! with no equivalent stable "installed app" identifier, and the frontend's behavior for an
//! empty list is simply not showing the app group, so no platform branch is needed.
//!
//! Icons are always fetched uniformly through system APIs (macOS `NSWorkspace.iconForFile`,
//! Windows `SHGetFileInfoW`) rather than parsed from `.icns`/`.ico` ourselves: modern app
//! icons often live in Assets.car / resource sections, and the manifest field simply does not
//! exist, so only the system API can retrieve them uniformly. After fetching, they are converted
//! to 32px PNG data URLs (popup rows render at 16 logical pixels; 32 physical pixels cover
//! retina/high DPI) and returned once with the list - the list is fetched only once per session,
//! and a one-off payload of a few hundred KB is acceptable in exchange for zero extra frontend round trips.
//!
//! The host itself (ReactorPro.app) is intentionally excluded from the results: `cuaSelfGuard`
//! rejects all operations targeting the host, so leaving it among the candidates would let the user pick a guaranteed-to-fail entry.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledApp {
    pub name: String,
    /// macOS bundle id. In theory Info.plist can omit it; in that case the entry is not returned,
    /// because an app without a stable identity cannot be reliably addressed by CUA tools.
    pub bundle_id: String,
    pub path: String,
    /// The app icon in `data:image/png;base64,...` form; omitted when unavailable, and the
    /// frontend falls back to a generic app placeholder icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_data_url: Option<String>,
}

/// Enumerates installed applications, sorted by name and deduplicated by stable identity.
///
/// `exclude_bundle_id` is the host's own bundle id (from the tauri config) and is always
/// excluded on macOS, see the module docs; Windows has no bundle id concept, so the host is
/// excluded by the current process's exe path and this parameter is unused.
pub fn list_installed_apps(exclude_bundle_id: &str) -> Vec<InstalledApp> {
    #[cfg(target_os = "macos")]
    {
        list_macos_apps(exclude_bundle_id)
    }
    #[cfg(target_os = "windows")]
    {
        let _ = exclude_bundle_id;
        windows::list_windows_apps()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = exclude_bundle_id;
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn list_macos_apps(exclude_bundle_id: &str) -> Vec<InstalledApp> {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    let mut roots: Vec<PathBuf> = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
    }

    // BTreeMap gives "dedup by bundle id + stable order" in one step. The user directory comes
    // after the system directories, so for the same id the system install path seen first is kept.
    let mut by_bundle_id: BTreeMap<String, InstalledApp> = BTreeMap::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            let Some(app) = read_macos_app_bundle(&path) else {
                continue;
            };
            if app.bundle_id.eq_ignore_ascii_case(exclude_bundle_id) {
                continue;
            }
            by_bundle_id.entry(app.bundle_id.clone()).or_insert(app);
        }
    }

    let mut apps: Vec<InstalledApp> = by_bundle_id.into_values().collect();
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(target_os = "macos")]
fn read_macos_app_bundle(path: &std::path::Path) -> Option<InstalledApp> {
    let info = plist::Value::from_file(path.join("Contents/Info.plist")).ok()?;
    let dict = info.as_dictionary()?;
    let string_of = |key: &str| {
        dict.get(key)
            .and_then(|value| value.as_string())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    let bundle_id = string_of("CFBundleIdentifier")?;
    // Display name takes precedence; the bundle directory name (with .app stripped) always exists as the final fallback.
    let name = string_of("CFBundleDisplayName")
        .or_else(|| string_of("CFBundleName"))
        .or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .map(str::to_owned)
        })?;
    Some(InstalledApp {
        name,
        bundle_id,
        icon_data_url: macos_app_icon_data_url(path),
        path: path.to_string_lossy().into_owned(),
    })
}

/// App icon -> 32px PNG data URL. See the module docs: it must go through NSWorkspace, since
/// parsing .icns ourselves in the Assets.car era fails to find icons across the board.
///
/// The extraction path is `CGImageForProposedRect(32x32)` -> `NSBitmapImageRep` ->
/// PNG: NSImage decodes only the resolution tier that best matches the proposed rect. Do not
/// switch back to `TIFFRepresentation` - it materializes every resolution from 16 to 1024
/// (measured at 1GB / 8 seconds for 15 apps), whereas this path takes <1 second end to end.
///
/// AppKit image objects are not marked Send/Sync, so they are used only on the current call
/// stack and never held across threads; iconForFile and the bitmap conversion are UI-free
/// decoding operations, permitted on background threads (NSImage thread-safety list), and
/// safe together with the caller's spawn_blocking.
#[cfg(target_os = "macos")]
fn macos_app_icon_data_url(path: &std::path::Path) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    /// Popup rows render at 16 logical pixels; 32 physical pixels is 1:1 on retina.
    const TARGET_PIXELS: f64 = 32.0;

    let icon = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path.to_str()?));
    let mut proposed = NSRect {
        origin: NSPoint { x: 0.0, y: 0.0 },
        size: NSSize {
            width: TARGET_PIXELS,
            height: TARGET_PIXELS,
        },
    };
    let cg_image = unsafe { icon.CGImageForProposedRect_context_hints(&mut proposed, None, None) }?;
    let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg_image);
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(png.to_vec())
    ))
}

/// Minimal subset parser for MS-SHLLINK (`.lnk`): extracts only the target absolute path.
///
/// It is a pure byte parser and touches no Windows API, so it compiles unconditionally -
/// unit tests also run on macOS/Linux CI. The path priority matches shell parsing:
/// LinkInfo's LocalBasePath (Unicode offset preferred, ANSI fallback) ->
/// ExtraData's EnvironmentVariableDataBlock (installers commonly use the
/// `%ProgramFiles%\...` form, which requires expanding environment variables). If neither is
/// present (e.g. a shortcut pointing to a shell object), the entry is abandoned.
#[allow(dead_code)]
mod lnk {
    const HEADER_SIZE: usize = 0x4C;
    /// Disk byte order of LinkCLSID 00021401-0000-0000-C000-000000000046
    /// (Data1-3 little-endian, Data4 in original order).
    const LINK_CLSID: [u8; 16] = [
        0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x46,
    ];

    const HAS_LINK_TARGET_ID_LIST: u32 = 1 << 0;
    const HAS_LINK_INFO: u32 = 1 << 1;
    const HAS_NAME: u32 = 1 << 2;
    const HAS_RELATIVE_PATH: u32 = 1 << 3;
    const HAS_WORKING_DIR: u32 = 1 << 4;
    const HAS_ARGUMENTS: u32 = 1 << 5;
    const HAS_ICON_LOCATION: u32 = 1 << 6;
    const IS_UNICODE: u32 = 1 << 7;

    const ENV_VARIABLE_BLOCK_SIGNATURE: u32 = 0xA000_0001;
    /// EnvironmentVariableDataBlock fixed payload: 260 bytes ANSI + 520 bytes UTF-16.
    const ENV_BLOCK_ANSI_LEN: usize = 260;
    const ENV_BLOCK_UNICODE_LEN: usize = 520;

    fn u16_at(data: &[u8], offset: usize) -> Option<u16> {
        Some(u16::from_le_bytes(
            data.get(offset..offset + 2)?.try_into().ok()?,
        ))
    }

    fn u32_at(data: &[u8], offset: usize) -> Option<u32> {
        Some(u32::from_le_bytes(
            data.get(offset..offset + 4)?.try_into().ok()?,
        ))
    }

    /// Reads a NUL-terminated ANSI string from `offset` (up to `end`). The system ANSI
    /// code page is not portable, so this decodes as UTF-8 lossy: install paths are almost
    /// all ASCII, and only legacy non-ASCII ANSI paths with a missing Unicode offset reach
    /// this branch, so a replacement character is preferable to discarding the whole entry.
    fn ansi_z_at(data: &[u8], offset: usize, end: usize) -> Option<String> {
        let slice = data.get(offset..end.min(data.len()))?;
        let nul = slice.iter().position(|&byte| byte == 0)?;
        Some(String::from_utf8_lossy(&slice[..nul]).into_owned())
    }

    /// Reads a NUL-terminated UTF-16LE string from `offset` (up to `end`).
    fn utf16_z_at(data: &[u8], offset: usize, end: usize) -> Option<String> {
        let slice = data.get(offset..end.min(data.len()))?;
        let mut units = Vec::new();
        for pair in slice.chunks_exact(2) {
            let unit = u16::from_le_bytes([pair[0], pair[1]]);
            if unit == 0 {
                return Some(String::from_utf16_lossy(&units));
            }
            units.push(unit);
        }
        None
    }

    /// LinkInfo -> LocalBasePath (+ CommonPathSuffix).
    fn link_info_local_path(data: &[u8], base: usize, size: usize) -> Option<String> {
        let end = base.checked_add(size)?;
        if end > data.len() || size < 0x1C {
            return None;
        }
        let header_size = u32_at(data, base + 0x04)? as usize;
        let info_flags = u32_at(data, base + 0x08)?;
        // bit0 = VolumeIDAndLocalBasePath; with no local path (pure network shortcut) give up immediately.
        if info_flags & 1 == 0 {
            return None;
        }
        // The Unicode offset pair exists only when HeaderSize >= 0x24 (MS-SHLLINK 2.3).
        let unicode = header_size >= 0x24;
        let base_path = unicode
            .then(|| u32_at(data, base + 0x1C))
            .flatten()
            .and_then(|offset| utf16_z_at(data, base + offset as usize, end))
            .or_else(|| {
                let offset = u32_at(data, base + 0x10)? as usize;
                ansi_z_at(data, base + offset, end)
            })?;
        let suffix = unicode
            .then(|| u32_at(data, base + 0x20))
            .flatten()
            .and_then(|offset| utf16_z_at(data, base + offset as usize, end))
            .or_else(|| {
                let offset = u32_at(data, base + 0x18)? as usize;
                ansi_z_at(data, base + offset, end)
            })
            .unwrap_or_default();
        if base_path.is_empty() {
            return None;
        }
        if suffix.is_empty() {
            return Some(base_path);
        }
        let mut joined = base_path;
        if !joined.ends_with('\\') {
            joined.push('\\');
        }
        joined.push_str(&suffix);
        Some(joined)
    }

    /// Expands `%VAR%`-form environment variable references; undefined variables are left as-is
    /// (consistent with shell behavior; the later existence check filters out invalid paths).
    fn expand_env(value: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
        let mut out = String::with_capacity(value.len());
        let mut rest = value;
        while let Some(start) = rest.find('%') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            match after.find('%') {
                Some(close) => {
                    let name = &after[..close];
                    match lookup(name) {
                        Some(resolved) => out.push_str(&resolved),
                        None => {
                            out.push('%');
                            out.push_str(name);
                            out.push('%');
                        }
                    }
                    rest = &after[close + 1..];
                }
                None => {
                    out.push_str(&rest[start..]);
                    rest = "";
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// Parses a `.lnk` byte stream and returns the target absolute path. `env` injects the
    /// environment variable lookup; tests can pass a fake, and the Windows runtime passes `std::env::var`.
    pub fn resolve_target(data: &[u8], env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        if data.len() < HEADER_SIZE
            || u32_at(data, 0)? as usize != HEADER_SIZE
            || data[4..20] != LINK_CLSID
        {
            return None;
        }
        let flags = u32_at(data, 0x14)?;
        let mut offset = HEADER_SIZE;
        if flags & HAS_LINK_TARGET_ID_LIST != 0 {
            offset = offset.checked_add(2 + u16_at(data, offset)? as usize)?;
        }
        if flags & HAS_LINK_INFO != 0 {
            let size = u32_at(data, offset)? as usize;
            if let Some(path) = link_info_local_path(data, offset, size) {
                return Some(path);
            }
            offset = offset.checked_add(size)?;
        }
        // Skip StringData sections one by one (the character count excludes the trailing NUL; byte count doubles for Unicode).
        for flag in [
            HAS_NAME,
            HAS_RELATIVE_PATH,
            HAS_WORKING_DIR,
            HAS_ARGUMENTS,
            HAS_ICON_LOCATION,
        ] {
            if flags & flag == 0 {
                continue;
            }
            let chars = u16_at(data, offset)? as usize;
            let bytes = if flags & IS_UNICODE != 0 { chars * 2 } else { chars };
            offset = offset.checked_add(2 + bytes)?;
        }
        // ExtraData: look for EnvironmentVariableDataBlock. BlockSize < 8 is the terminating sentinel.
        loop {
            let size = u32_at(data, offset)? as usize;
            if size < 8 {
                return None;
            }
            let signature = u32_at(data, offset + 4)?;
            if signature == ENV_VARIABLE_BLOCK_SIGNATURE
                && size >= 8 + ENV_BLOCK_ANSI_LEN + ENV_BLOCK_UNICODE_LEN
            {
                let block_end = offset.checked_add(size)?;
                let raw = utf16_z_at(data, offset + 8 + ENV_BLOCK_ANSI_LEN, block_end)
                    .filter(|value| !value.is_empty())
                    .or_else(|| {
                        ansi_z_at(data, offset + 8, offset + 8 + ENV_BLOCK_ANSI_LEN)
                            .filter(|value| !value.is_empty())
                    })?;
                return Some(expand_env(&raw, env));
            }
            offset = offset.checked_add(size)?;
        }
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{lnk, InstalledApp};
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    /// Same as macOS: popup rows render at 16 logical pixels, and 32 physical pixels cover high DPI.
    /// SHGFI_LARGEICON retrieves exactly the system large icon (32x32 by default).
    pub fn list_windows_apps() -> Vec<InstalledApp> {
        let mut roots: Vec<PathBuf> = Vec::new();
        // System Start Menu first, user second: for the same target the first seen wins, matching
        // macOS's "system install path first" dedup orientation.
        if let Ok(program_data) = std::env::var("ProgramData") {
            roots.push(PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"));
        }
        if let Ok(app_data) = std::env::var("APPDATA") {
            roots.push(PathBuf::from(app_data).join(r"Microsoft\Windows\Start Menu\Programs"));
        }

        let host_exe = std::env::current_exe()
            .ok()
            .map(|path| normalize_identity(&path.to_string_lossy()));

        // SHGetFileInfoW requires the calling thread to have initialized COM (the caller is on a
        // spawn_blocking thread, which the process main thread's initialization does not cover).
        let _com = ComInit::new();

        let mut by_identity: BTreeMap<String, InstalledApp> = BTreeMap::new();
        for root in roots {
            // Start Menu vendor subdirectories are usually only one level deep; allow up to 4 for safety.
            for entry in walkdir::WalkDir::new(&root)
                .max_depth(4)
                .into_iter()
                .flatten()
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                let lnk_path = entry.path();
                if !lnk_path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("lnk"))
                {
                    continue;
                }
                let Some(target) = resolve_lnk_file(lnk_path) else {
                    continue;
                };
                let Some(name) = lnk_path
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .map(str::trim)
                    .filter(|stem| !stem.is_empty())
                    .map(str::to_owned)
                else {
                    continue;
                };
                if is_uninstaller(&name, &target) {
                    continue;
                }
                let identity = normalize_identity(&target);
                if host_exe.as_deref() == Some(identity.as_str()) {
                    continue;
                }
                by_identity.entry(identity).or_insert_with(|| InstalledApp {
                    name,
                    // Windows has no bundle id; the empty string maps to undefined on the frontend,
                    // and the token/identity key/icon registry all fall back to the path.
                    bundle_id: String::new(),
                    icon_data_url: app_icon_data_url(Path::new(&target)),
                    path: target,
                });
            }
        }

        let mut apps: Vec<InstalledApp> = by_identity.into_values().collect();
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        apps
    }

    /// Reads and parses a `.lnk`, keeping only targets that are "an existing `.exe`" - Start Menu
    /// shortcuts to documents/web pages/shell objects are not addressable applications.
    fn resolve_lnk_file(path: &Path) -> Option<String> {
        // The shortcut itself is a few KB; a 1 MB cap defends against corrupt files.
        let metadata = std::fs::metadata(path).ok()?;
        if metadata.len() > 1024 * 1024 {
            return None;
        }
        let data = std::fs::read(path).ok()?;
        let target = lnk::resolve_target(&data, &|name| std::env::var(name).ok())?;
        if !target.to_lowercase().ends_with(".exe") || !Path::new(&target).is_file() {
            return None;
        }
        Some(target)
    }

    /// Uninstallers are frequent noise among "installed apps" ("Uninstall Foo.lnk"), filtered
    /// both by shortcut name and by target file name.
    fn is_uninstaller(name: &str, target: &str) -> bool {
        let name = name.to_lowercase();
        let file = Path::new(target)
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_lowercase)
            .unwrap_or_default();
        name.contains("uninstall") || file.starts_with("unins")
    }

    /// Identity key = lowercased target path (NTFS is case-insensitive).
    fn normalize_identity(path: &str) -> String {
        path.to_lowercase()
    }

    /// COM initialization guard: CoUninitialize is paired on Drop only on success;
    /// RPC_E_CHANGED_MODE (the thread was already initialized under another model) counts as usable and is not paired.
    struct ComInit {
        initialized: bool,
    }

    impl ComInit {
        fn new() -> Self {
            use windows_sys::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
            let hr = unsafe {
                CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32)
            };
            Self { initialized: hr >= 0 }
        }
    }

    impl Drop for ComInit {
        fn drop(&mut self) {
            if self.initialized {
                unsafe { windows_sys::Win32::System::Com::CoUninitialize() };
            }
        }
    }

    /// The target exe's system icon -> 32px PNG data URL. Icon retrieval is delegated to
    /// `SHGetFileInfoW` (analogous to macOS delegating to NSWorkspace, see the module docs),
    /// HICON -> GDI bitmap to get BGRA pixels -> `image` crate encodes PNG.
    fn app_icon_data_url(target: &Path) -> Option<String> {
        use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{
            SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
        };
        use windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon;

        let wide: Vec<u16> = target
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut info: SHFILEINFOW = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            SHGetFileInfoW(
                wide.as_ptr(),
                0,
                &mut info,
                std::mem::size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON,
            )
        };
        if ok == 0 || info.hIcon.is_null() {
            return None;
        }
        let png = icon_to_png(info.hIcon);
        unsafe { DestroyIcon(info.hIcon) };
        Some(format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(png?)
        ))
    }

    /// HICON -> PNG bytes. The color bitmap is fetched as 32bpp top-down (BGRA); an all-zero
    /// alpha means a legacy mask icon - fetch the mask bitmap to reconstruct transparency.
    fn icon_to_png(icon: windows_sys::Win32::UI::WindowsAndMessaging::HICON) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::DeleteObject;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

        let mut icon_info: ICONINFO = unsafe { std::mem::zeroed() };
        if unsafe { GetIconInfo(icon, &mut icon_info) } == 0 {
            return None;
        }
        let color = icon_info.hbmColor;
        let mask = icon_info.hbmMask;
        let png = bitmaps_to_png(color, mask);
        // The bitmaps from GetIconInfo are owned by the caller and must be released (either may be non-null).
        if !color.is_null() {
            unsafe { DeleteObject(color) };
        }
        if !mask.is_null() {
            unsafe { DeleteObject(mask) };
        }
        png
    }

    fn bitmaps_to_png(
        color: windows_sys::Win32::Graphics::Gdi::HBITMAP,
        mask: windows_sys::Win32::Graphics::Gdi::HBITMAP,
    ) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::{GetObjectW, BITMAP};

        // A null hbmColor is a 1bpp all-mask icon (a Win16-era artifact) and not worth supporting.
        if color.is_null() {
            return None;
        }
        let mut bitmap: BITMAP = unsafe { std::mem::zeroed() };
        let read = unsafe {
            GetObjectW(
                color,
                std::mem::size_of::<BITMAP>() as i32,
                &mut bitmap as *mut BITMAP as *mut _,
            )
        };
        if read == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
            return None;
        }
        let width = bitmap.bmWidth as u32;
        let height = bitmap.bmHeight as u32;

        let mut pixels = bitmap_pixels_bgra(color, width, height)?;
        // BGRA -> RGBA.
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        if pixels.chunks_exact(4).all(|chunk| chunk[3] == 0) {
            // All-zero alpha channel: legacy icons express transparency via the mask (mask bit 1 = transparent).
            match (!mask.is_null())
                .then(|| bitmap_pixels_bgra(mask, width, height))
                .flatten()
            {
                Some(mask_pixels) => {
                    for (pixel, mask_pixel) in pixels
                        .chunks_exact_mut(4)
                        .zip(mask_pixels.chunks_exact(4))
                    {
                        pixel[3] = if mask_pixel[0] == 0 { 255 } else { 0 };
                    }
                }
                None => {
                    for chunk in pixels.chunks_exact_mut(4) {
                        chunk[3] = 255;
                    }
                }
            }
        }

        let buffer = image::RgbaImage::from_raw(width, height, pixels)?;
        let mut png = Vec::new();
        buffer
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        Some(png)
    }

    /// Any GDI bitmap -> 32bpp top-down BGRA pixels (GetDIBits handles the format conversion).
    fn bitmap_pixels_bgra(
        bitmap: windows_sys::Win32::Graphics::Gdi::HBITMAP,
        width: u32,
        height: u32,
    ) -> Option<Vec<u8>> {
        use windows_sys::Win32::Graphics::Gdi::{
            GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BI_RGB, DIB_RGB_COLORS,
        };

        let hdc = unsafe { GetDC(std::ptr::null_mut()) };
        if hdc.is_null() {
            return None;
        }
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = std::mem::size_of_val(&info.bmiHeader) as u32;
        info.bmiHeader.biWidth = width as i32;
        // Negative height = top-down row order, avoiding a manual flip.
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB as u32;
        let mut pixels = vec![0u8; width as usize * height as usize * 4];
        let lines = unsafe {
            GetDIBits(
                hdc,
                bitmap,
                0,
                height,
                pixels.as_mut_ptr() as *mut _,
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        unsafe { ReleaseDC(std::ptr::null_mut(), hdc) };
        (lines == height as i32).then_some(pixels)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excluded_bundle_id_never_appears() {
        // The list is always empty on non-macOS platforms, so the assertion holds trivially; on macOS
        // it runs a real scan, using a system app that must exist as a host stand-in to verify the exclusion logic.
        let apps = list_installed_apps("com.apple.finder");
        assert!(apps
            .iter()
            .all(|app| !app.bundle_id.eq_ignore_ascii_case("com.apple.finder")));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_listing_is_sorted_and_deduplicated() {
        let apps = list_installed_apps("");
        let mut names: Vec<String> = apps.iter().map(|app| app.name.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        names.clear();
        let mut ids: Vec<&str> = apps.iter().map(|app| app.bundle_id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), apps.len());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_listing_is_sorted_deduplicated_and_path_addressed() {
        let apps = list_installed_apps("com.xiaofei.liveagent");
        let names: Vec<String> = apps.iter().map(|app| app.name.to_lowercase()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
        let mut identities: Vec<String> = apps.iter().map(|app| app.path.to_lowercase()).collect();
        identities.sort_unstable();
        identities.dedup();
        assert_eq!(identities.len(), apps.len());
        for app in &apps {
            // Windows has no bundle id: identity is carried by the path, and the frontend falls back to the path.
            assert!(app.bundle_id.is_empty());
            assert!(app.path.to_lowercase().ends_with(".exe"));
            if let Some(icon) = &app.icon_data_url {
                assert!(icon.starts_with("data:image/png;base64,"));
            }
        }
    }

    /* ---- .lnk parsing (pure bytes, runs cross-platform) ---- */

    /// Minimal valid ShellLinkHeader: HeaderSize + LinkCLSID + LinkFlags.
    fn lnk_header(flags: u32) -> Vec<u8> {
        let mut data = vec![0u8; 0x4C];
        data[0..4].copy_from_slice(&0x4Cu32.to_le_bytes());
        data[4..20].copy_from_slice(&[
            0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x46,
        ]);
        data[0x14..0x18].copy_from_slice(&flags.to_le_bytes());
        data
    }

    #[test]
    fn lnk_parser_reads_link_info_local_base_path() {
        let path = b"C:\\Program Files\\Demo\\demo.exe\0";
        let path_offset = 0x1Cu32;
        // The suffix offset points to the path's trailing NUL -> empty suffix.
        let suffix_offset = path_offset + path.len() as u32 - 1;
        let total = 0x1C + path.len();
        let mut link_info = Vec::new();
        link_info.extend((total as u32).to_le_bytes());
        link_info.extend(0x1Cu32.to_le_bytes()); // LinkInfoHeaderSize: no Unicode offsets
        link_info.extend(1u32.to_le_bytes()); // VolumeIDAndLocalBasePath
        link_info.extend(0u32.to_le_bytes()); // VolumeIDOffset (not read by the parser)
        link_info.extend(path_offset.to_le_bytes());
        link_info.extend(0u32.to_le_bytes()); // CommonNetworkRelativeLinkOffset
        link_info.extend(suffix_offset.to_le_bytes());
        link_info.extend_from_slice(path);

        let mut data = lnk_header(1 << 1); // HasLinkInfo
        data.extend(link_info);
        assert_eq!(
            lnk::resolve_target(&data, &|_| None).as_deref(),
            Some("C:\\Program Files\\Demo\\demo.exe"),
        );
    }

    #[test]
    fn lnk_parser_prefers_unicode_local_base_path() {
        let ansi = b"C:\\legacy\\demo.exe\0";
        let unicode: Vec<u8> = "C:\\Café\\demo.exe\0"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let ansi_offset = 0x24u32;
        let unicode_offset = ansi_offset + ansi.len() as u32;
        // Both suffix offsets point to the trailing NUL of the corresponding string -> empty suffix.
        let suffix_ansi_offset = ansi_offset + ansi.len() as u32 - 1;
        let suffix_unicode_offset = unicode_offset + unicode.len() as u32 - 2;
        let total = 0x24 + ansi.len() + unicode.len();
        let mut link_info = Vec::new();
        link_info.extend((total as u32).to_le_bytes());
        link_info.extend(0x24u32.to_le_bytes()); // with Unicode offset pair
        link_info.extend(1u32.to_le_bytes());
        link_info.extend(0u32.to_le_bytes());
        link_info.extend(ansi_offset.to_le_bytes());
        link_info.extend(0u32.to_le_bytes());
        link_info.extend(suffix_ansi_offset.to_le_bytes());
        link_info.extend(unicode_offset.to_le_bytes());
        link_info.extend(suffix_unicode_offset.to_le_bytes());
        link_info.extend_from_slice(ansi);
        link_info.extend_from_slice(&unicode);

        let mut data = lnk_header(1 << 1);
        data.extend(link_info);
        assert_eq!(
            lnk::resolve_target(&data, &|_| None).as_deref(),
            Some("C:\\Café\\demo.exe"),
        );
    }

    #[test]
    fn lnk_parser_expands_environment_block_after_string_data() {
        // HasName | IsUnicode: correctly skip a UTF-16 StringData section first, then hit the
        // EnvironmentVariableDataBlock and expand %VAR%.
        let mut data = lnk_header((1 << 2) | (1 << 7));
        let name: Vec<u16> = "Demo App".encode_utf16().collect();
        data.extend((name.len() as u16).to_le_bytes());
        for unit in name {
            data.extend(unit.to_le_bytes());
        }
        let target = "%ProgramFiles%\\Demo\\demo.exe";
        let mut ansi = [0u8; 260];
        ansi[..target.len()].copy_from_slice(target.as_bytes());
        let mut unicode = [0u8; 520];
        for (i, unit) in target.encode_utf16().enumerate() {
            unicode[i * 2..i * 2 + 2].copy_from_slice(&unit.to_le_bytes());
        }
        data.extend(788u32.to_le_bytes()); // 8 + 260 + 520
        data.extend(0xA000_0001u32.to_le_bytes());
        data.extend_from_slice(&ansi);
        data.extend_from_slice(&unicode);
        data.extend(0u32.to_le_bytes()); // terminating sentinel block

        let resolved = lnk::resolve_target(&data, &|name| {
            (name == "ProgramFiles").then(|| "C:\\Program Files".to_owned())
        });
        assert_eq!(
            resolved.as_deref(),
            Some("C:\\Program Files\\Demo\\demo.exe"),
        );
    }

    #[test]
    fn lnk_parser_rejects_non_lnk_payloads() {
        assert_eq!(lnk::resolve_target(b"not a shortcut", &|_| None), None);
        // Header is valid but has no usable target section.
        assert_eq!(lnk::resolve_target(&lnk_header(0), &|_| None), None);
    }
}
