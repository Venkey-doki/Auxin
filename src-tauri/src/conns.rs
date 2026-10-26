//! Connection sampling: asks `lsof` which TCP connections the flow's process groups hold,
//! and maps each connection's remote port back to the service that listens on it.

use std::collections::{BTreeSet, HashMap};

/// `groups`: (alias, process-group id). `port_owner`: listening port → alias.
/// Returns (from_alias, to_alias) pairs, deduplicated, sorted.
#[cfg(unix)]
pub fn sample_connections(groups: &[(String, u32)], port_owner: &HashMap<u16, String>) -> Vec<(String, String)> {
    if groups.is_empty() || port_owner.is_empty() {
        return Vec::new();
    }
    match run_lsof(groups) {
        Some(out) => parse_lsof(&out, groups, port_owner),
        None => Vec::new(),
    }
}

// TODO: Windows support (Get-NetTCPConnection / netstat).
#[cfg(not(unix))]
pub fn sample_connections(_groups: &[(String, u32)], _port_owner: &HashMap<u16, String>) -> Vec<(String, String)> {
    Vec::new()
}

#[cfg(unix)]
const LSOF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Runs lsof with a hard timeout; None when it is missing, fails to start, or hangs.
#[cfg(unix)]
fn run_lsof(groups: &[(String, u32)]) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::sync::mpsc;

    let pgids = groups.iter().map(|(_, g)| g.to_string()).collect::<Vec<_>>().join(",");
    let mut child = Command::new("lsof")
        .args(["-nP", "-a", "-iTCP", "-sTCP:ESTABLISHED", "-g", &pgids, "-F", "pgn"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    // Drain on a thread so a large listing can't fill the pipe while we wait on the timer.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(LSOF_TIMEOUT) {
        Ok(buf) => {
            // lsof exits 1 when nothing matches; empty output is the answer, not an error.
            let _ = child.wait();
            Some(String::from_utf8_lossy(&buf).into_owned())
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

/// Parses `lsof -F pgn` output. A record is `p<pid>`, `g<pgid>`, then per-file fields (`f`, `n`, ...);
/// unknown field letters are ignored.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn parse_lsof(output: &str, groups: &[(String, u32)], port_owner: &HashMap<u16, String>) -> Vec<(String, String)> {
    let mut found = BTreeSet::new();
    // Alias of the process group the current `p` record belongs to.
    let mut current: Option<&str> = None;
    for line in output.lines() {
        let line = line.trim_end();
        let Some(tag) = line.chars().next() else { continue };
        let value = &line[tag.len_utf8()..];
        match tag {
            // A new process starts; its group is unknown until the `g` line.
            'p' => current = None,
            'g' => current = value.parse::<u32>().ok().and_then(|g| groups.iter().find(|(_, id)| *id == g)).map(|(a, _)| a.as_str()),
            'n' => {
                let (Some(from), Some(port)) = (current, remote_port(value)) else { continue };
                if let Some(to) = port_owner.get(&port)
                    && to != from
                {
                    found.insert((from.to_string(), to.clone()));
                }
            }
            _ => {}
        }
    }
    found.into_iter().collect()
}

/// Remote port of `local->remote` (`127.0.0.1:52344->127.0.0.1:8000`, `[::1]:1->[::1]:2`, `localhost:1->localhost:2`).
fn remote_port(name: &str) -> Option<u16> {
    let (_, remote) = name.split_once("->")?;
    let remote = remote.split_whitespace().next()?;
    remote.rsplit_once(':')?.1.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn groups() -> Vec<(String, u32)> {
        vec![("web".into(), 100), ("api".into(), 200)]
    }

    fn owners() -> HashMap<u16, String> {
        HashMap::from([(3000, "web".to_string()), (8000, "api".to_string()), (5000, "db".to_string())])
    }

    fn pair(a: &str, b: &str) -> (String, String) {
        (a.to_string(), b.to_string())
    }

    #[test]
    fn ipv4() {
        let out = "p1234\ng100\nf12\nn127.0.0.1:52344->127.0.0.1:8000\n";
        assert_eq!(parse_lsof(out, &groups(), &owners()), vec![pair("web", "api")]);
    }

    #[test]
    fn ipv6_brackets_and_hostnames() {
        let out = "p1\ng100\nn[::1]:50000->[::1]:5000\np2\ng200\nn[::1]:50001->[::1]:3000\np3\ng100\nnlocalhost:50002->localhost:8000\n";
        assert_eq!(parse_lsof(out, &groups(), &owners()), vec![pair("api", "web"), pair("web", "api"), pair("web", "db")]);
    }

    #[test]
    fn multiple_pids_in_one_group() {
        let out = "p11\ng100\nn127.0.0.1:1->127.0.0.1:8000\np12\ng100\nn127.0.0.1:2->127.0.0.1:5000\nf9\nn127.0.0.1:3->127.0.0.1:8000\n";
        assert_eq!(parse_lsof(out, &groups(), &owners()), vec![pair("web", "api"), pair("web", "db")]);
    }

    #[test]
    fn own_port_ignored() {
        // web talking to its own port, and api's accepted side (remote is an ephemeral port).
        let out = "p1\ng100\nn127.0.0.1:50000->127.0.0.1:3000\np2\ng200\nn127.0.0.1:8000->127.0.0.1:50000\n";
        assert!(parse_lsof(out, &groups(), &owners()).is_empty());
    }

    #[test]
    fn unknown_port_and_unknown_group_ignored() {
        let out = "p1\ng100\nn127.0.0.1:50000->127.0.0.1:9999\np2\ng999\nn127.0.0.1:50001->127.0.0.1:8000\n";
        assert!(parse_lsof(out, &groups(), &owners()).is_empty());
    }

    #[test]
    fn dedupe_and_sort() {
        let out = "p1\ng200\nn[::1]:1->[::1]:5000\np2\ng100\nn127.0.0.1:2->127.0.0.1:8000\nn127.0.0.1:3->127.0.0.1:8000\np3\ng200\nn[::1]:4->[::1]:5000\n";
        assert_eq!(parse_lsof(out, &groups(), &owners()), vec![pair("api", "db"), pair("web", "api")]);
    }

    #[test]
    fn garbage_lines_tolerated() {
        let out = "\nlsof: WARNING: something\nxyz\np\ng\ngabc\nn\nn->\np1\ng100\nnno-arrow\nn127.0.0.1:1->\nn127.0.0.1:1->host:notaport\nTST=ESTABLISHED\nn127.0.0.1:2->127.0.0.1:8000 (ESTABLISHED)\n\u{e9}\n";
        assert_eq!(parse_lsof(out, &groups(), &owners()), vec![pair("web", "api")]);
    }

    #[test]
    fn empty_input() {
        assert!(parse_lsof("", &groups(), &owners()).is_empty());
        assert!(sample_connections(&[], &owners()).is_empty());
    }

    /// Smoke test against the real lsof: must not panic, whatever it returns.
    #[test]
    #[ignore]
    fn sample_current_process_group() {
        #[cfg(unix)]
        {
            let pgid = unsafe { libc::getpgid(0) } as u32;
            let got = sample_connections(&[("me".to_string(), pgid)], &owners());
            println!("{got:?}");
        }
    }
}
