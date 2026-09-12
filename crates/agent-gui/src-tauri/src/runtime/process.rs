use std::io;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

#[cfg(unix)]
pub(crate) fn configure_child_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
pub(crate) fn configure_child_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn configure_child_process_group(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn signal_process_tree_by_pid(pid: u32, force: bool) {
    let signal = if force { "-KILL" } else { "-TERM" };
    let process_group = format!("-{pid}");
    let _ = Command::new("kill")
        .arg(signal)
        .arg("--")
        .arg(process_group)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
pub(crate) fn signal_process_tree_by_pid(pid: u32, _force: bool) {
    let mut command = Command::new("taskkill");
    configure_child_process_group(&mut command);
    let _ = command
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn signal_process_tree_by_pid(_pid: u32, _force: bool) {}

fn signal_child_process_tree(child: &Child, force: bool) {
    signal_process_tree_by_pid(child.id(), force);
}

pub(crate) fn terminate_child_process_tree(
    child: &mut Child,
    grace: Duration,
) -> io::Result<ExitStatus> {
    signal_child_process_tree(child, false);
    let grace_started = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if grace_started.elapsed() >= grace {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    signal_child_process_tree(child, true);
    let _ = child.kill();
    child.wait()
}

pub(crate) fn kill_child_process_tree_best_effort(child: &mut Child) {
    signal_child_process_tree(child, true);
    let _ = child.kill();
    let _ = child.wait();
}

/// Terminates a process tree identified only by its group-leader pid (no
/// Child handle): TERM to the group, bounded grace while probing the leader,
/// then an unconditional KILL sweep so group members that outlived the
/// leader are still reaped.
pub(crate) fn terminate_process_tree_by_pid(pid: u32, grace: Duration) {
    signal_process_tree_by_pid(pid, false);
    let grace_started = Instant::now();
    while matches!(probe_process_start_time(pid), ProcessProbe::Alive { .. }) {
        if grace_started.elapsed() >= grace {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    signal_process_tree_by_pid(pid, true);
}

#[cfg(unix)]
fn unix_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

/// Liveness probe outcome. `Unknown` (transient probe failure) is distinct
/// from `Dead` so callers never mistake a hiccup for an exit and, worse,
/// kill or forget a live process based on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessProbe {
    Alive { started_at_ms: i64 },
    Dead,
    Unknown,
}

pub(crate) fn process_start_time_ms(pid: u32) -> Option<i64> {
    match probe_process_start_time(pid) {
        ProcessProbe::Alive { started_at_ms } => Some(started_at_ms),
        ProcessProbe::Dead | ProcessProbe::Unknown => None,
    }
}

#[cfg(unix)]
pub(crate) fn probe_process_start_time(pid: u32) -> ProcessProbe {
    let output = Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("etime=")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let Ok(output) = output else {
        return ProcessProbe::Unknown;
    };
    // ps exits non-zero (with empty output) when the pid does not exist.
    if !output.status.success() {
        return ProcessProbe::Dead;
    }
    let etime = String::from_utf8_lossy(&output.stdout);
    let etime = etime.trim();
    if etime.is_empty() {
        return ProcessProbe::Dead;
    }
    match parse_ps_etime_ms(etime) {
        Some(elapsed_ms) => ProcessProbe::Alive {
            started_at_ms: unix_now_ms() - elapsed_ms,
        },
        None => ProcessProbe::Unknown,
    }
}

/// Parses `ps -o etime` output shaped `[[dd-]hh:]mm:ss` into milliseconds.
#[cfg(unix)]
fn parse_ps_etime_ms(raw: &str) -> Option<i64> {
    let (days, clock) = match raw.split_once('-') {
        Some((days, clock)) => (days.trim().parse::<i64>().ok()?, clock),
        None => (0, raw),
    };
    let mut seconds = 0i64;
    for part in clock.split(':') {
        seconds = seconds * 60 + part.trim().parse::<i64>().ok()?;
    }
    Some((days * 24 * 60 * 60 + seconds) * 1000)
}

#[cfg(windows)]
pub(crate) fn probe_process_start_time(pid: u32) -> ProcessProbe {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const FILETIME_UNIX_EPOCH_OFFSET_100NS: i64 = 116_444_736_000_000_000;

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return ProcessProbe::Dead;
        }
        let mut exit_code: u32 = 0;
        if GetExitCodeProcess(handle, &mut exit_code) == 0 {
            CloseHandle(handle);
            return ProcessProbe::Unknown;
        }
        if exit_code != STILL_ACTIVE as u32 {
            CloseHandle(handle);
            return ProcessProbe::Dead;
        }
        let mut creation = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0;
        CloseHandle(handle);
        if !ok {
            return ProcessProbe::Unknown;
        }
        let filetime_100ns =
            ((creation.dwHighDateTime as i64) << 32) | creation.dwLowDateTime as i64;
        ProcessProbe::Alive {
            started_at_ms: (filetime_100ns - FILETIME_UNIX_EPOCH_OFFSET_100NS) / 10_000,
        }
    }
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn probe_process_start_time(_pid: u32) -> ProcessProbe {
    ProcessProbe::Unknown
}

/// Tolerance for start-time comparison: beyond this, the pid is considered reused by another process and must not be signaled.
///
/// On unix, `ps -o etime=` only has second-level precision, so the derived start time inevitably jitters, hence the slack
/// here; on windows, `GetProcessTimes` gives the creation time directly, accurate to 100ns, and the same slack is merely
/// a bit wider and won't cause a missed pid-reuse detection. **This constant must be visible on all platforms**—it is used by
/// the non-`cfg`-gated `terminate_process_tree_by_pid_if_same`, and defining it only under unix would make
/// the windows build fail with E0425 (the CI Rust check only runs on Linux and would not catch it).
const PID_START_TIME_TOLERANCE_MS: i64 = 2_000;

/// Terminates the process tree by pid, but first confirms this pid is still the process that was originally started.
///
/// The reaper thread `wait()`s the child as soon as it exits, after which the kernel may reuse the pid—
/// sending TERM/KILL to a pid that is "no longer our child" would harm an innocent process. So callers record
/// `started_at_ms` at spawn time, and here we first compare start times: if the process has vanished (judged Dead) or the start
/// time doesn't match (pid reuse), we return immediately.
pub(crate) fn terminate_process_tree_by_pid_if_same(
    pid: u32,
    started_at_ms: Option<i64>,
    grace: Duration,
) {
    let Some(expected_started_at_ms) = started_at_ms else {
        // Start time wasn't probed at spawn (e.g. `ps` failed): fall back to the old pid-only semantics,
        // consistent with managed_process's existing tradeoff.
        terminate_process_tree_by_pid(pid, grace);
        return;
    };
    match probe_process_start_time(pid) {
        ProcessProbe::Dead => return,
        ProcessProbe::Alive {
            started_at_ms: actual,
        } if (actual - expected_started_at_ms).abs() > PID_START_TIME_TOLERANCE_MS => return,
        // Unknown (probe failed) keeps the old behavior: signal conservatively, preferring to kill the process group one extra time.
        ProcessProbe::Alive { .. } | ProcessProbe::Unknown => {}
    }
    terminate_process_tree_by_pid(pid, grace);
}

/// Spawn a fire-and-forget child and reap it on a detached thread.
///
/// `std::process::Child` does not drop-reap: if the Child is dropped after `spawn()` and nobody `wait()`s
/// when the child exits, it hangs as a `<defunct>` under this process until this process exits.
/// System launchers (`open` / `explorer.exe` / `xdg-open`) must "not wait for it, but still reap it"—
/// otherwise every reveal-in-Finder/Explorer leaks a zombie, and the PID table keeps growing across long sessions.
///
/// Returns the child pid for callers to record and tests to observe.
pub(crate) fn spawn_and_reap(command: &mut Command) -> io::Result<u32> {
    let child = command.spawn()?;
    let pid = child.id();
    spawn_child_reaper(child);
    Ok(pid)
}

/// `wait()`s a child process whose handle is no longer needed, on a detached thread.
///
/// If thread creation fails (extreme resource exhaustion), the child degrades to unreaped—more acceptable than
/// panicking here or blocking the caller, and it is observable: it shows up as `<defunct>` in the process table.
pub(crate) fn spawn_child_reaper(mut child: Child) {
    let spawned = std::thread::Builder::new()
        .name("child-reaper".to_string())
        .spawn(move || {
            let _ = child.wait();
        });
    if let Err(error) = spawned {
        eprintln!("spawn child reaper failed (child may stay defunct): {error}");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// First character of `ps -o stat=` (`Z` means zombie); returns None if the process has vanished.
    #[cfg(test)]
    fn process_state_flag(pid: u32) -> Option<String> {
        let output = Command::new("ps")
            .arg("-p")
            .arg(pid.to_string())
            .arg("-o")
            .arg("stat=")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() { None } else { Some(text) }
    }

    #[test]
    fn parse_ps_etime_handles_all_shapes() {
        assert_eq!(parse_ps_etime_ms("05"), Some(5_000));
        assert_eq!(parse_ps_etime_ms("01:05"), Some(65_000));
        assert_eq!(parse_ps_etime_ms("02:01:05"), Some(7_265_000));
        assert_eq!(
            parse_ps_etime_ms("3-02:01:05"),
            Some(3 * 24 * 60 * 60 * 1000 + 7_265_000)
        );
        assert_eq!(parse_ps_etime_ms(""), None);
        assert_eq!(parse_ps_etime_ms("abc"), None);
    }

    #[test]
    fn process_start_time_probes_liveness() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleep should spawn");
        let pid = child.id();
        let started = process_start_time_ms(pid).expect("live process should report start time");
        let drift = (unix_now_ms() - started).abs();
        assert!(drift < 60_000, "start time drifted {drift}ms");
        let _ = child.kill();
        let _ = child.wait();
        // Reaped child must eventually read as gone.
        let mut gone = false;
        for _ in 0..50 {
            if process_start_time_ms(pid).is_none() {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(gone, "killed process still probes alive");
    }

    #[test]
    fn detached_child_is_reaped_instead_of_left_defunct() {
        // Regression lock: dropping the Child after `spawn()` leaves the child hanging as `<defunct>` under the parent
        // after it exits (one leaked per system-launcher call); the reaper thread must clear it from the process table.
        // Under the old implementation this loop would keep reading "Z" and eventually panic.
        let mut command = Command::new("true");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let pid = spawn_and_reap(&mut command).expect("true should spawn");

        let mut zombies = Vec::new();
        for _ in 0..150 {
            match process_state_flag(pid) {
                // Reaped: the process table no longer has this entry.
                None => return,
                Some(state) if !state.starts_with('Z') => return,
                Some(state) => zombies.push(state),
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("detached child stayed defunct for 3s: {zombies:?}");
    }
}
