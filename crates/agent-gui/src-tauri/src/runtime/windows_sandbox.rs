//! Windows sandbox launcher (self-reexec model, no admin / no UAC).
//!
//! `sandbox::wrap_command` (Windows) does not return the real command directly; instead it wraps it
//! as a re-invocation of this exe:
//! `current_exe __sandbox_exec --write-root <root> --net on|off [--isolated] -- <program> <args...>`.
//! At the very start of process startup (the first line of `lib::run`) it calls
//! `run_sandbox_launcher_if_requested`: if that subcommand is detected, it picks the backend
//! according to `--net`, executes the real command in place, waits for it to exit, and exits with
//! its exit code -- never returning to initialize Tauri.
//!
//! Two backends (both without admin / without UAC; see memory `windows-sandbox-facts`, both
//! researched and adversarially verified):
//!
//! A. Networked sandbox (`--net on`) = Low Integrity primary token (`DuplicateTokenEx` +
//! `CreateProcessAsUserW`)
//! - Duplicates the current user's primary token, preserving the original logon session and
//!   SSPI/Schannel credentials; it sets no WFP/AppContainer network restrictions and injects no
//!   offline proxy or `*_OFFLINE` environment variables. Thus HTTP(S), DNS, loopback, LAN, and
//!   listening-port semantics match those of a non-sandboxed process.
//! - The child token is lowered to Low IL; the workspace, the fenced TEMP, and the narrow runtime
//!   caches required by PowerShell are also labeled Low. Mandatory Integrity Control's NoWriteUp
//!   denies writes to the Medium home, workspace parent directory, and drive roots, thereby
//!   preserving the workspace-write fence.
//! - Git Bash/PowerShell named objects and standard handles continue to receive Low IL / BNO
//!   compatibility handling to avoid `STATUS_DLL_INIT_FAILED`; these adjustments do not change the
//!   network policy.
//! - Cannot revert to `CreateRestrictedToken`: a restricted token makes Schannel's
//!   `AcquireCredentialsHandle` return `SEC_E_NO_CREDENTIALS`, which manifests as HTTPS failing in
//!   the networked sandbox.
//!
//! B. Offline sandbox (`--net off`) = AppContainer (`CreateProcessW` + `SECURITY_CAPABILITIES`)
//! - The AppContainer carries only a private file capability derived per workspace and no network
//!   capability; WFP therefore denies **all** network by default (including loopback) => enforced
//!   offline at the kernel level, with no elevation required. Compare Codex: unelevated only does
//!   env-level soft offline; enforced offline requires elevation to create a dedicated account +
//!   firewall/WFP rules.
//! - The AC denies unauthorized "reads" by default: system directories are readable via their
//!   built-in `ALL APPLICATION PACKAGES` ACE (the toolchain remains usable), while the user's home
//!   directory is unreadable by default => the offline variant incidentally gains read masking for
//!   sensitive directories (something the networked backend lacks).
//! - Write fence: the same authorized write ACE is reused against the private capability SID
//!   (workspace root + fenced temp directory). One cannot grant directly to the package SID:
//!   Windows treats objects containing a concrete AppContainer SID as package resources, and a
//!   plain Low-IL networked sandbox then cannot read that object even when it matches a user ACE.
//! - env overlay (defense in depth): `HTTP(S)_PROXY=http://127.0.0.1:9`, `CARGO_NET_OFFLINE`, etc.,
//!   making tools fail fast and explicitly on top of the kernel-level offline block (aligned with
//!   Codex `env.rs`).
//!
//! Both backends share the launch tail: `STARTUPINFOEXW` + `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`
//! inherits only 3 std handles (replacing the full handle-table inheritance of
//! `bInheritHandles=TRUE`, narrowing the handle-leak surface); an explicit
//! `lpDesktop = winsta0\default` (Low IL token/AC launches must set the desktop explicitly,
//! otherwise handle-station resolution is ambiguous); a Job Object `KILL_ON_JOB_CLOSE` provides a
//! fallback cascading kill when not isolated, while isolated long-lived processes skip it
//! (aligned with Linux bwrap omitting `--die-with-parent`); launch-failure exit codes (0xC0000142/
//! 0135/0022 as well as CLR `0xE0434352` / HRESULT `0x80070005`) are turned into readable
//! diagnostics uploaded through the existing pipe. Diagnostics such as skipped
//! stamps are not written to the child's stderr by default (which would pollute ManagedProcess
//! logs); only when `LIVEAGENT_SANDBOX_LOG=1` is set do they fall back to stderr.

/// Non-Windows: there is no self-reexec launcher, so this is a no-op.
#[cfg(not(windows))]
pub fn run_sandbox_launcher_if_requested() {}

/// Runtime probe for whether the two Windows backends can actually build a security context (P1#4).
/// Returns (networked Low IL token backend, offline AppContainer backend); non-Windows platforms do
/// not compile.
#[cfg(windows)]
pub(crate) fn probe_backends() -> (Result<(), String>, Result<(), String>) {
    (win::probe_networked_token(), win::probe_appcontainer())
}

/// Windows: if this process is the `__sandbox_exec` launcher, execute the real command and exit
/// with its exit code; otherwise return unchanged and let the normal Tauri startup flow continue.
#[cfg(windows)]
pub fn run_sandbox_launcher_if_requested() {
    use crate::runtime::sandbox::{parse_launcher_args, SANDBOX_EXEC_SUBCOMMAND};

    let raw: Vec<String> = std::env::args().collect();
    // raw[0] = the exe itself; raw[1] = the subcommand marker; raw[2..] = the launcher payload.
    if raw.get(1).map(String::as_str) != Some(SANDBOX_EXEC_SUBCOMMAND) {
        return;
    }

    let code = match parse_launcher_args(&raw[2..]) {
        Ok(inv) => {
            match win::execute(
                &inv.write_root,
                inv.allow_network,
                inv.isolated,
                &inv.program,
                &inv.args,
            ) {
                Ok(code) => code,
                Err(err) => {
                    // fail-closed: we are already in the sandbox launcher branch, so any token
                    // creation/derivation failure must prevent the command from executing at all;
                    // never fall back to running without a sandbox.
                    eprintln!("liveagent sandbox launcher failed: {err}");
                    127
                }
            }
        }
        Err(err) => {
            eprintln!("liveagent sandbox launcher: invalid arguments: {err}");
            127
        }
    };
    std::process::exit(code);
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, LocalFree, SetHandleInformation, HANDLE,
    };
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        ConvertStringSidToSidW, GetNamedSecurityInfoW, GetSecurityInfo, SetEntriesInAclW,
        SetNamedSecurityInfoW, SetSecurityInfo, EXPLICIT_ACCESS_W, TRUSTEE_W,
    };
    #[cfg(test)]
    use windows_sys::Win32::Security::CreateRestrictedToken;
    use windows_sys::Win32::Security::Isolation::{
        CreateAppContainerProfile, DeriveAppContainerSidFromAppContainerName,
    };
    use windows_sys::Win32::Security::{
        AddAccessAllowedAce, AddAce, CopySid, DeriveCapabilitySidsFromName, DuplicateTokenEx,
        EqualSid, FreeSid, GetAce, GetAclInformation, GetLengthSid, GetSecurityDescriptorSacl,
        GetTokenInformation, InitializeAcl, IsTokenRestricted, SetTokenInformation,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_SIZE_INFORMATION, SECURITY_CAPABILITIES,
        SID_AND_ATTRIBUTES, TOKEN_DEFAULT_DACL, TOKEN_GROUPS, TOKEN_USER,
    };
    use windows_sys::Win32::System::Console::GetStdHandle;
    use windows_sys::Win32::System::Environment::SetEnvironmentVariableW;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, HKEY, HKEY_CURRENT_USER,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
        GetCurrentProcessId, GetExitCodeProcess, InitializeProcThreadAttributeList,
        OpenProcessToken, ResumeThread, UpdateProcThreadAttribute, WaitForSingleObject,
        PROCESS_INFORMATION, STARTUPINFOEXW, STARTUPINFOW,
    };

    fn sandbox_diag(msg: impl std::fmt::Display) {
        if std::env::var_os("LIVEAGENT_SANDBOX_LOG").is_some() {
            eprintln!("{msg}");
        }
    }

    // Local constants replace reliance on per-feature constant exports from windows-sys: the field
    // types are all integer aliases (windows-sys uses type aliases rather than newtypes), so
    // assigning integer literals directly works and greatly reduces the compile risk of "is this
    // constant exported under this feature". Values are taken from the Win32 headers.
    const TOKEN_QUERY: u32 = 0x0008;
    const TOKEN_DUPLICATE: u32 = 0x0002;
    const TOKEN_ASSIGN_PRIMARY: u32 = 0x0001;
    const TOKEN_ADJUST_DEFAULT: u32 = 0x0080;

    #[cfg(test)]
    const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
    #[cfg(test)]
    const LUA_TOKEN: u32 = 0x4;
    #[cfg(test)]
    const WRITE_RESTRICTED: u32 = 0x8;

    const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
    const TOKEN_GROUPS_CLASS: i32 = 2; // TOKEN_INFORMATION_CLASS::TokenGroups
    const TOKEN_USER_CLASS: i32 = 1; // TokenUser
    const TOKEN_DEFAULT_DACL_CLASS: i32 = 6; // TOKEN_INFORMATION_CLASS::TokenDefaultDacl
    const TOKEN_INTEGRITY_LEVEL_CLASS: i32 = 25; // TokenIntegrityLevel

    const SE_FILE_OBJECT: i32 = 1; // SE_OBJECT_TYPE
    const SE_REGISTRY_KEY: i32 = 4;
    const SE_KERNEL_OBJECT: i32 = 6;
    const READ_CONTROL: u32 = 0x0002_0000;
    const WRITE_DAC: u32 = 0x0004_0000;
    const WRITE_OWNER: u32 = 0x0008_0000;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const DIRECTORY_QUERY: u32 = 0x1;
    const DIRECTORY_TRAVERSE: u32 = 0x2;
    const DIRECTORY_CREATE_OBJECT: u32 = 0x4;
    const DIRECTORY_CREATE_SUBDIRECTORY: u32 = 0x8;
    const DIRECTORY_ALL_ACCESS: u32 = 0x000F_000F;
    const OBJ_CASE_INSENSITIVE: u32 = 0x0000_0040;
    const OBJ_OPENIF: u32 = 0x0000_0080;
    const KEY_READ: u32 = 0x0002_0019;
    const KEY_WRITE: u32 = 0x0002_0006;
    const KEY_ALL_ACCESS: u32 = 0x000F_003F;
    const DACL_SECURITY_INFORMATION: u32 = 0x0000_0004;
    #[cfg(test)]
    const PROTECTED_DACL_SECURITY_INFORMATION: u32 = 0x8000_0000;
    const LABEL_SECURITY_INFORMATION: u32 = 0x0000_0010;
    const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;
    const OBJECT_INHERIT_ACE: u32 = 0x1;
    const CONTAINER_INHERIT_ACE: u32 = 0x2;
    const GRANT_ACCESS: i32 = 1; // ACCESS_MODE
    const REVOKE_ACCESS: i32 = 4;
    const TRUSTEE_IS_SID: i32 = 0; // TRUSTEE_FORM
    const TRUSTEE_IS_UNKNOWN: i32 = 0; // TRUSTEE_TYPE
    const ACL_SIZE_INFORMATION_CLASS: i32 = 2; // ACL_INFORMATION_CLASS::AclSizeInformation
    const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
    const ACL_REVISION: u32 = 2;
    const GENERIC_ALL: u32 = 0x1000_0000;
    const SE_GROUP_ENABLED: u32 = 0x0000_0004;

    // File access-rights masks (standard values); DELETE is defined locally to avoid import-site
    // ambiguity.
    const FILE_GENERIC_READ: u32 = 0x0012_0089;
    const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
    const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
    const DELETE_RIGHT: u32 = 0x0001_0000;

    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_SUSPENDED: u32 = 0x0000_0004;
    const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
    const INFINITE: u32 = 0xFFFF_FFFF;
    const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6; // (DWORD)-10
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // -11
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // -12

    // ProcThreadAttribute constants: the low 16 bits are the index, the high bits are flags
    // (values taken from the ProcThreadAttributeValue macro expansion in WinBase.h).
    // HANDLE_LIST=0x00020002, SECURITY_CAPABILITIES=0x00020009.
    const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;
    const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: usize = 0x0002_0009;
    // ProcThreadAttributeBnoIsolation = 19, Input flag => 0x00020013. Redirects Win32
    // Local\ names to a process-private prefix; MSYS calling NtCreateDirectoryObject directly is
    // unaffected.
    const PROC_THREAD_ATTRIBUTE_BNO_ISOLATION: usize = 0x0002_0013;

    #[repr(C)]
    struct ProcessBnoIsolationAttribute {
        isolation_enabled: i32,
        isolation_prefix: [u16; 136],
    }

    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS: i32 = 9; // JobObjectExtendedLimitInformation

    #[cfg(test)]
    const WRITE_RESTRICTED_SID: &str = "S-1-5-33";
    const LOW_INTEGRITY_SID: &str = "S-1-16-4096";
    const LOW_INTEGRITY_SDDL: &str = "S:(ML;OICI;NW;;;LW)";

    // NTSTATUS exit codes for early loader failures -- the child was killed by the kernel/loader
    // before it even reached main. Used to turn raw exit codes into readable diagnostics (see
    // loader_failure_hint).
    const STATUS_DLL_INIT_FAILED: u32 = 0xC000_0142;
    const STATUS_DLL_NOT_FOUND: u32 = 0xC000_0135;
    const STATUS_ACCESS_DENIED: u32 = 0xC000_0022;
    // CLR unhandled exception: PowerShell exits with this code after wrapping a CNG
    // `NTE_PROVIDER_DLL_FAIL` as a "failed to load BCrypt". It is not an NTSTATUS, and shell
    // probing previously missed it, treating a crashed pwsh as usable.
    const CLR_UNHANDLED_EXCEPTION: u32 = 0xE043_4352;
    const NTE_PROVIDER_DLL_FAIL: u32 = 0x8009_001D;
    // HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED): the direct exit code when Windows PowerShell /
    // .NET Framework fails to write the CLR user cache; it is not the same path as the CLR wrapper
    // code above.
    const E_ACCESSDENIED: u32 = 0x8007_0005;
    // The powershell.exe host does not return an HRESULT when CLR initialization fails; instead it
    // uses this wrapper code.
    const POWERSHELL_CLR_INIT_FAILED: u32 = 0xFFFF_0000;

    /// PSID alias (it is just `*mut c_void` in windows-sys), for readability.
    type PSID = *mut c_void;

    // The FFI boolean return in windows-sys 0.61 is `windows_sys::core::BOOL` (= i32); here i32 is
    // used directly as the parameter (a transparent alias that can accept the return of all these
    // functions).
    #[inline]
    fn ok(b: i32) -> bool {
        b != 0
    }

    fn last_error(ctx: &str) -> String {
        let code = unsafe { GetLastError() };
        format!("{ctx} (GetLastError={code})")
    }

    /// str -> NUL-terminated UTF-16.
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// A SID allocated by ConvertStringSidToSidW; LocalFree'd on Drop.
    struct LocalSid(PSID);

    impl Drop for LocalSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0 as _);
                }
            }
        }
    }

    /// `DeriveCapabilitySidsFromName` allocates both an array of SID pointers and each individual
    /// SID; both layers must be `LocalFree`'d. It is held only during derivation, after which the
    /// target SID is copied into a Rust-owned buffer.
    struct LocalSidArray {
        ptr: *mut PSID,
        count: u32,
    }

    impl Drop for LocalSidArray {
        fn drop(&mut self) {
            unsafe {
                if !self.ptr.is_null() {
                    for index in 0..self.count as usize {
                        let sid = *self.ptr.add(index);
                        if !sid.is_null() {
                            LocalFree(sid as _);
                        }
                    }
                    LocalFree(self.ptr as _);
                }
            }
        }
    }

    fn string_to_sid(s: &str) -> Result<LocalSid, String> {
        let wide = to_wide(s);
        let mut sid: PSID = null_mut();
        let r = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if !ok(r) || sid.is_null() {
            return Err(last_error(&format!("ConvertStringSidToSidW({s})")));
        }
        Ok(LocalSid(sid))
    }

    fn sddl_to_sd(sddl: &str) -> Result<*mut c_void, String> {
        let wide = to_wide(sddl);
        let mut sd: *mut c_void = null_mut();
        let r = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        };
        if !ok(r) || sd.is_null() {
            return Err(last_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
        Ok(sd)
    }

    fn with_low_integrity_sacl<T>(
        f: impl FnOnce(*mut ACL) -> Result<T, String>,
    ) -> Result<T, String> {
        let sd = sddl_to_sd(LOW_INTEGRITY_SDDL)?;
        let result = unsafe {
            let mut present: i32 = 0;
            let mut sacl: *mut ACL = null_mut();
            let mut defaulted: i32 = 0;
            if !ok(GetSecurityDescriptorSacl(
                sd,
                &mut present,
                &mut sacl,
                &mut defaulted,
            )) || sacl.is_null()
            {
                LocalFree(sd as _);
                return Err(last_error("GetSecurityDescriptorSacl(low integrity)"));
            }
            f(sacl)
        };
        unsafe {
            LocalFree(sd as _);
        }
        result
    }

    /// A networked child process retains the current user's full network/logon-session capability,
    /// so Low IL + NoWriteUp blocks the Medium home, drive roots, and workspace parent directory;
    /// the workspace and fenced TEMP remain writable after being labeled Low.
    fn set_token_low_integrity(token: HANDLE) -> Result<(), String> {
        let sid = string_to_sid(LOW_INTEGRITY_SID)?;
        let mut label = SID_AND_ATTRIBUTES {
            Sid: sid.0,
            Attributes: SE_GROUP_INTEGRITY,
        };
        let r = unsafe {
            SetTokenInformation(
                token,
                TOKEN_INTEGRITY_LEVEL_CLASS,
                &mut label as *mut _ as *mut c_void,
                std::mem::size_of::<SID_AND_ATTRIBUTES>() as u32,
            )
        };
        if !ok(r) {
            return Err(last_error("SetTokenInformation(TokenIntegrityLevel=Low)"));
        }
        Ok(())
    }

    fn set_low_integrity_label(object_type: i32, name: &str) -> Result<u32, String> {
        let mut path_wide = to_wide(name);
        with_low_integrity_sacl(|sacl| unsafe {
            Ok(SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                object_type,
                LABEL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                null_mut(),
                sacl,
            ))
        })
    }

    /// The Mandatory Label belongs to the SACL, but the access check for `LABEL_SECURITY_INFORMATION`
    /// requires `WRITE_OWNER`; the object owner only implicitly holds READ_CONTROL/WRITE_DAC, so an
    /// ordinary Modify DACL therefore returns ERROR_ACCESS_DENIED. Only on that error, grant the
    /// launcher user a minimal WRITE_OWNER ACE and retry, with no admin/UAC required, and without
    /// misclassifying other label/API errors as ACL problems.
    fn ensure_low_integrity_label(
        object_type: i32,
        name: &str,
        launcher_user_sid: PSID,
    ) -> Result<(), String> {
        let first = set_low_integrity_label(object_type, name)?;
        if first == 0 {
            return Ok(());
        }
        if first != ERROR_ACCESS_DENIED {
            return Err(format!(
                "SetNamedSecurityInfoW(low IL, {name}) failed (error={first})"
            ));
        }

        ensure_named_write_ace(object_type, name, launcher_user_sid, WRITE_OWNER).map_err(
            |grant_err| {
                format!(
                    "SetNamedSecurityInfoW(low IL, {name}) failed (error={first}); \
                     granting WRITE_OWNER to the launcher user also failed: {grant_err}"
                )
            },
        )?;
        let retry = set_low_integrity_label(object_type, name)?;
        if retry != 0 {
            return Err(format!(
                "SetNamedSecurityInfoW(low IL, {name}) failed after granting WRITE_OWNER \
                 (initial error={first}, retry error={retry})"
            ));
        }
        Ok(())
    }

    fn stamp_low_integrity_tree(path: &Path, launcher_user_sid: PSID) {
        for entry in walkdir::WalkDir::new(path).into_iter().flatten() {
            let name = entry.path().to_string_lossy();
            if let Err(err) = ensure_low_integrity_label(SE_FILE_OBJECT, &name, launcher_user_sid) {
                sandbox_diag(format!("liveagent sandbox: low IL skipped ({name}): {err}"));
            }
        }
    }

    fn set_handle_low_integrity(handle: HANDLE, label: &str) {
        let invalid: HANDLE = usize::MAX as HANDLE;
        if handle.is_null() || handle == invalid {
            return;
        }
        let _ = with_low_integrity_sacl(|sacl| {
            let rc = unsafe {
                SetSecurityInfo(
                    handle,
                    SE_KERNEL_OBJECT,
                    LABEL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    null_mut(),
                    sacl,
                )
            };
            if rc != 0 {
                sandbox_diag(format!(
                    "liveagent sandbox: std handle low IL skipped ({label}): error={rc}"
                ));
            }
            Ok(())
        });
    }

    fn looks_like_powershell(program: &Path) -> bool {
        let name = program.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.eq_ignore_ascii_case("powershell.exe") || name.eq_ignore_ascii_case("pwsh.exe")
    }

    fn ensure_runtime_low_integrity_surface(
        write_root: &Path,
        temp: &Path,
        program: &Path,
        launcher_user_sid: PSID,
    ) {
        stamp_low_integrity_tree(write_root, launcher_user_sid);
        if let Err(err) =
            ensure_low_integrity_label(SE_FILE_OBJECT, &temp.to_string_lossy(), launcher_user_sid)
        {
            sandbox_diag(format!(
                "liveagent sandbox: TEMP low IL skipped ({temp:?}): {err}"
            ));
        }
        if !looks_like_powershell(program) {
            return;
        }
        use crate::runtime::sandbox::{
            clr_user_file_dirs, cng_named_registry_object, cng_user_file_dirs,
            CLR_USER_REGISTRY_SUBKEYS, CNG_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .chain(CLR_USER_REGISTRY_SUBKEYS)
        {
            let name = cng_named_registry_object(subkey);
            if let Err(err) = ensure_low_integrity_label(SE_REGISTRY_KEY, &name, launcher_user_sid)
            {
                sandbox_diag(format!(
                    "liveagent sandbox: registry low IL skipped ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in cng_user_file_dirs(&appdata, &local)
            .into_iter()
            .chain(clr_user_file_dirs(&appdata, &local))
        {
            if let Err(err) = ensure_low_integrity_label(
                SE_FILE_OBJECT,
                &dir.to_string_lossy(),
                launcher_user_sid,
            ) {
                sandbox_diag(format!(
                    "liveagent sandbox: runtime dir low IL skipped ({dir:?}): {err}"
                ));
            }
        }
    }

    /// Opens the current process's primary token; includes DUPLICATE / ASSIGN_PRIMARY /
    /// ADJUST_DEFAULT so the networked backend can duplicate the primary token and set Low IL.
    fn open_process_token() -> Result<HANDLE, String> {
        let mut token: HANDLE = null_mut();
        let access = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
        let r = unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) };
        if !ok(r) {
            return Err(last_error("OpenProcessToken"));
        }
        Ok(token)
    }

    /// Reads the logon SID (SE_GROUP_LOGON_ID) from the token's TokenGroups and copies it into a
    /// self-owned byte buffer.
    fn logon_sid_bytes(token: HANDLE) -> Result<Vec<u8>, String> {
        let mut len: u32 = 0;
        // First call fetches the required length (expected to fail and set len).
        unsafe { GetTokenInformation(token, TOKEN_GROUPS_CLASS, null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(last_error("GetTokenInformation(TokenGroups) size probe"));
        }
        // Use a u64 buffer to guarantee 8-byte alignment (TOKEN_GROUPS contains pointers and
        // Vec<u8> does not guarantee alignment).
        let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
        let r = unsafe {
            GetTokenInformation(
                token,
                TOKEN_GROUPS_CLASS,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            )
        };
        if !ok(r) {
            return Err(last_error("GetTokenInformation(TokenGroups)"));
        }
        unsafe {
            let groups = buf.as_ptr() as *const TOKEN_GROUPS;
            let count = (*groups).GroupCount;
            let arr = (*groups).Groups.as_ptr();
            for i in 0..count as usize {
                let entry: &SID_AND_ATTRIBUTES = &*arr.add(i);
                if entry.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
                    let sid_len = GetLengthSid(entry.Sid);
                    if sid_len == 0 {
                        return Err(last_error("GetLengthSid(logon sid)"));
                    }
                    let mut sid_buf = vec![0u8; sid_len as usize];
                    if !ok(CopySid(sid_len, sid_buf.as_mut_ptr() as PSID, entry.Sid)) {
                        return Err(last_error("CopySid(logon sid)"));
                    }
                    return Ok(sid_buf);
                }
            }
        }
        Err("logon SID (SE_GROUP_LOGON_ID) not present in token".to_string())
    }

    fn token_user_sid_bytes(token: HANDLE) -> Result<Vec<u8>, String> {
        let mut len: u32 = 0;
        unsafe { GetTokenInformation(token, TOKEN_USER_CLASS, null_mut(), 0, &mut len) };
        if len == 0 {
            return Err(last_error("GetTokenInformation(TokenUser) size probe"));
        }
        let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
        let r = unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            )
        };
        if !ok(r) {
            return Err(last_error("GetTokenInformation(TokenUser)"));
        }
        unsafe {
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let sid_len = GetLengthSid(user.User.Sid);
            if sid_len == 0 {
                return Err(last_error("GetLengthSid(token user)"));
            }
            let mut sid_buf = vec![0u8; sid_len as usize];
            if !ok(CopySid(
                sid_len,
                sid_buf.as_mut_ptr() as PSID,
                user.User.Sid,
            )) {
                return Err(last_error("CopySid(token user)"));
            }
            Ok(sid_buf)
        }
    }

    /// Uses {logon SID, S-1-5-33, synthetic SID} as restricting SIDs to create a WRITE_RESTRICTED
    /// primary token.
    #[cfg(test)]
    fn create_restricted_token(base: HANDLE, restricting: &[PSID]) -> Result<HANDLE, String> {
        let mut sids: Vec<SID_AND_ATTRIBUTES> = restricting
            .iter()
            .map(|&sid| SID_AND_ATTRIBUTES {
                Sid: sid,
                Attributes: 0,
            })
            .collect();
        let mut restricted: HANDLE = null_mut();
        let flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED;
        let r = unsafe {
            CreateRestrictedToken(
                base,
                flags,
                0,
                null(),
                0,
                null(),
                sids.len() as u32,
                sids.as_mut_ptr(),
                &mut restricted,
            )
        };
        if !ok(r) {
            return Err(last_error("CreateRestrictedToken"));
        }
        Ok(restricted)
    }

    fn duplicate_primary_token(base: HANDLE) -> Result<HANDLE, String> {
        let mut token: HANDLE = null_mut();
        let access = TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT;
        let r = unsafe {
            DuplicateTokenEx(
                base,
                access,
                null(),
                2, // SecurityImpersonation
                1, // TokenPrimary
                &mut token,
            )
        };
        if !ok(r) {
            return Err(last_error("DuplicateTokenEx(TokenPrimary)"));
        }
        if ok(unsafe { IsTokenRestricted(token) }) {
            unsafe {
                CloseHandle(token);
            }
            return Err(
                "DuplicateTokenEx unexpectedly returned a restricted token; HTTPS credentials \
                 would be unavailable"
                    .to_string(),
            );
        }
        Ok(token)
    }

    /// Appends a "logon SID full control" ACE to the token's default DACL.
    ///
    /// Kernel objects newly created by the child process (msys/cygwin shared memory, signal pipes,
    /// events, etc.) inherit this DACL; the logon SID lets the same logon session reliably reopen
    /// these objects. GENERIC_ALL applies only to objects the process creates itself, so it does not
    /// loosen the file write fence.
    fn append_sid_to_default_dacl(token: HANDLE, sid: PSID) -> Result<(), String> {
        const ACL_APPEND_AT_END: u32 = 0xFFFF_FFFF; // MAXDWORD => AddAce appends to the end
        unsafe {
            let mut len: u32 = 0;
            GetTokenInformation(token, TOKEN_DEFAULT_DACL_CLASS, null_mut(), 0, &mut len);
            if len == 0 {
                return Err(last_error(
                    "GetTokenInformation(TokenDefaultDacl) size probe",
                ));
            }
            let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
            if !ok(GetTokenInformation(
                token,
                TOKEN_DEFAULT_DACL_CLASS,
                buf.as_mut_ptr() as *mut c_void,
                len,
                &mut len,
            )) {
                return Err(last_error("GetTokenInformation(TokenDefaultDacl)"));
            }
            let old_dacl = (*(buf.as_ptr() as *const TOKEN_DEFAULT_DACL)).DefaultDacl;
            // A NULL default DACL => new objects are unprotected (everyone full control), so both
            // checks pass naturally and no append is needed.
            if old_dacl.is_null() {
                return Ok(());
            }

            let mut info = ACL_SIZE_INFORMATION {
                AceCount: 0,
                AclBytesInUse: 0,
                AclBytesFree: 0,
            };
            if !ok(GetAclInformation(
                old_dacl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            )) {
                return Err(last_error("GetAclInformation(default DACL)"));
            }
            let sid_len = GetLengthSid(sid);
            if sid_len == 0 {
                return Err(last_error("GetLengthSid(default DACL trustee)"));
            }
            // ACCESS_ALLOWED_ACE includes a u32 SidStart placeholder, so the net increase is
            // struct size - 4 + SID length; the SID length is always a multiple of 4, naturally
            // satisfying the ACL's DWORD alignment.
            let ace_len = std::mem::size_of::<ACCESS_ALLOWED_ACE>() as u32 - 4 + sid_len;
            let new_len = ((info.AclBytesInUse + ace_len) + 3) & !3;

            let mut new_buf: Vec<u64> = vec![0u64; ((new_len as usize) + 7) / 8];
            let new_acl = new_buf.as_mut_ptr() as *mut ACL;
            if !ok(InitializeAcl(new_acl, new_len, ACL_REVISION)) {
                return Err(last_error("InitializeAcl(default DACL)"));
            }
            // Copy the original ACE order verbatim (the default DACL is all allow ACEs where order
            // has no semantics, but order is conservatively preserved anyway).
            for i in 0..info.AceCount {
                let mut ace: *mut c_void = null_mut();
                if !ok(GetAce(old_dacl, i, &mut ace)) || ace.is_null() {
                    return Err(last_error("GetAce(default DACL)"));
                }
                let size = (*(ace as *const ACE_HEADER)).AceSize as u32;
                if !ok(AddAce(new_acl, ACL_REVISION, ACL_APPEND_AT_END, ace, size)) {
                    return Err(last_error("AddAce(copy default DACL)"));
                }
            }
            if !ok(AddAccessAllowedAce(new_acl, ACL_REVISION, GENERIC_ALL, sid)) {
                return Err(last_error("AddAccessAllowedAce(logon sid)"));
            }
            let tdd = TOKEN_DEFAULT_DACL {
                DefaultDacl: new_acl,
            };
            // SetTokenInformation copies the DACL into the token, so freeing new_buf afterwards is
            // fine.
            if !ok(SetTokenInformation(
                token,
                TOKEN_DEFAULT_DACL_CLASS,
                &tdd as *const _ as *const c_void,
                std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )) {
                return Err(last_error("SetTokenInformation(TokenDefaultDacl)"));
            }
        }
        Ok(())
    }

    /// AppContainer SID (freed with FreeSid, unlike LocalSid's LocalFree).
    struct AcSid(PSID);

    impl Drop for AcSid {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    FreeSid(self.0);
                }
            }
        }
    }

    /// AC profile name: deterministic, one per workspace. Hard limit of 64 characters: prefix 18 +
    /// dir_key <= 43 (4 decimal u32 segments joined by underscores) = <= 61; the character set
    /// [0-9A-Za-z._] is valid.
    fn appcontainer_profile_name(dir_key: &str) -> String {
        format!("ReactorPro.Sandbox.{dir_key}")
    }

    /// The private capability serves only as a workspace identity in file/registry ACLs and does
    /// not correspond to any Windows network capability. The name is deterministically bound to the
    /// workspace, so different workspaces cannot write to each other.
    fn workspace_capability_name(dir_key: &str) -> String {
        format!("ReactorPro.Workspace.{dir_key}")
    }

    fn workspace_capability_sid(dir_key: &str) -> Result<Vec<u8>, String> {
        let name = workspace_capability_name(dir_key);
        let name_w = to_wide(&name);
        let mut group_ptr: *mut PSID = null_mut();
        let mut group_count = 0u32;
        let mut capability_ptr: *mut PSID = null_mut();
        let mut capability_count = 0u32;
        let derived = unsafe {
            DeriveCapabilitySidsFromName(
                name_w.as_ptr(),
                &mut group_ptr,
                &mut group_count,
                &mut capability_ptr,
                &mut capability_count,
            )
        };
        let _groups = LocalSidArray {
            ptr: group_ptr,
            count: group_count,
        };
        let capabilities = LocalSidArray {
            ptr: capability_ptr,
            count: capability_count,
        };
        if !ok(derived) {
            return Err(last_error(&format!("DeriveCapabilitySidsFromName({name})")));
        }
        if capabilities.ptr.is_null() || capabilities.count == 0 {
            return Err(format!(
                "DeriveCapabilitySidsFromName({name}) returned no capability SID"
            ));
        }
        unsafe {
            let sid = *capabilities.ptr;
            if sid.is_null() {
                return Err(format!(
                    "DeriveCapabilitySidsFromName({name}) returned a null capability SID"
                ));
            }
            let sid_len = GetLengthSid(sid);
            if sid_len == 0 {
                return Err(last_error("GetLengthSid(workspace capability)"));
            }
            let mut copied = vec![0u8; sid_len as usize];
            if !ok(CopySid(sid_len, copied.as_mut_ptr() as PSID, sid)) {
                return Err(last_error("CopySid(workspace capability)"));
            }
            Ok(copied)
        }
    }

    fn derive_appcontainer_profile_sid(dir_key: &str) -> Result<AcSid, String> {
        let name = appcontainer_profile_name(dir_key);
        let name_w = to_wide(&name);
        let mut sid: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
        if derived == 0 && !sid.is_null() {
            Ok(AcSid(sid))
        } else {
            Err(format!(
                "DeriveAppContainerSidFromAppContainerName({name}) failed hr={derived:#010X}"
            ))
        }
    }

    /// Gets (creating if necessary) the SID of the workspace-specific AppContainer profile.
    ///
    /// The profile itself registers no capability; at launch only the private workspace capability
    /// is injected, never a network capability, so WFP still denies all network by default including
    /// loopback. If Create fails (typically because it already exists), fall back to Derive; only if
    /// both fail does it error (fail-closed). The profile is kept and not deleted.
    fn appcontainer_profile_sid(dir_key: &str) -> Result<AcSid, String> {
        let name = appcontainer_profile_name(dir_key);
        let name_w = to_wide(&name);
        let display_w = to_wide("ReactorPro Sandbox (offline)");
        let desc_w = to_wide("ReactorPro per-workspace offline sandbox");
        let mut sid: PSID = null_mut();
        let created = unsafe {
            CreateAppContainerProfile(
                name_w.as_ptr(),
                display_w.as_ptr(),
                desc_w.as_ptr(),
                null(), // zero capabilities
                0,
                &mut sid,
            )
        };
        if created == 0 && !sid.is_null() {
            return Ok(AcSid(sid));
        }
        derive_appcontainer_profile_sid(dir_key).map_err(|derive_err| {
            format!(
                "AppContainer profile unavailable: CreateAppContainerProfile hr={created:#010X}; \
                 {derive_err}"
            )
        })
    }

    #[cfg(test)]
    pub(super) fn workspace_capability_sid_for_test(dir_key: &str) -> Result<String, String> {
        let sid = workspace_capability_sid(dir_key)?;
        sid_string(sid.as_ptr() as PSID)
    }

    #[cfg(test)]
    pub(super) fn seed_legacy_appcontainer_ace_for_test(
        path: &Path,
        dir_key: &str,
    ) -> Result<(), String> {
        let sid = derive_appcontainer_profile_sid(dir_key)?;
        ensure_write_ace(path, sid.0)
    }

    /// Test hook: purely derives an AC SID by name and converts it to string form (does not create a
    /// profile, no system side effects).
    #[cfg(test)]
    pub(super) fn appcontainer_profile_sid_for_test(name: &str) -> Option<String> {
        use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
        let name_w = to_wide(name);
        let mut sid: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
        if derived != 0 || sid.is_null() {
            return None;
        }
        let sid = AcSid(sid); // RAII:FreeSid
        let mut s: *mut u16 = null_mut();
        let r = unsafe { ConvertSidToStringSidW(sid.0, &mut s) };
        if !ok(r) || s.is_null() {
            return None;
        }
        let mut len = 0usize;
        unsafe {
            while *s.add(len) != 0 {
                len += 1;
            }
            let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, len));
            LocalFree(s as _);
            Some(out)
        }
    }

    /// Test hook (real machine): create a restricted token -> append the logon SID to the default
    /// DACL -> read back to verify the ACE really exists (the assertable part of the 0xC0000142 fix).
    /// Returns (contains logon SID before append, contains after append).
    #[cfg(test)]
    pub(super) fn default_dacl_fix_roundtrip_for_test() -> Result<(bool, bool), String> {
        fn dacl_contains(token: HANDLE, sid: PSID) -> Result<bool, String> {
            unsafe {
                let mut len: u32 = 0;
                GetTokenInformation(token, TOKEN_DEFAULT_DACL_CLASS, null_mut(), 0, &mut len);
                if len == 0 {
                    return Err(last_error("GetTokenInformation(TokenDefaultDacl) probe"));
                }
                let mut buf: Vec<u64> = vec![0u64; ((len as usize) + 7) / 8];
                if !ok(GetTokenInformation(
                    token,
                    TOKEN_DEFAULT_DACL_CLASS,
                    buf.as_mut_ptr() as *mut c_void,
                    len,
                    &mut len,
                )) {
                    return Err(last_error("GetTokenInformation(TokenDefaultDacl)"));
                }
                let dacl = (*(buf.as_ptr() as *const TOKEN_DEFAULT_DACL)).DefaultDacl;
                if dacl.is_null() {
                    return Ok(false);
                }
                let mut info = ACL_SIZE_INFORMATION {
                    AceCount: 0,
                    AclBytesInUse: 0,
                    AclBytesFree: 0,
                };
                if !ok(GetAclInformation(
                    dacl,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                    ACL_SIZE_INFORMATION_CLASS,
                )) {
                    return Err(last_error("GetAclInformation(TokenDefaultDacl)"));
                }
                for i in 0..info.AceCount {
                    let mut ace: *mut c_void = null_mut();
                    if !ok(GetAce(dacl, i, &mut ace)) || ace.is_null() {
                        continue;
                    }
                    if (*(ace as *const ACE_HEADER)).AceType == ACCESS_ALLOWED_ACE_TYPE {
                        let allow = ace as *const ACCESS_ALLOWED_ACE;
                        let sid_ptr = &(*allow).SidStart as *const u32 as PSID;
                        if ok(EqualSid(sid_ptr, sid)) {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
        }

        let synthetic = string_to_sid("S-1-5-21-1-2-3-4")?;
        let write_restricted = string_to_sid(WRITE_RESTRICTED_SID)?;
        let token = OwnedHandle(open_process_token()?);
        let logon = logon_sid_bytes(token.0)?;
        let logon_ptr = logon.as_ptr() as PSID;
        let restricting: [PSID; 3] = [logon_ptr, write_restricted.0, synthetic.0];
        let rt = OwnedHandle(create_restricted_token(token.0, &restricting)?);
        let before = dacl_contains(rt.0, logon_ptr)?;
        append_sid_to_default_dacl(rt.0, logon_ptr)?;
        let after = dacl_contains(rt.0, logon_ptr)?;
        Ok((before, after))
    }

    /// CloseHandle RAII: no longer need to manually close each branch on an early error return.
    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }

    /// ProcThreadAttributeList RAII (two-phase allocation; Delete on Drop).
    ///
    /// Note the lifetime contract: a value pointer attached via `set` must stay alive until this
    /// object is dropped (the MSDN requirement for UpdateProcThreadAttribute) -- the caller must
    /// declare the value **before** this object (Rust locals drop in reverse order => this object
    /// drops before the value).
    struct AttrList {
        buf: Vec<u64>, // u64 guarantees 8-byte alignment
    }

    impl AttrList {
        fn new(count: u32) -> Result<Self, String> {
            let mut size: usize = 0;
            unsafe { InitializeProcThreadAttributeList(null_mut(), count, 0, &mut size) };
            if size == 0 {
                return Err(last_error("InitializeProcThreadAttributeList size probe"));
            }
            let mut buf: Vec<u64> = vec![0u64; (size + 7) / 8];
            let r = unsafe {
                InitializeProcThreadAttributeList(
                    buf.as_mut_ptr() as *mut c_void,
                    count,
                    0,
                    &mut size,
                )
            };
            if !ok(r) {
                return Err(last_error("InitializeProcThreadAttributeList"));
            }
            Ok(Self { buf })
        }

        fn ptr(&mut self) -> *mut c_void {
            self.buf.as_mut_ptr() as *mut c_void
        }

        fn set(
            &mut self,
            attribute: usize,
            value: *const c_void,
            size: usize,
            ctx: &str,
        ) -> Result<(), String> {
            let r = unsafe {
                UpdateProcThreadAttribute(self.ptr(), 0, attribute, value, size, null_mut(), null())
            };
            if !ok(r) {
                return Err(last_error(ctx));
            }
            Ok(())
        }
    }

    impl Drop for AttrList {
        fn drop(&mut self) {
            unsafe { DeleteProcThreadAttributeList(self.buf.as_mut_ptr() as *mut c_void) };
        }
    }

    /// Maps early loader death of the child (before main) NTSTATUS exit codes to readable
    /// diagnostics (uploaded through the existing pipe via stderr to the model/UI; raw exit codes
    /// are not actionable for either users or models).
    fn loader_failure_hint(exit_code: u32) -> Option<&'static str> {
        match exit_code {
            STATUS_DLL_INIT_FAILED => Some(
                "a DLL failed to initialize under the sandbox (STATUS_DLL_INIT_FAILED); \
                 MSYS/Cygwin-based tools (e.g. Git Bash) may be incompatible here and the shell \
                 runner will try the next shell candidate (0xC0000142): MSYS/Cygwin-based tools \
                 such as Git Bash may be incompatible with this sandbox, and the shell will \
                 automatically try the next candidate",
            ),
            STATUS_DLL_NOT_FOUND => Some(
                "a required DLL was not found under the sandbox (STATUS_DLL_NOT_FOUND); the tool's \
                 install directory may be unreadable in this mode (0xC0000135): the tool's install \
                 directory may be unreadable in this mode",
            ),
            STATUS_ACCESS_DENIED => Some(
                "the sandbox denied access while starting the process (STATUS_ACCESS_DENIED); the \
                 program or its directory is not readable in this mode (0xC0000022): the program or \
                 its directory is not readable in this mode",
            ),
            CLR_UNHANDLED_EXCEPTION | NTE_PROVIDER_DLL_FAIL => Some(
                "the runtime failed during crypto provider init under the sandbox token \
                 (CLR 0xE0434352 / NTE_PROVIDER_DLL_FAIL); this is usually HKCU certificate-store \
                 or %APPDATA%\\Microsoft\\Crypto being unwritable, not a broken BCrypt.dll. The \
                 shell runner will try the next candidate (0xE0434352): crypto provider \
                 initialization failed under the sandbox, usually because the user certificate store \
                 or Crypto directory is unwritable rather than a broken local pwsh/BCrypt.dll; the \
                 shell will try the next candidate",
            ),
            E_ACCESSDENIED | POWERSHELL_CLR_INIT_FAILED => Some(
                "the runtime was denied a write during CLR/PowerShell startup \
                 (HRESULT 0x80070005 E_ACCESSDENIED / exit 0xFFFF0000); this is usually \
                 the user CLR cache or PowerShell module-analysis directory being \
                  unwritable at Low Integrity, not a broken powershell.exe. \
                 The shell runner will try the next candidate (0x80070005 / 0xFFFF0000): a write \
                 was denied during CLR/PowerShell startup under the sandbox, usually because the \
                 user CLR cache or PowerShell module-analysis directory is unwritable rather than a \
                 broken local powershell.exe; the shell will try the next candidate",
            ),
            _ => None,
        }
    }

    /// env overlay for the offline sandbox (defense in depth, aligned with Codex): on top of the
    /// kernel-level WFP block, it lets common tools fail fast and explicitly according to their own
    /// offline/proxy conventions without waiting for a TCP failure. The blackhole proxy points at
    /// 127.0.0.1:9 (the discard port, nothing listening; loopback is already denied inside the AC).
    /// It is set on the launcher's own environment and passed to the child via lpEnvironment=NULL
    /// inheritance (the same route as the TEMP redirect).
    fn set_offline_env() -> Result<(), String> {
        const BLACKHOLE: &str = "http://127.0.0.1:9";
        let pairs: &[(&str, &str)] = &[
            ("HTTP_PROXY", BLACKHOLE),
            ("HTTPS_PROXY", BLACKHOLE),
            ("ALL_PROXY", BLACKHOLE),
            ("NO_PROXY", ""), // clear the exception list so the blackhole proxy leaves no bypass (Windows env is case-insensitive and also covers lowercase variants)
            ("CARGO_NET_OFFLINE", "true"),
            ("PIP_NO_INDEX", "1"),
            ("NPM_CONFIG_OFFLINE", "true"),
        ];
        for (name, value) in pairs {
            let name_w = to_wide(name);
            let value_w = to_wide(value);
            unsafe {
                if !ok(SetEnvironmentVariableW(name_w.as_ptr(), value_w.as_ptr())) {
                    return Err(last_error(&format!("SetEnvironmentVariableW({name})")));
                }
            }
        }
        Ok(())
    }

    /// Whether the named object's DACL already has an ACE for the trustee SID with sufficient
    /// access bits. A hit is considered already stamped (inheritable ACEs propagate automatically to
    /// later-created child objects), skipping the expensive re-propagation. Any probe failure is
    /// treated as "not stamped".
    fn named_has_ace(object_type: i32, path_wide: &[u16], sid: PSID, required_access: u32) -> bool {
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 || dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return false;
            }
            let mut info = ACL_SIZE_INFORMATION {
                AceCount: 0,
                AclBytesInUse: 0,
                AclBytesFree: 0,
            };
            let mut found = false;
            if ok(GetAclInformation(
                dacl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            )) {
                for i in 0..info.AceCount {
                    let mut ace: *mut c_void = null_mut();
                    if !ok(GetAce(dacl, i, &mut ace)) || ace.is_null() {
                        continue;
                    }
                    let header = ace as *const ACE_HEADER;
                    if (*header).AceType == ACCESS_ALLOWED_ACE_TYPE {
                        let allow = ace as *const ACCESS_ALLOWED_ACE;
                        let sid_ptr = &(*allow).SidStart as *const u32 as PSID;
                        if ok(EqualSid(sid_ptr, sid))
                            && ((*allow).Mask & required_access) == required_access
                        {
                            found = true;
                            break;
                        }
                    }
                }
            }
            LocalFree(psd as _);
            found
        }
    }

    /// Stamps an inheritable (OI)(CI) authorized write ACE on a named object (only if absent).
    ///
    /// Why grant-only, never revoke (P3#8, a known tradeoff, not an oversight):
    /// - The trustee SID is deterministically derived from the workspace path => at most **one** ACE
    ///   per workspace (the `named_has_ace` idempotency guard), so it does not accumulate across
    ///   runs;
    /// - That SID maps to no active principal, so the leftover ACE grants no real user extra
    ///   permissions (inert and harmless);
    /// - The same workspace may have several sandbox processes alive concurrently (Bash +
    ///   ManagedProcess + resumable session), and revoking on process exit would break the write
    ///   fence of sibling processes still running;
    /// - Writing back the "post-revoke DACL" via `SetNamedSecurityInfoW` would also hit the empty
    ///   DACL trap (see the `old_dacl.is_null()` branch above).
    ///
    /// The cost is that Explorer/registry permission pages show an unresolvable S-1-5-21-* entry
    /// and uninstall does not clean it up. If cleanup is desired, it should be an explicit "clean
    /// sandbox ACEs" operational action (iterate the workspace list and delete the synthetic SIDs
    /// precisely), not something stuffed into a single command's lifecycle.
    fn ensure_named_write_ace(
        object_type: i32,
        name: &str,
        sid: PSID,
        access: u32,
    ) -> Result<(), String> {
        let mut path_wide = to_wide(name);
        if named_has_ace(object_type, &path_wide, sid, access) {
            return Ok(());
        }
        unsafe {
            let mut old_dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 {
                return Err(format!("GetNamedSecurityInfoW({name}) failed (error={rc})"));
            }

            // A NULL DACL = implicit "everyone full control": the target SID already has write
            // access, so no stamp is needed; using SetEntriesInAclW(oldacl=NULL) to build a
            // "target-SID-only" DACL and write it back would instead lock out normal
            // (non-sandboxed) access. So this case is skipped.
            if old_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Ok(());
            }

            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessPermissions = access;
            ea.grfAccessMode = GRANT_ACCESS;
            ea.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
            ea.Trustee = TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0, // NO_MULTIPLE_TRUSTEE
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            };

            let mut new_dacl: *mut ACL = null_mut();
            let rc = SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl);
            if rc != 0 || new_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Err(format!("SetEntriesInAclW({name}) failed (error={rc})"));
            }

            let rc = SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            );
            LocalFree(new_dacl as _);
            if !psd.is_null() {
                LocalFree(psd as _);
            }
            if rc != 0 {
                return Err(format!("SetNamedSecurityInfoW({name}) failed (error={rc})"));
            }
        }
        Ok(())
    }

    /// Precisely revokes a given trustee SID written by an older version. `REVOKE_ACCESS` removes
    /// only that SID's ACE, preserving the owner, inheritance settings, and the rest of the DACL;
    /// inheritance changes on the directory are propagated downward by Windows.
    fn remove_named_ace(object_type: i32, name: &str, sid: PSID) -> Result<(), String> {
        let mut path_wide = to_wide(name);
        if !named_has_ace(object_type, &path_wide, sid, 0) {
            return Ok(());
        }
        unsafe {
            let mut old_dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetNamedSecurityInfoW(
                path_wide.as_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 {
                return Err(format!("GetNamedSecurityInfoW({name}) failed (error={rc})"));
            }
            if old_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Ok(());
            }

            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessMode = REVOKE_ACCESS;
            ea.Trustee = TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            };
            let mut new_dacl: *mut ACL = null_mut();
            let rc = SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl);
            if rc != 0 || new_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Err(format!(
                    "SetEntriesInAclW(revoke {name}) failed (error={rc})"
                ));
            }
            let rc = SetNamedSecurityInfoW(
                path_wide.as_mut_ptr(),
                object_type,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            );
            LocalFree(new_dacl as _);
            if !psd.is_null() {
                LocalFree(psd as _);
            }
            if rc != 0 {
                return Err(format!(
                    "SetNamedSecurityInfoW(revoke {name}) failed (error={rc})"
                ));
            }
        }
        Ok(())
    }

    fn ensure_write_ace(path: &Path, sid: PSID) -> Result<(), String> {
        ensure_named_write_ace(
            SE_FILE_OBJECT,
            &path.to_string_lossy(),
            sid,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE_RIGHT,
        )
    }

    fn remove_write_ace(path: &Path, sid: PSID) -> Result<(), String> {
        remove_named_ace(SE_FILE_OBJECT, &path.to_string_lossy(), sid)
    }

    #[cfg(test)]
    pub(super) fn prepare_modify_only_low_il_probe(path: &Path) -> Result<(), String> {
        let token = OwnedHandle(open_process_token()?);
        let user = token_user_sid_bytes(token.0)?;
        let user_sid = user.as_ptr() as PSID;
        let mut ea: EXPLICIT_ACCESS_W = unsafe { std::mem::zeroed() };
        ea.grfAccessPermissions =
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE_RIGHT;
        ea.grfAccessMode = GRANT_ACCESS;
        ea.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
        ea.Trustee = TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: user_sid as *mut u16,
        };

        let mut dacl: *mut ACL = null_mut();
        let rc = unsafe { SetEntriesInAclW(1, &ea, null_mut(), &mut dacl) };
        if rc != 0 || dacl.is_null() {
            return Err(format!(
                "SetEntriesInAclW(modify-only probe) failed (error={rc})"
            ));
        }
        let mut name_wide = to_wide(&path.to_string_lossy());
        let rc = unsafe {
            SetNamedSecurityInfoW(
                name_wide.as_mut_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null_mut(),
            )
        };
        unsafe {
            LocalFree(dacl as _);
        }
        if rc != 0 {
            return Err(format!(
                "SetNamedSecurityInfoW(modify-only probe) failed (error={rc})"
            ));
        }

        let label_rc = set_low_integrity_label(SE_FILE_OBJECT, &path.to_string_lossy())?;
        if label_rc != ERROR_ACCESS_DENIED {
            return Err(format!(
                "modify-only probe should reject LABEL_SECURITY_INFORMATION with error 5, \
                 got {label_rc}"
            ));
        }
        Ok(())
    }

    fn create_hkcu_key(subkey: &str) -> Result<(), String> {
        let wide = to_wide(subkey);
        let mut hkey: HKEY = null_mut();
        let mut disposition: u32 = 0;
        let rc = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                wide.as_ptr(),
                0,
                null(),
                0,
                KEY_READ | KEY_WRITE,
                null(),
                &mut hkey,
                &mut disposition,
            )
        };
        if rc != 0 {
            return Err(format!("RegCreateKeyExW({subkey}) failed (error={rc})"));
        }
        unsafe {
            let _ = RegCloseKey(hkey);
        }
        Ok(())
    }

    fn ensure_plain_directory(path: &Path) -> Result<(), String> {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        std::fs::create_dir_all(path)
            .map_err(|err| format!("create dir {path:?} failed: {err}"))?;
        let meta = std::fs::symlink_metadata(path)
            .map_err(|err| format!("stat {path:?} failed: {err}"))?;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(format!("{path:?} is a reparse point; refusing to stamp"));
        }
        Ok(())
    }

    /// Stamps fence_sid write ACEs on the CAPI/CNG user certificate store and key containers.
    ///
    /// The launcher still holds the full user token at this point; stamping happens before
    /// `CreateProcessAsUserW`. A single failure only warns: the probing layer will skip a pwsh that
    /// still crashes (0xE0434352) and fall through to cmd, rather than declaring the whole sandbox
    /// dead because of certificate-store policy. Never stamp HKLM (requires admin).
    fn ensure_cng_user_write_surface(sid: PSID) {
        use crate::runtime::sandbox::{
            cng_named_registry_object, cng_user_file_dirs, CNG_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CNG_USER_REGISTRY_SUBKEYS {
            if let Err(err) = create_hkcu_key(subkey) {
                sandbox_diag(format!(
                    "liveagent sandbox: CNG registry create skipped ({subkey}): {err}"
                ));
                continue;
            }
            let name = cng_named_registry_object(subkey);
            if let Err(err) = ensure_named_write_ace(SE_REGISTRY_KEY, &name, sid, KEY_ALL_ACCESS) {
                sandbox_diag(format!(
                    "liveagent sandbox: CNG registry ACE skipped ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in cng_user_file_dirs(&appdata, &local) {
            if let Err(err) = ensure_plain_directory(&dir).and_then(|_| ensure_write_ace(&dir, sid))
            {
                sandbox_diag(format!(
                    "liveagent sandbox: CNG dir ACE skipped ({dir:?}): {err}"
                ));
            }
        }
    }

    /// Stamps fence_sid write ACEs on the .NET Framework / Windows PowerShell user runtime caches.
    ///
    /// This is an independent failure surface from the CNG certificate store: when denied here,
    /// powershell.exe crashes with `0x80070005`, not `0xE0434352`. A single failure only warns, and
    /// the probing layer will skip a powershell that still crashes. `assembly` (Fusion) stamps only
    /// the directory itself -- the tree may be large and new files rely on (OI)(CI) inheritance;
    /// the CLR_v4.0 / PowerShell caches are smaller, so the first stamp propagates downward to
    /// existing files, otherwise existing files such as `UsageLogs\powershell.exe.log` would still
    /// lack the restricting SID and writes would still be denied.
    fn ensure_clr_user_write_surface(sid: PSID) {
        use crate::runtime::sandbox::{
            clr_user_file_dirs, cng_named_registry_object, CLR_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CLR_USER_REGISTRY_SUBKEYS {
            if let Err(err) = create_hkcu_key(subkey) {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR registry create skipped ({subkey}): {err}"
                ));
                continue;
            }
            let name = cng_named_registry_object(subkey);
            if let Err(err) = ensure_named_write_ace(SE_REGISTRY_KEY, &name, sid, KEY_ALL_ACCESS) {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR registry ACE skipped ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in clr_user_file_dirs(&appdata, &local) {
            let stamp = if dir.file_name().is_some_and(|name| name == "assembly") {
                ensure_plain_directory(&dir).and_then(|_| ensure_write_ace(&dir, sid))
            } else {
                ensure_plain_directory(&dir).and_then(|_| ensure_write_ace_tree(&dir, sid))
            };
            if let Err(err) = stamp {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR dir ACE skipped ({dir:?}): {err}"
                ));
            }
        }
    }

    /// Early v1.3 versions wrote a concrete AppContainer profile SID into these persistent objects.
    /// That ACE makes a plain Low-IL networked process unable to access the same object; migration
    /// revokes only this workspace's deterministic profile SID, leaving other user/app/workspace
    /// ACEs unchanged.
    fn remove_legacy_appcontainer_runtime_surface(sid: PSID) {
        use crate::runtime::sandbox::{
            clr_user_file_dirs, cng_named_registry_object, cng_user_file_dirs,
            CLR_USER_REGISTRY_SUBKEYS, CNG_USER_REGISTRY_SUBKEYS,
        };
        for subkey in CNG_USER_REGISTRY_SUBKEYS
            .iter()
            .chain(CLR_USER_REGISTRY_SUBKEYS)
        {
            if create_hkcu_key(subkey).is_err() {
                continue;
            }
            let name = cng_named_registry_object(subkey);
            if let Err(err) = remove_named_ace(SE_REGISTRY_KEY, &name, sid) {
                sandbox_diag(format!(
                    "liveagent sandbox: legacy AppContainer registry ACE cleanup skipped \
                     ({name}): {err}"
                ));
            }
        }
        let (Some(appdata), Some(local)) = (dirs::data_dir(), dirs::data_local_dir()) else {
            return;
        };
        for dir in cng_user_file_dirs(&appdata, &local)
            .into_iter()
            .chain(clr_user_file_dirs(&appdata, &local))
        {
            if !dir.exists() {
                continue;
            }
            if let Err(err) = remove_write_ace(&dir, sid) {
                sandbox_diag(format!(
                    "liveagent sandbox: legacy AppContainer runtime ACE cleanup skipped \
                     ({dir:?}): {err}"
                ));
            }
        }
    }

    /// After the first write ACE is stamped on a directory, push the same ACE to existing child
    /// objects (up to 5 levels deep). Even when the fence SID is already present on the directory,
    /// still scan children: an earlier stamp may have covered only the directory itself, leaving
    /// existing files under UsageLogs without the restricting SID, and skipping the whole tree
    /// would let powershell keep failing with 0x80070005.
    fn ensure_write_ace_tree(path: &Path, sid: PSID) -> Result<(), String> {
        ensure_write_ace(path, sid)?;
        for entry in walkdir::WalkDir::new(path)
            .max_depth(5)
            .into_iter()
            .flatten()
        {
            if entry.path() == path {
                continue;
            }
            if let Err(err) = ensure_write_ace(entry.path(), sid) {
                sandbox_diag(format!(
                    "liveagent sandbox: CLR child ACE skipped ({:?}): {err}",
                    entry.path()
                ));
            }
        }
        Ok(())
    }

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *const u16,
    }

    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root_directory: HANDLE,
        object_name: *const UnicodeString,
        attributes: u32,
        security_descriptor: *mut c_void,
        security_qos: *mut c_void,
    }

    #[repr(C)]
    struct ObjectDirectoryInformation {
        name: UnicodeString,
        type_name: UnicodeString,
    }

    type NtStatusFn3 = unsafe extern "system" fn(*mut HANDLE, u32, *const ObjectAttributes) -> i32;
    type NtQueryDirectoryObjectFn =
        unsafe extern "system" fn(HANDLE, *mut c_void, u32, u8, u8, *mut u32, *mut u32) -> i32;

    fn ntdll_proc(name: &[u8]) -> Option<*const c_void> {
        unsafe {
            let ntdll = GetModuleHandleW(to_wide("ntdll.dll").as_ptr());
            if ntdll.is_null() {
                return None;
            }
            GetProcAddress(ntdll, name.as_ptr()).map(|proc| proc as *const c_void)
        }
    }

    fn with_object_attributes<R>(
        nt_path: &str,
        attributes: u32,
        security_descriptor: *mut c_void,
        body: impl FnOnce(&ObjectAttributes) -> R,
    ) -> R {
        let wide = to_wide(nt_path);
        let us = UnicodeString {
            length: ((wide.len() - 1) * 2) as u16,
            maximum_length: (wide.len() * 2) as u16,
            buffer: wide.as_ptr(),
        };
        let oa = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root_directory: null_mut(),
            object_name: &us,
            attributes,
            security_descriptor,
            security_qos: null_mut(),
        };
        body(&oa)
    }

    fn nt_open_by_name(
        fn_name: &[u8],
        nt_path: &str,
        access: u32,
        extra_attr: u32,
    ) -> Result<OwnedHandle, String> {
        let label = String::from_utf8_lossy(&fn_name[..fn_name.len().saturating_sub(1)]);
        let proc = ntdll_proc(fn_name).ok_or_else(|| format!("{label} unavailable"))?;
        let open: NtStatusFn3 = unsafe { std::mem::transmute(proc) };
        with_object_attributes(
            nt_path,
            OBJ_CASE_INSENSITIVE | extra_attr,
            null_mut(),
            |oa| {
                let mut handle = null_mut();
                let status = unsafe { open(&mut handle, access, oa) };
                if status < 0 || handle.is_null() {
                    Err(format!("{label}({nt_path}) ntstatus={status:#010X}"))
                } else {
                    Ok(OwnedHandle(handle))
                }
            },
        )
    }

    fn open_directory_object(nt_path: &str, access: u32) -> Result<OwnedHandle, String> {
        nt_open_by_name(b"NtOpenDirectoryObject\0", nt_path, access, 0)
    }

    fn create_directory_object(
        nt_path: &str,
        access: u32,
        sd: *mut c_void,
    ) -> Result<OwnedHandle, String> {
        let proc = ntdll_proc(b"NtCreateDirectoryObject\0")
            .ok_or_else(|| "NtCreateDirectoryObject unavailable".to_string())?;
        let create: NtStatusFn3 = unsafe { std::mem::transmute(proc) };
        with_object_attributes(nt_path, OBJ_CASE_INSENSITIVE | OBJ_OPENIF, sd, |oa| {
            let mut handle = null_mut();
            let status = unsafe { create(&mut handle, access, oa) };
            if status < 0 || handle.is_null() {
                Err(format!(
                    "NtCreateDirectoryObject({nt_path}) ntstatus={status:#010X}"
                ))
            } else {
                Ok(OwnedHandle(handle))
            }
        })
    }

    fn sid_string(sid: PSID) -> Result<String, String> {
        unsafe {
            let mut s: *mut u16 = null_mut();
            if !ok(ConvertSidToStringSidW(sid, &mut s)) || s.is_null() {
                return Err(last_error("ConvertSidToStringSidW"));
            }
            let mut len = 0usize;
            while *s.add(len) != 0 {
                len += 1;
            }
            let out = String::from_utf16_lossy(std::slice::from_raw_parts(s, len));
            LocalFree(s as _);
            Ok(out)
        }
    }

    fn namespace_security_descriptor(sids: &[PSID]) -> Result<*mut c_void, String> {
        let mut sddl = String::from("D:(A;OICI;GA;;;SY)(A;OICI;GA;;;BA)(A;OICI;GA;;;WD)");
        for &sid in sids {
            match sid_string(sid) {
                Ok(s) => sddl.push_str(&format!("(A;OICI;GA;;;{s})")),
                Err(err) => sandbox_diag(format!("liveagent sandbox: SID to SDDL skipped: {err}")),
            }
        }
        let wide = to_wide(&sddl);
        let mut sd: *mut c_void = null_mut();
        let r = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                1,
                &mut sd,
                null_mut(),
            )
        };
        if !ok(r) || sd.is_null() {
            return Err(last_error(
                "ConvertStringSecurityDescriptorToSecurityDescriptorW",
            ));
        }
        Ok(sd)
    }

    fn rtl_upcase_wchar(ch: u16) -> u16 {
        ntdll_proc(b"RtlUpcaseUnicodeChar\0")
            .map(|proc| {
                type RtlUpcaseUnicodeCharFn = unsafe extern "system" fn(u16) -> u16;
                let f: RtlUpcaseUnicodeCharFn = unsafe { std::mem::transmute(proc) };
                unsafe { f(ch) }
            })
            .unwrap_or_else(|| {
                if (b'a' as u16..=b'z' as u16).contains(&ch) {
                    ch - 32
                } else {
                    ch
                }
            })
    }

    /// cygwin `hash_path_name`: `hash = RtlUpcase(c) + (hash<<6) + (hash<<16) - hash`
    /// (`ino_t` = u64). The install key is the 16-digit lowercase hex form of that hash.
    fn hash_path_name(nt_path: &str) -> u64 {
        let mut hash: u64 = 0;
        for ch in nt_path.encode_utf16() {
            let u = rtl_upcase_wchar(ch) as u64;
            hash = u
                .wrapping_add(hash.wrapping_shl(6))
                .wrapping_add(hash.wrapping_shl(16))
                .wrapping_sub(hash);
        }
        hash
    }

    fn nt_path_for_msys_hash(dll: &Path) -> Option<String> {
        let lossy = dll.to_string_lossy();
        let prefixed = if lossy.starts_with(r"\\?\") {
            lossy.into_owned()
        } else if lossy.starts_with(r"\\") {
            format!(r"\\?\UNC\{}", lossy.trim_start_matches(r"\\"))
        } else {
            format!(r"\\?\{lossy}")
        };
        let mut chars: Vec<u16> = prefixed.encode_utf16().collect();
        if chars.len() >= 2 {
            chars[1] = b'?' as u16;
        }
        Some(String::from_utf16_lossy(&chars))
    }

    fn msys_runtime_dll(program: &Path) -> Option<PathBuf> {
        let parent = program.parent()?;
        let candidates = [
            parent.join("msys-2.0.dll"),
            parent
                .join("..")
                .join("usr")
                .join("bin")
                .join("msys-2.0.dll"),
            parent.join("cygwin1.dll"),
        ];
        for candidate in candidates {
            if candidate.is_file() {
                return Some(candidate.canonicalize().unwrap_or(candidate));
            }
        }
        None
    }

    fn msys_object_dir_names(program: &Path) -> Vec<String> {
        let Some(dll) = msys_runtime_dll(program) else {
            return Vec::new();
        };
        let Some(nt) = nt_path_for_msys_hash(&dll) else {
            return Vec::new();
        };
        let key = format!("{:016x}", hash_path_name(&nt));
        sandbox_diag(format!(
            "liveagent sandbox: msys install key {key} from {nt}"
        ));
        let prefix = if dll
            .file_name()
            .is_some_and(|name| name.eq_ignore_ascii_case("cygwin1.dll"))
        {
            "cygwin1S5"
        } else {
            "msys-2.0S5"
        };
        let mut names = vec![format!(r"\BaseNamedObjects\{prefix}-{key}")];
        if let Some(session) = current_session_id() {
            names.push(format!(r"\Sessions\BNOLINKS\{session}\{prefix}-{key}"));
        }
        names
    }

    #[cfg(test)]
    pub(super) fn msys_object_dir_names_for_test(program: &Path) -> Vec<String> {
        msys_object_dir_names(program)
    }

    /// Real-machine hook: after stamping the msys directory, simulate opening it with a
    /// WRITE_RESTRICTED token (DesiredAccess = cygwin CYG_SHARED_DIR_ACCESS). Used to separate DACL
    /// problems from other bash DllMain failure surfaces.
    #[cfg(test)]
    pub(super) fn restricted_token_can_open_msys_dir(program: &Path) -> Result<(), String> {
        use windows_sys::Win32::Security::{ImpersonateLoggedOnUser, RevertToSelf};
        let names = msys_object_dir_names(program);
        let Some(name) = names.first() else {
            return Err("no msys object directory names".into());
        };
        let synthetic_str = crate::runtime::sandbox::synthetic_workspace_sid(Path::new(
            "liveagent-sandbox-msys-probe",
        ));
        let synthetic = string_to_sid(&synthetic_str)?;
        let wr = string_to_sid(WRITE_RESTRICTED_SID)?;
        let token = OwnedHandle(open_process_token()?);
        let logon = logon_sid_bytes(token.0)?;
        let logon_ptr = logon.as_ptr() as PSID;
        let restricting = [logon_ptr, wr.0, synthetic.0];
        let _held = ensure_named_directory_write_surface(name, &restricting)
            .ok_or_else(|| format!("failed to create/hold {name}"))?;
        let rt = OwnedHandle(create_restricted_token(token.0, &restricting)?);
        append_sid_to_default_dacl(rt.0, logon_ptr)?;
        if !ok(unsafe { ImpersonateLoggedOnUser(rt.0) }) {
            return Err(last_error("ImpersonateLoggedOnUser"));
        }
        let access = DIRECTORY_QUERY
            | DIRECTORY_TRAVERSE
            | DIRECTORY_CREATE_OBJECT
            | DIRECTORY_CREATE_SUBDIRECTORY
            | READ_CONTROL;
        let opened = nt_open_by_name(b"NtOpenDirectoryObject\0", name, access, 0);
        unsafe {
            RevertToSelf();
        }
        opened.map(|_| ())
    }

    fn kernel_handle_has_ace(handle: HANDLE, sid: PSID) -> bool {
        unsafe {
            let mut dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 || dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return false;
            }
            let mut info = ACL_SIZE_INFORMATION {
                AceCount: 0,
                AclBytesInUse: 0,
                AclBytesFree: 0,
            };
            let mut found = false;
            if ok(GetAclInformation(
                dacl,
                &mut info as *mut _ as *mut c_void,
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                ACL_SIZE_INFORMATION_CLASS,
            )) {
                for i in 0..info.AceCount {
                    let mut ace: *mut c_void = null_mut();
                    if !ok(GetAce(dacl, i, &mut ace)) || ace.is_null() {
                        continue;
                    }
                    if (*(ace as *const ACE_HEADER)).AceType == ACCESS_ALLOWED_ACE_TYPE {
                        let allow = ace as *const ACCESS_ALLOWED_ACE;
                        let sid_ptr = &(*allow).SidStart as *const u32 as PSID;
                        if ok(EqualSid(sid_ptr, sid)) {
                            found = true;
                            break;
                        }
                    }
                }
            }
            LocalFree(psd as _);
            found
        }
    }

    fn ensure_kernel_handle_write_ace(
        handle: HANDLE,
        sid: PSID,
        access: u32,
        label: &str,
    ) -> Result<(), String> {
        if kernel_handle_has_ace(handle, sid) {
            return Ok(());
        }
        unsafe {
            let mut old_dacl: *mut ACL = null_mut();
            let mut psd: *mut c_void = null_mut();
            let rc = GetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut old_dacl,
                null_mut(),
                &mut psd,
            );
            if rc != 0 {
                return Err(format!("GetSecurityInfo({label}) failed (error={rc})"));
            }
            if old_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Ok(());
            }
            let mut ea: EXPLICIT_ACCESS_W = std::mem::zeroed();
            ea.grfAccessPermissions = access;
            ea.grfAccessMode = GRANT_ACCESS;
            ea.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
            ea.Trustee = TRUSTEE_W {
                pMultipleTrustee: null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: sid as *mut u16,
            };
            let mut new_dacl: *mut ACL = null_mut();
            let rc = SetEntriesInAclW(1, &ea, old_dacl, &mut new_dacl);
            if rc != 0 || new_dacl.is_null() {
                if !psd.is_null() {
                    LocalFree(psd as _);
                }
                return Err(format!("SetEntriesInAclW({label}) failed (error={rc})"));
            }
            let rc = SetSecurityInfo(
                handle,
                SE_KERNEL_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                new_dacl,
                null_mut(),
            );
            LocalFree(new_dacl as _);
            if !psd.is_null() {
                LocalFree(psd as _);
            }
            if rc != 0 {
                return Err(format!("SetSecurityInfo({label}) failed (error={rc})"));
            }
        }
        Ok(())
    }

    fn stamp_kernel_handle(handle: HANDLE, sids: &[PSID], access: u32, label: &str) {
        for (i, &sid) in sids.iter().enumerate() {
            if let Err(err) = ensure_kernel_handle_write_ace(handle, sid, access, label) {
                sandbox_diag(format!(
                    "liveagent sandbox: kernel ACE skipped ({label}#{i}): {err}"
                ));
            }
        }
    }

    fn nt_set_dacl(handle: HANDLE, sd: *mut c_void, label: &str) {
        let Some(proc) = ntdll_proc(b"NtSetSecurityObject\0") else {
            sandbox_diag("liveagent sandbox: NtSetSecurityObject unavailable");
            return;
        };
        type NtSetSecurityObjectFn = unsafe extern "system" fn(HANDLE, u32, *mut c_void) -> i32;
        let set: NtSetSecurityObjectFn = unsafe { std::mem::transmute(proc) };
        let status = unsafe { set(handle, DACL_SECURITY_INFORMATION, sd) };
        if status < 0 {
            sandbox_diag(format!(
                "liveagent sandbox: NtSetSecurityObject({label}) ntstatus={status:#010X}"
            ));
        }
    }

    fn stamp_directory_object(nt_path: &str, sids: &[PSID]) {
        // A standard user does not have DIRECTORY_ALL_ACCESS on `\BaseNamedObjects`; on msys
        // subdirectories it created, it does have WRITE_DAC. Open with "query + write DACL", and
        // only warn on failure.
        let access = DIRECTORY_QUERY | DIRECTORY_TRAVERSE | READ_CONTROL | WRITE_DAC;
        match open_directory_object(nt_path, access) {
            Ok(dir) => stamp_kernel_handle(
                dir.0,
                sids,
                DIRECTORY_ALL_ACCESS | GENERIC_ALL | WRITE_DAC,
                nt_path,
            ),
            Err(err) => sandbox_diag(format!("liveagent sandbox: open {nt_path} skipped: {err}")),
        }
    }

    fn ensure_named_directory_write_surface(nt_path: &str, sids: &[PSID]) -> Option<OwnedHandle> {
        let sd = match namespace_security_descriptor(sids) {
            Ok(sd) => sd,
            Err(err) => {
                sandbox_diag(format!(
                    "liveagent sandbox: namespace SD skipped ({nt_path}): {err}"
                ));
                stamp_directory_object(nt_path, sids);
                stamp_directory_children(nt_path, sids, false);
                return None;
            }
        };
        let access = DIRECTORY_ALL_ACCESS
            | DIRECTORY_CREATE_OBJECT
            | DIRECTORY_CREATE_SUBDIRECTORY
            | READ_CONTROL
            | WRITE_DAC;
        let handle = match create_directory_object(nt_path, access, sd) {
            Ok(dir) => Some(dir),
            Err(err) => {
                sandbox_diag(format!(
                    "liveagent sandbox: create {nt_path} skipped: {err}"
                ));
                open_directory_object(nt_path, access).ok()
            }
        };
        if let Some(dir) = handle.as_ref() {
            // When OBJ_OPENIF hits an existing object, the creation-time SD does not overwrite the
            // everyone_sd; NtSetSecurityObject must be called again to write the restricting SID
            // into the DACL.
            nt_set_dacl(dir.0, sd, nt_path);
            set_handle_low_integrity(dir.0, nt_path);
            stamp_kernel_handle(
                dir.0,
                sids,
                DIRECTORY_ALL_ACCESS | GENERIC_ALL | WRITE_DAC,
                nt_path,
            );
        }
        unsafe {
            LocalFree(sd as _);
        }
        stamp_directory_children(nt_path, sids, false);
        handle
    }

    #[repr(C)]
    struct IoStatusBlock {
        status: isize,
        information: usize,
    }

    fn open_file_object(nt_path: &str, access: u32) -> Result<OwnedHandle, String> {
        let proc =
            ntdll_proc(b"NtOpenFile\0").ok_or_else(|| "NtOpenFile unavailable".to_string())?;
        type NtOpenFileFn = unsafe extern "system" fn(
            *mut HANDLE,
            u32,
            *const ObjectAttributes,
            *mut IoStatusBlock,
            u32,
            u32,
        ) -> i32;
        let open: NtOpenFileFn = unsafe { std::mem::transmute(proc) };
        const FILE_SHARE_ALL: u32 = 0x7;
        with_object_attributes(nt_path, OBJ_CASE_INSENSITIVE, null_mut(), |oa| {
            let mut handle = null_mut();
            let mut iosb = IoStatusBlock {
                status: 0,
                information: 0,
            };
            let status = unsafe { open(&mut handle, access, oa, &mut iosb, FILE_SHARE_ALL, 0) };
            if status < 0 || handle.is_null() {
                Err(format!("NtOpenFile({nt_path}) ntstatus={status:#010X}"))
            } else {
                Ok(OwnedHandle(handle))
            }
        })
    }

    fn stamp_nt_path_dacl(nt_path: &str, sids: &[PSID]) {
        let access = READ_CONTROL | WRITE_DAC;
        let handle =
            open_directory_object(nt_path, access).or_else(|_| open_file_object(nt_path, access));
        match handle {
            Ok(h) => stamp_kernel_handle(
                h.0,
                sids,
                DIRECTORY_ALL_ACCESS | GENERIC_ALL | WRITE_DAC,
                nt_path,
            ),
            Err(err) => sandbox_diag(format!("liveagent sandbox: stamp {nt_path} skipped: {err}")),
        }
    }

    fn utf16_to_string(us: &UnicodeString) -> String {
        if us.buffer.is_null() || us.length == 0 {
            return String::new();
        }
        let n = (us.length as usize) / 2;
        unsafe { String::from_utf16_lossy(std::slice::from_raw_parts(us.buffer, n)) }
    }

    fn stamp_directory_children(nt_dir: &str, sids: &[PSID], only_msys: bool) {
        let Ok(dir) = open_directory_object(nt_dir, DIRECTORY_QUERY | DIRECTORY_TRAVERSE) else {
            return;
        };
        let Some(query_ptr) = ntdll_proc(b"NtQueryDirectoryObject\0") else {
            return;
        };
        let query: NtQueryDirectoryObjectFn = unsafe { std::mem::transmute(query_ptr) };
        let mut buf = vec![0u8; 4096];
        let mut context: u32 = 0;
        let mut restart = 1u8;
        let mut children: Vec<(String, String)> = Vec::new();
        loop {
            let mut ret_len: u32 = 0;
            let status = unsafe {
                query(
                    dir.0,
                    buf.as_mut_ptr() as *mut c_void,
                    buf.len() as u32,
                    1, // ReturnSingleEntry: avoid parsing packed directory entries ourselves
                    restart,
                    &mut context,
                    &mut ret_len,
                )
            };
            restart = 0;
            const STATUS_NO_MORE_ENTRIES: u32 = 0x8000_001A;
            if status as u32 == STATUS_NO_MORE_ENTRIES {
                break;
            }
            if status < 0 {
                break;
            }
            if buf.len() < std::mem::size_of::<ObjectDirectoryInformation>() {
                break;
            }
            let info = unsafe { &*(buf.as_ptr() as *const ObjectDirectoryInformation) };
            let name = utf16_to_string(&info.name);
            let ty = utf16_to_string(&info.type_name);
            if name.is_empty() {
                continue;
            }
            if only_msys {
                let lower = name.to_ascii_lowercase();
                if !(lower.starts_with("msys-") || lower.starts_with("cygwin")) {
                    continue;
                }
            }
            children.push((name, ty));
        }
        drop(dir);
        for (name, ty) in children {
            let child = format!("{nt_dir}\\{name}");
            let open_fn: &[u8] = match ty.as_str() {
                "Directory" => b"NtOpenDirectoryObject\0",
                "Section" => b"NtOpenSection\0",
                "Event" => b"NtOpenEvent\0",
                "Mutant" => b"NtOpenMutant\0",
                "Semaphore" => b"NtOpenSemaphore\0",
                "Timer" => b"NtOpenTimer\0",
                _ => b"",
            };
            if !open_fn.is_empty() {
                if let Ok(h) = nt_open_by_name(open_fn, &child, READ_CONTROL | WRITE_DAC, 0) {
                    stamp_kernel_handle(h.0, sids, GENERIC_ALL | WRITE_DAC, &child);
                }
            }
            if ty == "Directory" {
                // Stamp every section/event inside the msys directory (these are the objects DllMain
                // needs to reopen).
                stamp_directory_children(&child, sids, false);
            }
        }
    }

    fn current_session_id() -> Option<u32> {
        unsafe {
            let k32 = GetModuleHandleW(to_wide("kernel32.dll").as_ptr());
            if k32.is_null() {
                return None;
            }
            let proc = GetProcAddress(k32, b"ProcessIdToSessionId\0".as_ptr())?;
            type ProcessIdToSessionIdFn = unsafe extern "system" fn(u32, *mut u32) -> i32;
            let f: ProcessIdToSessionIdFn = std::mem::transmute(proc);
            let mut id = 0u32;
            if f(GetCurrentProcessId(), &mut id) == 0 {
                return None;
            }
            Some(id)
        }
    }

    fn looks_like_msys_bash(program: &Path) -> bool {
        let name = program.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if !name.eq_ignore_ascii_case("bash.exe") {
            return false;
        }
        let Some(parent) = program.parent() else {
            return false;
        };
        parent.join("msys-2.0.dll").is_file()
            || parent
                .join("..")
                .join("usr")
                .join("bin")
                .join("msys-2.0.dll")
                .is_file()
    }

    /// Object directories are not permanent by default: once the last handle closes, they disappear
    /// from the namespace. The launcher must keep the returned handles alive until the sandboxed
    /// child exits, so the child's OBJ_OPENIF can hit the existing directory instead of performing a
    /// second write check on `\BaseNamedObjects`.
    fn ensure_object_namespace_write_surface(
        sids: &[PSID],
        program: &Path,
        isolation_prefix: &str,
    ) -> Vec<OwnedHandle> {
        let mut held = Vec::new();
        if let Some(h) = ensure_named_directory_write_surface(
            &format!(r"\BaseNamedObjects\{isolation_prefix}"),
            sids,
        ) {
            held.push(h);
        }
        if looks_like_msys_bash(program) {
            for name in msys_object_dir_names(program) {
                if let Some(h) = ensure_named_directory_write_surface(&name, sids) {
                    held.push(h);
                }
            }
        }
        // The Git Bash signal pipe is `\\.\pipe\msys-<key>-<pid>-sigwait`, and creating it requires
        // passing the second write check on `\Device\NamedPipe`. Only warn if it cannot be stamped.
        stamp_nt_path_dacl(r"\Device\NamedPipe", sids);
        held
    }

    /// Creates and stamps a fenced temp directory (under the system temp, deterministically named
    /// per workspace) and points TEMP/TMP/TMPDIR at it -- otherwise sandboxed processes writing to
    /// the default %TEMP% would be denied by the restricting check.
    fn setup_fenced_temp(
        write_root: &Path,
        sid: PSID,
        legacy_appcontainer_sid: PSID,
        dir_key: &str,
        extra_sids: &[PSID],
    ) -> Result<PathBuf, String> {
        let base = std::env::temp_dir().join(format!("liveagent-sandbox-{dir_key}"));
        // The path is deterministic and predictable => another process under the same user could
        // race to make it a junction/symlink pointing at a sensitive directory, causing the
        // authorized write ACE to land on the target and the TEMP redirect to fall into it.
        // Rejecting reparse points closes that route (a residual TOCTOU remains: swapping
        // between stamping and use requires another malicious same-user process, so severity is low).
        ensure_plain_directory(&base)?;
        remove_write_ace(&base, legacy_appcontainer_sid)?;
        ensure_write_ace(&base, sid)?;
        for (i, &extra) in extra_sids.iter().enumerate() {
            if let Err(err) = ensure_write_ace(&base, extra) {
                sandbox_diag(format!(
                    "liveagent sandbox: TEMP extra ACE skipped (#{i}): {err}"
                ));
            }
        }
        let _ = write_root; // kept for signature clarity; temp is independent of the workspace.
        let base_wide = to_wide(&base.to_string_lossy());
        for name in ["TEMP", "TMP", "TMPDIR"] {
            let name_wide = to_wide(name);
            unsafe {
                if !ok(SetEnvironmentVariableW(
                    name_wide.as_ptr(),
                    base_wide.as_ptr(),
                )) {
                    return Err(last_error(&format!("SetEnvironmentVariableW({name})")));
                }
            }
        }
        Ok(base)
    }

    /// Makes the three standard handles inheritable and passes them to the child as
    /// STARTF_USESTDHANDLES (stdin=NUL, stdout/stderr=the parent's pipes, both created by
    /// shell_runner and reaching this launcher via inheritance).
    fn inheritable_std_handles() -> Result<(HANDLE, HANDLE, HANDLE), String> {
        // GetStdHandle returns INVALID_HANDLE_VALUE (-1) rather than null when a handle is missing;
        // skip both.
        let invalid: HANDLE = usize::MAX as HANDLE;
        unsafe {
            let stdin = GetStdHandle(STD_INPUT_HANDLE);
            let stdout = GetStdHandle(STD_OUTPUT_HANDLE);
            let stderr = GetStdHandle(STD_ERROR_HANDLE);
            for h in [stdin, stdout, stderr] {
                if !h.is_null() && h != invalid {
                    // Failure is not fatal: the handle may already be inheritable; keep trying.
                    SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                }
            }
            Ok((stdin, stdout, stderr))
        }
    }

    /// Runtime probe: whether the networked backend (a Low IL primary token duplicate) can actually
    /// be built.
    ///
    /// It runs the same core token sequence as `execute` (open primary token -> DuplicateTokenEx ->
    /// lower to Low IL), except it starts no process and modifies no filesystem labels.
    /// Group Policy, EDR hooks, and restricted SKUs can make any of these steps fail on a real
    /// machine; the probe surfaces failure early in `capability().supported`, so `wrap_command`'s
    /// fail-closed guard is genuinely reachable on Windows (previously `supported: true` was
    /// hardcoded, so the guard never fired).
    /// The token handle is released immediately via `OwnedHandle`, with no system-level side
    /// effects.
    pub(super) fn probe_networked_token() -> Result<(), String> {
        let token = OwnedHandle(open_process_token()?);
        let networked = OwnedHandle(duplicate_primary_token(token.0)?);
        set_token_low_integrity(networked.0)?;
        Ok(())
    }

    /// Runtime probe: whether the offline backend can derive the AppContainer profile SID and the
    /// private capability SID. Both are pure derivations that create no profile and have no system
    /// side effects; if either step fails, the offline sandbox capability must not be claimed.
    pub(super) fn probe_appcontainer() -> Result<(), String> {
        let name = appcontainer_profile_name("probe");
        let name_w = to_wide(&name);
        let mut sid: PSID = null_mut();
        let derived =
            unsafe { DeriveAppContainerSidFromAppContainerName(name_w.as_ptr(), &mut sid) };
        if derived != 0 || sid.is_null() {
            return Err(format!(
                "DeriveAppContainerSidFromAppContainerName hr={derived:#010X}"
            ));
        }
        let _sid = AcSid(sid); // RAII:FreeSid
        let _capability = workspace_capability_sid("probe")?;
        Ok(())
    }

    pub(super) fn execute(
        write_root: &Path,
        allow_network: bool,
        isolated: bool,
        program: &Path,
        args: &[String],
    ) -> Result<i32, String> {
        use crate::runtime::sandbox::{
            build_command_line, is_msix_windowsapps_path, resolve_program_in_path,
            synthetic_workspace_sid, validate_workspace,
        };

        // P3#8: the launcher is a separate process and cannot rely on the parent-side
        // wrap_command having already validated -- both entry points must share the same
        // preconditions, otherwise either evolving independently will drift into fail-closed
        // asymmetry. (An idempotent pure validation; running it twice has no side effects.)
        validate_workspace(write_root)?;

        let synthetic_str = synthetic_workspace_sid(write_root);
        // The temp directory / AC profile name reuse the numeric segments of the synthetic SID, making
        // them deterministic and filesystem-safe.
        let dir_key = synthetic_str
            .trim_start_matches("S-1-5-21-")
            .replace('-', "_");

        // Resolve the program first; never launch an image by relative path from the
        // model-writable workspace.
        let path_env = std::env::var("PATH").unwrap_or_default();
        let pathext =
            std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        let resolved = resolve_program_in_path(program, &path_env, &pathext, &|p| p.is_file())
            .ok_or_else(|| {
                format!(
                    "sandbox refuses to resolve program {program:?}: not found in any absolute \
                     PATH directory (the workspace cwd is intentionally never searched)"
                )
            })?;
        if is_msix_windowsapps_path(&resolved) {
            return Err(format!(
                "sandbox refuses Microsoft Store / MSIX program {resolved:?}: WindowsApps \
                 binaries cannot be started through the sandbox security contexts \
                 (CreateProcessAsUserW returns 5). Install PowerShell via MSI or use \
                 powershell.exe / cmd.exe"
            ));
        }
        // --- backend security context ---
        // fence_sid = the trustee SID for file write ACEs (networked = current user SID, offline =
        // workspace private capability SID). The self-owned memory for profile/capability/user/token
        // is all declared in the outer scope to keep its PSID pointers alive past the return of
        // CreateProcess*.
        let appcontainer_sid = if allow_network {
            derive_appcontainer_profile_sid(&dir_key)?
        } else {
            appcontainer_profile_sid(&dir_key)?
        };
        let workspace_capability = if allow_network {
            None
        } else {
            Some(workspace_capability_sid(&dir_key)?)
        };
        let network_token: Option<OwnedHandle>;
        let fence_sid: PSID;
        let logon_sid: Option<Vec<u8>>;
        let user_sid: Option<Vec<u8>>;
        if allow_network {
            let token = OwnedHandle(open_process_token()?);
            let logon = logon_sid_bytes(token.0)?;
            let logon_ptr = logon.as_ptr() as PSID;
            let user = token_user_sid_bytes(token.0)?;
            let user_ptr = user.as_ptr() as PSID;
            let rt = OwnedHandle(duplicate_primary_token(token.0)?);
            // The logon SID enters the default DACL, ensuring named objects the child creates
            // itself can be reopened within the same logon session.
            append_sid_to_default_dacl(rt.0, logon_ptr)?;
            // Networked mode cannot use a restricted token: SSPI/Schannel would fail HTTPS
            // initialization with SEC_E_NO_CREDENTIALS. Duplicating the current user's primary token
            // and lowering it to Low IL keeps network semantics unchanged, while the NTFS write
            // fence is enforced by NoWriteUp + a Low workspace/TEMP.
            set_token_low_integrity(rt.0)?;
            network_token = Some(rt);
            fence_sid = user_ptr;
            logon_sid = Some(logon);
            user_sid = Some(user);
        } else {
            // The private capability authorizes only this workspace's file surface, not a
            // network capability; WFP still blocks all network at the kernel level for this
            // AppContainer (including loopback).
            set_offline_env()?;
            network_token = None;
            fence_sid = workspace_capability
                .as_ref()
                .map(|sid| sid.as_ptr() as PSID)
                .ok_or_else(|| "offline workspace capability SID is unavailable".to_string())?;
            logon_sid = None;
            user_sid = None;
        }

        // --- filesystem write fence (trustee = fence_sid) ---
        // Migrate the ACE that older versions granted directly to the package SID. That ACE does
        // not coexist with a plain Low-IL networked token, so it must first be revoked precisely,
        // then the user SID / private capability SID granted.
        remove_write_ace(write_root, appcontainer_sid.0)?;
        ensure_write_ace(write_root, fence_sid)?;
        let extra_temp: Vec<PSID> = logon_sid
            .as_ref()
            .map(|logon| logon.as_ptr() as PSID)
            .into_iter()
            .collect();
        let fenced_temp = setup_fenced_temp(
            write_root,
            fence_sid,
            appcontainer_sid.0,
            &dir_key,
            &extra_temp,
        )?;
        if allow_network {
            let launcher_user_sid = user_sid
                .as_ref()
                .map(|sid| sid.as_ptr() as PSID)
                .ok_or_else(|| "sandbox launcher user SID is unavailable".to_string())?;
            // The workspace root must be labeled Low, otherwise even newly created files would be
            // denied to the Low child process by NoWriteUp.
            ensure_low_integrity_label(
                SE_FILE_OBJECT,
                &write_root.to_string_lossy(),
                launcher_user_sid,
            )?;
            ensure_runtime_low_integrity_surface(
                write_root,
                &fenced_temp,
                &resolved,
                launcher_user_sid,
            );
        }
        // CNG/CLR: PowerShell startup writes the user certificate store and runtime caches; only
        // this narrow set of paths gets an additional access surface.
        remove_legacy_appcontainer_runtime_surface(appcontainer_sid.0);
        let mut runtime_sids: Vec<PSID> = vec![fence_sid];
        if let Some(ref logon) = logon_sid {
            runtime_sids.push(logon.as_ptr() as PSID);
        }
        for &sid in &runtime_sids {
            ensure_cng_user_write_surface(sid);
            ensure_clr_user_write_surface(sid);
        }

        // --- standard handles + command line ---
        let (h_in, h_out, h_err) = inheritable_std_handles()?;
        if allow_network {
            // A Low child writing to a Medium anonymous pipe would be blocked by NoWriteUp;
            // best-effort label the inherited stdout/stderr as Low too. Without WRITE_OWNER this only
            // warns, and most anonymous pipes remain writable in practice (the same path used when
            // an AppContainer launches a child with redirected stdout).
            set_handle_low_integrity(h_in, "stdin");
            set_handle_low_integrity(h_out, "stdout");
            set_handle_low_integrity(h_err, "stderr");
        }

        // NT object namespace: must happen before CreateProcess*, while the SID buffers are
        // still alive.
        let mut namespace_sids: Vec<PSID> = Vec::with_capacity(4);
        if let Some(ref logon) = logon_sid {
            namespace_sids.push(logon.as_ptr() as PSID);
        }
        if let Some(ref user) = user_sid {
            namespace_sids.push(user.as_ptr() as PSID);
        }
        namespace_sids.push(fence_sid);
        let isolation_prefix = format!("ReactorPro.Sandbox.{dir_key}");
        let _held_namespace =
            ensure_object_namespace_write_surface(&namespace_sids, &resolved, &isolation_prefix);

        let program_str = program.to_string_lossy(); // argv[0] keeps the original name (aligned with the non-sandbox path)
        let app_wide = to_wide(&resolved.to_string_lossy()); // lpApplicationName = the resolved absolute path
        let mut cmdline = build_command_line(&program_str, args); // already includes the trailing NUL

        // --- STARTUPINFOEXW: explicit desktop + whitelisted handle inheritance (+ AC capabilities) ---
        // A Low IL token / AC launch must specify the desktop explicitly: NULL lets the system
        // infer it, which is ambiguous or even fails in a sandbox context (the same fix as Codex).
        let mut desktop = to_wide("winsta0\\default");

        // Handle whitelist: dedupe + filter out NULL/INVALID (a list containing invalid or duplicate
        // handles makes CreateProcess* fail with ERROR_INVALID_PARAMETER). Replaces the old
        // bInheritHandles=TRUE full handle-table inheritance, narrowing the handle-leak surface.
        let invalid: HANDLE = usize::MAX as HANDLE;
        let mut handle_list: Vec<HANDLE> = Vec::with_capacity(3);
        for h in [h_in, h_out, h_err] {
            if !h.is_null() && h != invalid && !handle_list.contains(&h) {
                handle_list.push(h);
            }
        }
        let inherit = !handle_list.is_empty();

        // AC capabilities: must be declared before attrs (locals drop in reverse order => attrs dies
        // first), satisfying UpdateProcThreadAttribute's value-lifetime contract (see the AttrList
        // docs).
        let mut capability_attrs: Vec<SID_AND_ATTRIBUTES> = workspace_capability
            .as_ref()
            .map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.as_ptr() as PSID,
                Attributes: SE_GROUP_ENABLED,
            })
            .into_iter()
            .collect();
        let sec_caps = SECURITY_CAPABILITIES {
            AppContainerSid: appcontainer_sid.0,
            Capabilities: capability_attrs.as_mut_ptr(),
            CapabilityCount: capability_attrs.len() as u32,
            Reserved: 0,
        };

        // An AppContainer already has a separate namespace, and Windows does not support
        // layering BNO isolation on top (CreateProcessW error 50); networked Low-IL processes
        // continue to use BNO to isolate named objects.
        let attr_count = 2;
        let mut bno_attr = ProcessBnoIsolationAttribute {
            isolation_enabled: 1,
            isolation_prefix: [0u16; 136],
        };
        {
            for (i, unit) in isolation_prefix.encode_utf16().take(135).enumerate() {
                bno_attr.isolation_prefix[i] = unit;
            }
        }
        let mut attrs = AttrList::new(attr_count)?;
        if inherit {
            attrs.set(
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                handle_list.as_ptr() as *const c_void,
                handle_list.len() * std::mem::size_of::<HANDLE>(),
                "UpdateProcThreadAttribute(handle list)",
            )?;
        }
        if !allow_network {
            attrs.set(
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                &sec_caps as *const _ as *const c_void,
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                "UpdateProcThreadAttribute(security capabilities)",
            )?;
        }
        if allow_network {
            attrs.set(
                PROC_THREAD_ATTRIBUTE_BNO_ISOLATION,
                &bno_attr as *const _ as *const c_void,
                std::mem::size_of::<ProcessBnoIsolationAttribute>(),
                "UpdateProcThreadAttribute(bno isolation)",
            )?;
        }

        // --- launch the child process (suspended, so it can be joined to the Job before
        // being released) ---
        let result = unsafe {
            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.lpDesktop = desktop.as_mut_ptr();
            si.StartupInfo.hStdInput = h_in;
            si.StartupInfo.hStdOutput = h_out;
            si.StartupInfo.hStdError = h_err;
            si.lpAttributeList = attrs.ptr();

            let flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT;
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            let created = if let Some(rt) = &network_token {
                CreateProcessAsUserW(
                    rt.0,
                    app_wide.as_ptr(),
                    cmdline.as_mut_ptr(),
                    null(),
                    null(),
                    i32::from(inherit),
                    flags,
                    null(), // lpEnvironment = NULL => inherit this launcher's environment (including the temp redirect)
                    null(), // lpCurrentDirectory = NULL => inherit this launcher's cwd (= the actual working directory)
                    &si as *const _ as *const STARTUPINFOW,
                    &mut pi,
                )
            } else {
                // AC: ordinary CreateProcessW; the kernel creates a lowbox token from
                // SECURITY_CAPABILITIES; the environment additionally carries the offline overlay
                // from set_offline_env.
                CreateProcessW(
                    app_wide.as_ptr(),
                    cmdline.as_mut_ptr(),
                    null(),
                    null(),
                    i32::from(inherit),
                    flags,
                    null(),
                    null(),
                    &si as *const _ as *const STARTUPINFOW,
                    &mut pi,
                )
            };
            if !ok(created) {
                return Err(last_error(if network_token.is_some() {
                    "CreateProcessAsUserW(low-integrity token)"
                } else {
                    "CreateProcessW(AppContainer)"
                }));
            }

            // Job Object (KILL_ON_JOB_CLOSE): kills the child along with the launcher if it dies
            // unexpectedly, as a fallback beyond taskkill /T. Best-effort; failure only warns.
            // Isolated long-lived processes are deliberately not placed in a Job: they must survive
            // the death of the launcher/ReactorPro (aligned with Linux bwrap omitting
            // --die-with-parent).
            let job = if isolated {
                null_mut()
            } else {
                CreateJobObjectW(null(), null())
            };
            if !job.is_null() {
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JOB_OBJECT_EXTENDED_LIMIT_INFO_CLASS,
                    &limits as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if !ok(AssignProcessToJobObject(job, pi.hProcess)) {
                    sandbox_diag(format!(
                        "liveagent sandbox: {}",
                        last_error(
                            "AssignProcessToJobObject (continuing; taskkill /T still cascades)"
                        )
                    ));
                }
            }

            ResumeThread(pi.hThread);
            CloseHandle(pi.hThread);

            WaitForSingleObject(pi.hProcess, INFINITE);
            let mut exit_code: u32 = 0;
            let got = GetExitCodeProcess(pi.hProcess, &mut exit_code);
            CloseHandle(pi.hProcess);
            // The job handle must stay open until the child exits; closing it now is fine
            // (KILL_ON_JOB_CLOSE is harmless at this point).
            if !job.is_null() {
                CloseHandle(job);
            }
            if !ok(got) {
                return Err(last_error("GetExitCodeProcess"));
            }
            // Early loader death (0xC0000142 etc.) shows up only as a raw exit code; add a readable
            // diagnostic uploaded through stderr via the existing pipe (shell_runner's
            // candidate-probing fallback also relies on this exit code).
            if let Some(hint) = loader_failure_hint(exit_code) {
                eprintln!("liveagent sandbox: process exited with {exit_code:#010X}: {hint}");
            }
            exit_code as i32
        };
        Ok(result)
    }
}

// The determinism and hard-constraint checks of the AC profile name are meaningful only on Windows
// (the whole win module is cfg(windows)), but the formula itself is platform-independent -- so that
// mac/Linux dev machines and CI can also guard it, an independent pure-logic mirror test lives here
// (kept literally consistent with the implementation of win::appcontainer_profile_name).
#[cfg(test)]
mod tests {
    /// Mirrors `win::appcontainer_profile_name` + the dir_key derivation in `execute`: the
    /// AppContainer profile name has a hard limit of 64 characters and its character set must fall
    /// within [0-9A-Za-z._].
    fn profile_name_for(synthetic_sid: &str) -> String {
        let dir_key = synthetic_sid
            .trim_start_matches("S-1-5-21-")
            .replace('-', "_");
        format!("ReactorPro.Sandbox.{dir_key}")
    }

    #[test]
    fn appcontainer_profile_name_is_deterministic_and_within_limits() {
        // The synthetic SID is 4 u32 segments (Codex form S-1-5-21-{4×u32}); take each segment's
        // extreme value to verify the worst-case length.
        let worst = profile_name_for("S-1-5-21-4294967295-4294967295-4294967295-4294967295");
        assert_eq!(
            worst,
            "ReactorPro.Sandbox.4294967295_4294967295_4294967295_4294967295"
        );
        assert!(
            worst.len() <= 64,
            "profile name exceeds AC 64-char limit: {}",
            worst.len()
        );
        assert!(worst
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_'));
        // The same SID always yields the same name (determinism => the profile can be reused
        // across runs).
        assert_eq!(
            profile_name_for("S-1-5-21-1-2-3-4"),
            profile_name_for("S-1-5-21-1-2-3-4")
        );
        assert_eq!(
            profile_name_for("S-1-5-21-1-2-3-4"),
            "ReactorPro.Sandbox.1_2_3_4"
        );
    }

    #[cfg(windows)]
    mod win_only {
        use super::super::win;

        static SANDBOX_EXEC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        const SANDBOX_ENV_VARS: &[&str] = &[
            "TEMP",
            "TMP",
            "TMPDIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "CARGO_NET_OFFLINE",
            "PIP_NO_INDEX",
            "NPM_CONFIG_OFFLINE",
        ];

        struct SandboxTestGuard {
            _lock: std::sync::MutexGuard<'static, ()>,
            saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
        }

        impl SandboxTestGuard {
            fn acquire() -> Self {
                let lock = SANDBOX_EXEC_LOCK
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let saved = SANDBOX_ENV_VARS
                    .iter()
                    .map(|name| (*name, std::env::var_os(name)))
                    .collect();
                Self { _lock: lock, saved }
            }

            fn restore_env(&self) {
                for (name, value) in &self.saved {
                    if let Some(value) = value {
                        std::env::set_var(name, value);
                    } else {
                        std::env::remove_var(name);
                    }
                }
            }
        }

        impl Drop for SandboxTestGuard {
            fn drop(&mut self) {
                self.restore_env();
            }
        }

        // Real-machine (Windows) check: the AC SID derived by the actual API is deterministic --
        // deriving the same name twice must be equal. This test creates no profile (Derive is a pure
        // computation) and has no system side effects.
        #[test]
        fn derive_appcontainer_sid_is_deterministic() {
            let a = win::appcontainer_profile_sid_for_test("ReactorPro.Sandbox.test_1_2_3_4");
            let b = win::appcontainer_profile_sid_for_test("ReactorPro.Sandbox.test_1_2_3_4");
            assert!(
                a.is_some(),
                "DeriveAppContainerSidFromAppContainerName failed"
            );
            assert_eq!(a, b);
            // The AC SID always starts with S-1-15-2- (APPLICATION PACKAGE AUTHORITY).
            assert!(a.unwrap().starts_with("S-1-15-2-"));
        }

        #[test]
        fn derive_workspace_capability_sid_is_deterministic() {
            let a = win::workspace_capability_sid_for_test("test_1_2_3_4")
                .expect("derive workspace capability");
            let b = win::workspace_capability_sid_for_test("test_1_2_3_4")
                .expect("derive workspace capability again");
            assert_eq!(a, b);
            assert!(
                a.starts_with("S-1-15-3-1024-"),
                "custom capability SID has unexpected form: {a}"
            );
        }

        // Real-machine (Windows) check of the 0xC0000142 fix: after append, the restricted token's
        // default DACL must contain the logon SID (the assertable postcondition of the fix; whether
        // it "already contained" it varies by environment, so it is not asserted, only printed for
        // diagnostics). It only touches the token copy created by the test itself, with no system
        // side effects.
        #[test]
        fn default_dacl_append_adds_logon_sid() {
            let (before, after) =
                win::default_dacl_fix_roundtrip_for_test().expect("roundtrip failed");
            println!("default DACL contained logon SID before append: {before}");
            assert!(
                after,
                "append_sid_to_default_dacl did not add the logon SID"
            );
        }

        fn sandbox_exec(program: &std::path::Path, args: &[String]) -> Result<i32, String> {
            let _guard = SandboxTestGuard::acquire();
            let dir = tempfile::tempdir().expect("workspace");
            win::execute(dir.path(), true, false, program, args)
        }

        /// Real machine: cmd does not use the CLR and must be usable as the sandbox shell fallback
        /// under a networked Low IL token.
        #[test]
        fn networked_sandbox_cmd_exit_zero() {
            let code = sandbox_exec(
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), "exit 0".into()],
            )
            .expect("networked sandbox cmd execute");
            assert_eq!(
                code as u32, 0,
                "cmd under networked sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn networked_sandbox_token_is_not_restricted() {
            win::probe_networked_token()
                .expect("networked sandbox must preserve the user's full logon context");
        }

        #[test]
        fn appcontainer_cmd_exit_zero() {
            let _guard = SandboxTestGuard::acquire();
            let workspace = tempfile::tempdir().expect("workspace");
            let result = win::execute(
                workspace.path(),
                false,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), "exit 0".into()],
            );
            let code = result.expect("AppContainer cmd execute");
            assert_eq!(
                code as u32, 0,
                "cmd under AppContainer sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn legacy_appcontainer_acl_migrates_across_sandbox_modes() {
            let guard = SandboxTestGuard::acquire();
            let workspace = tempfile::tempdir().expect("workspace");
            let read_path = workspace.path().join("read.txt");
            let offline_path = workspace.path().join("offline.txt");
            let online_path = workspace.path().join("online.txt");
            let outside_path = unique_probe(
                workspace.path().parent().expect("workspace parent"),
                "offline-outside",
            );
            let _ = std::fs::remove_file(&outside_path);
            std::fs::write(&read_path, "read-ok").expect("seed readable file");

            let synthetic = crate::runtime::sandbox::synthetic_workspace_sid(workspace.path());
            let dir_key = synthetic.trim_start_matches("S-1-5-21-").replace('-', "_");
            win::seed_legacy_appcontainer_ace_for_test(workspace.path(), &dir_key)
                .expect("seed legacy package SID ACE");

            let online_script = format!(
                "dir /a /b {} >nul && type {} >nul && echo online>{}",
                workspace.path().display(),
                read_path.display(),
                online_path.display(),
            );
            let first_online = win::execute(
                workspace.path(),
                true,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), online_script.clone()],
            )
            .expect("online sandbox should migrate the legacy package SID ACE");
            assert_eq!(first_online as u32, 0);
            assert!(online_path.is_file());
            guard.restore_env();

            let offline_script = format!(
                "echo outside>{} && exit /b 42 || echo offline>{}",
                outside_path.display(),
                offline_path.display(),
            );
            let offline = win::execute(
                workspace.path(),
                false,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), offline_script],
            );
            assert_eq!(offline.expect("offline capability sandbox") as u32, 0);
            assert!(offline_path.is_file());
            assert!(
                !outside_path.exists(),
                "offline capability sandbox wrote outside workspace: {outside_path:?}"
            );
            guard.restore_env();

            std::fs::remove_file(&online_path).expect("reset online probe");
            let second_online = win::execute(
                workspace.path(),
                true,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), online_script],
            )
            .expect("online sandbox after offline capability sandbox");
            assert_eq!(second_online as u32, 0);
            assert!(online_path.is_file());
            let _ = std::fs::remove_file(outside_path);
        }

        /// Real machine: the object directory name computed from Git for Windows' msys-2.0.dll must be
        /// `\BaseNamedObjects\msys-2.0S5-` + 16 hex chars (aligned with cygwin hash_path_name).
        #[test]
        fn msys_object_dir_name_from_git_bash() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let names = win::msys_object_dir_names_for_test(bash);
            println!("msys object dirs: {names:?}");
            assert!(
                names
                    .iter()
                    .any(|n| n.starts_with(r"\BaseNamedObjects\msys-2.0S5-")),
                "missing hashed msys BNO directory: {names:?}"
            );
            let key = names[0].rsplit('-').next().expect("hash suffix");
            assert_eq!(key.len(), 16, "install key should be 16 hex chars: {key}");
            assert!(
                key.chars().all(|c| c.is_ascii_hexdigit()),
                "install key should be hex: {key}"
            );
        }

        #[test]
        fn restricted_token_can_open_stamped_msys_dir() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            win::restricted_token_can_open_msys_dir(bash)
                .expect("WRITE_RESTRICTED token should open stamped msys directory");
        }

        /// Real machine: Git Bash must be able to start inside the networked Low IL token sandbox.
        #[test]
        fn networked_sandbox_git_bash_exit_zero() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let code = sandbox_exec(bash, &["-c".into(), "exit 0".into()])
                .expect("networked sandbox Git Bash execute");
            assert_eq!(
                code as u32, 0,
                "Git Bash under networked sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn networked_sandbox_git_bash_echo() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let code = sandbox_exec(bash, &["-c".into(), "echo sandbox-ok".into()])
                .expect("networked sandbox Git Bash echo");
            assert_eq!(
                code as u32, 0,
                "Git Bash echo under networked sandbox exited {code:#010X}"
            );
        }

        #[test]
        fn low_integrity_label_recovers_from_modify_only_owner_dacl() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let _guard = SandboxTestGuard::acquire();
            let workspace = tempfile::tempdir().expect("workspace");
            win::prepare_modify_only_low_il_probe(workspace.path())
                .expect("modify-only ACL should reproduce ERROR_ACCESS_DENIED");
            let code = win::execute(
                workspace.path(),
                true,
                false,
                bash,
                &["-c".into(), "echo low-il-acl-recovered".into()],
            )
            .expect("launcher should grant minimal WRITE_OWNER and retry");
            assert_eq!(
                code as u32, 0,
                "git bash under modify-only workspace ACL exited {code:#010X}"
            );
        }

        /// Real machine: Windows PowerShell 5.1 must be able to start inside the networked Low IL token
        /// sandbox (CLR/CNG user surface + session BNO / BNO isolation).
        #[test]
        fn networked_sandbox_powershell_exit_zero() {
            let powershell =
                std::path::Path::new(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
            if !powershell.is_file() {
                return;
            }
            let code = sandbox_exec(
                powershell,
                &[
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-Command".into(),
                    "exit 0".into(),
                ],
            )
            .expect("networked sandbox PowerShell execute");
            assert_eq!(
                code as u32, 0,
                "PowerShell under networked sandbox exited {code:#010X}"
            );
        }

        fn posix_win_path(path: &std::path::Path) -> String {
            let raw = path.to_string_lossy();
            let trimmed = raw.trim_start_matches(r"\\?\");
            let bytes = trimmed.as_bytes();
            if bytes.len() >= 2 && bytes[1] == b':' {
                let drive = (bytes[0] as char).to_ascii_lowercase();
                let rest = trimmed[2..].replace('\\', "/");
                format!("/{drive}{rest}")
            } else {
                trimmed.replace('\\', "/")
            }
        }

        fn unique_probe(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
            dir.join(format!(
                "liveagent-sandbox-fence-{name}-{}.txt",
                std::process::id()
            ))
        }

        /// Real machine: Git Bash must be able to write the workspace but not the workspace parent
        /// directory / user home / drive root. This regresses the hole where the TokenUser restricting
        /// SID reopened all "user-writable" paths.
        #[test]
        fn networked_sandbox_git_bash_write_fence() {
            let bash = std::path::Path::new(r"C:\Program Files\Git\bin\bash.exe");
            if !bash.is_file() {
                return;
            }
            let _guard = SandboxTestGuard::acquire();
            let outer = tempfile::tempdir().expect("outer");
            let workspace = outer.path().join("workspace");
            let sibling = outer.path().join("sibling");
            std::fs::create_dir(&workspace).expect("workspace");
            std::fs::create_dir(&sibling).expect("sibling");

            let inside = unique_probe(&workspace, "inside");
            let outside = unique_probe(&sibling, "outside");
            let home_dir = dirs::home_dir().expect("home");
            let home = unique_probe(&home_dir, "home");
            let drive_root = unique_probe(std::path::Path::new(r"D:\"), "drive");
            let _ = std::fs::remove_file(&home);
            let _ = std::fs::remove_file(&drive_root);

            let script = format!(
                "echo inside > '{inside}' || exit 1; \
                 if echo outside > '{outside}'; then exit 42; fi; \
                 if echo home > '{home}'; then exit 43; fi; \
                 if echo drive > '{drive}'; then exit 44; fi; \
                 exit 0",
                inside = posix_win_path(&inside),
                outside = posix_win_path(&outside),
                home = posix_win_path(&home),
                drive = posix_win_path(&drive_root),
            );
            let code = win::execute(&workspace, true, false, bash, &["-c".into(), script])
                .expect("networked sandbox Git Bash write fence");
            let _ = std::fs::remove_file(&home);
            let _ = std::fs::remove_file(&drive_root);
            assert_eq!(
                code as u32, 0,
                "git bash write-fence script exited {code:#010X} \
                 (42=sibling writable, 43=home writable, 44=drive root writable)"
            );
            assert_eq!(
                std::fs::read_to_string(&inside).unwrap_or_default().trim(),
                "inside"
            );
            assert!(
                !outside.exists(),
                "git bash sandbox wrote outside the workspace: {outside:?}"
            );
            assert!(
                !home.exists(),
                "git bash sandbox wrote to the user profile: {home:?}"
            );
            assert!(
                !drive_root.exists(),
                "git bash sandbox wrote to the drive root: {drive_root:?}"
            );
        }

        /// Real machine: cmd's strict three-SID token should already block writes outside the workspace.
        #[test]
        fn networked_sandbox_cmd_write_fence() {
            let _guard = SandboxTestGuard::acquire();
            let outer = tempfile::tempdir().expect("outer");
            let workspace = outer.path().join("workspace");
            let sibling = outer.path().join("sibling");
            std::fs::create_dir(&workspace).expect("workspace");
            std::fs::create_dir(&sibling).expect("sibling");
            let inside = unique_probe(&workspace, "cmd-inside");
            let outside = unique_probe(&sibling, "cmd-outside");
            let script = format!(
                "echo inside>{0}&echo outside>{1}&exit /b 0",
                inside.display(),
                outside.display()
            );
            win::execute(
                &workspace,
                true,
                false,
                std::path::Path::new("cmd.exe"),
                &["/D".into(), "/C".into(), script],
            )
            .expect("networked sandbox cmd write fence");
            assert_eq!(
                std::fs::read_to_string(&inside).unwrap_or_default().trim(),
                "inside"
            );
            assert!(
                !outside.exists(),
                "cmd sandbox wrote outside the workspace: {outside:?}"
            );
        }
    }
}
