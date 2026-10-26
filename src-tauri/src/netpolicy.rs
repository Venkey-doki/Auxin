//! Network rules for user-configured requests (SSRF guard). Flow files can come
//! from a cloned repo, so where a step may connect is decided here, not in the UI.
//! Local and private targets are allowed by default: that is what Auxin is for.

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::Url;
use serde::Deserialize;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::Arc;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NetPolicy {
    /// Loopback, RFC 1918, CGNAT, ULA and `localhost` names.
    pub allow_private: bool,
    /// When non-empty, public hosts must match one entry (`api.x.com` or `*.x.com`).
    pub allow_hosts: Vec<String>,
    /// Environment name, only used in error messages.
    pub env: String,
}

impl Default for NetPolicy {
    fn default() -> Self {
        NetPolicy { allow_private: true, allow_hosts: Vec::new(), env: String::new() }
    }
}

/// A destination refused by policy. Travels through reqwest's error chain
/// (resolver, redirect) so `http::friendly` can show it as-is.
#[derive(Debug)]
pub struct Blocked(pub String);

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Blocked {}

#[derive(Debug, PartialEq)]
enum Class {
    /// Never reachable, whatever the policy says.
    Never(&'static str),
    Private,
    Public,
}

const METADATA: &str = "a cloud metadata address";
const RESERVED: &str = "a reserved address";

fn classify_v4(ip: Ipv4Addr) -> Class {
    let [a, b, ..] = ip.octets();
    if ip == Ipv4Addr::new(169, 254, 169, 254) || ip == Ipv4Addr::new(100, 100, 100, 200) {
        Class::Never(METADATA)
    } else if ip.is_link_local() {
        Class::Never("a link-local address")
    } else if a == 0 || ip.is_broadcast() || ip.is_multicast() {
        Class::Never(RESERVED)
    } else if ip.is_loopback() || ip.is_private() || (a == 100 && (b & 0xc0) == 64) {
        Class::Private
    } else {
        Class::Public
    }
}

fn classify(ip: IpAddr) -> Class {
    let v6 = match ip {
        IpAddr::V4(v4) => return classify_v4(v4),
        IpAddr::V6(v6) => v6,
    };
    let s = v6.segments();
    if v6.is_loopback() {
        Class::Private
    } else if v6.is_unspecified() || v6.is_multicast() {
        Class::Never(RESERVED)
    } else if let Some(v4) = v6.to_ipv4() {
        // IPv4-mapped (::ffff:a.b.c.d) and -compatible (::a.b.c.d).
        classify_v4(v4)
    } else if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        // NAT64 well-known prefix: the gateway connects to the embedded IPv4.
        classify_v4(Ipv4Addr::from(((s[6] as u32) << 16) | s[7] as u32))
    } else if v6 == Ipv6Addr::new(0xfd00, 0xec2, 0, 0, 0, 0, 0, 0x254) {
        Class::Never(METADATA)
    } else if (s[0] & 0xffc0) == 0xfe80 {
        Class::Never("a link-local address")
    } else if (s[0] & 0xfe00) == 0xfc00 {
        Class::Private
    } else {
        Class::Public
    }
}

/// Lowercase, without a trailing dot.
fn norm(host: &str) -> String {
    host.trim_end_matches('.').to_ascii_lowercase()
}

/// Hostnames judged by name alone; anything else is judged by what it resolves to.
fn classify_name(host: &str) -> Option<Class> {
    match host {
        "metadata" | "metadata.google.internal" => Some(Class::Never(METADATA)),
        "localhost" => Some(Class::Private),
        h if h.ends_with(".localhost") => Some(Class::Private),
        _ => None,
    }
}

/// `*.example.com` matches subdomains only; anything else is an exact match.
fn host_matches(pattern: &str, host: &str) -> bool {
    let p = norm(pattern.trim());
    match p.strip_prefix('*') {
        Some(suffix) if suffix.starts_with('.') => host.len() > suffix.len() && host.ends_with(suffix),
        _ => p == host,
    }
}

impl NetPolicy {
    fn blocked(&self, why: String) -> Blocked {
        if self.env.is_empty() {
            Blocked(format!("Blocked by the network rules: {why}"))
        } else {
            Blocked(format!("Blocked by the network rules of “{}”: {why}", self.env))
        }
    }

    /// Judges a destination; `what` names it in the error (never the full URL).
    fn judge(&self, class: Class, host: &str, what: &str) -> Result<(), Blocked> {
        match class {
            Class::Never(why) => Err(self.blocked(format!("{what} is {why}."))),
            Class::Private if !self.allow_private => {
                Err(self.blocked(format!("{what} is a private address, and this environment doesn't allow private addresses.")))
            }
            Class::Private => Ok(()),
            Class::Public if self.allow_hosts.is_empty() || self.allow_hosts.iter().any(|p| host_matches(p, host)) => Ok(()),
            Class::Public => Err(self.blocked(format!("{host} isn't in this environment's allowed hosts."))),
        }
    }

    /// Checks a URL before connecting and on every redirect hop. Hostnames are
    /// checked again on the addresses they resolve to (see `Resolver`).
    pub fn check_url(&self, url: &Url) -> Result<(), Blocked> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(self.blocked(format!("{} URLs aren't allowed, only http and https.", url.scheme())));
        }
        let Some(raw) = url.host_str() else {
            return Err(self.blocked("the URL has no host.".into()));
        };
        // The URL parser has already normalised odd IPv4 forms (`2852039166`, `0x7f.1`).
        if let Ok(ip) = raw.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
            let s = ip.to_string();
            return self.judge(classify(ip), &s, &s);
        }
        let host = norm(raw);
        match classify_name(&host) {
            Some(class) => self.judge(class, &host, &host),
            None => Ok(()),
        }
    }

    /// Keeps only the resolved addresses this policy allows, so the connection
    /// can't be steered elsewhere between the check and the connect (DNS rebinding).
    fn filter(&self, host: &str, addrs: Vec<SocketAddr>) -> Result<Vec<SocketAddr>, Blocked> {
        let host = norm(host);
        if let Some(class) = classify_name(&host) {
            self.judge(class, &host, &host)?;
        }
        let mut first_err = None;
        let ok: Vec<SocketAddr> = addrs
            .into_iter()
            .filter(|a| match self.judge(classify(a.ip()), &host, &format!("{host} ({})", a.ip())) {
                Ok(()) => true,
                Err(e) => {
                    first_err.get_or_insert(e);
                    false
                }
            })
            .collect();
        match first_err {
            Some(e) if ok.is_empty() => Err(e),
            _ => Ok(ok),
        }
    }

    /// The addresses of `host:port` this policy allows, for clients that dial
    /// sockets rather than URLs (message brokers). Blocking: it resolves DNS.
    /// Empty when the name doesn't resolve.
    pub fn check_host(&self, host: &str, port: u16) -> Result<Vec<SocketAddr>, Blocked> {
        let raw = host.trim_start_matches('[').trim_end_matches(']');
        if let Ok(ip) = raw.parse::<IpAddr>() {
            let s = ip.to_string();
            return self.judge(classify(ip), &s, &s).map(|()| vec![SocketAddr::new(ip, port)]);
        }
        self.filter(raw, (raw, port).to_socket_addrs().map(Iterator::collect).unwrap_or_default())
    }
}

/// DNS resolver that only hands reqwest addresses the policy allows.
pub struct Resolver(pub Arc<NetPolicy>);

impl Resolve for Resolver {
    fn resolve(&self, name: Name) -> Resolving {
        let policy = self.0.clone();
        let host = name.as_str().to_string();
        Box::pin(async move {
            let h = host.clone();
            let addrs: Vec<SocketAddr> = tauri::async_runtime::spawn_blocking(move || (h.as_str(), 0).to_socket_addrs())
                .await??
                .collect();
            let ok = policy.filter(&host, addrs)?;
            Ok::<_, Box<dyn std::error::Error + Send + Sync>>(Box::new(ok.into_iter()) as Addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn policy(allow_private: bool) -> NetPolicy {
        NetPolicy { allow_private, allow_hosts: Vec::new(), env: "staging".into() }
    }

    fn check(p: &NetPolicy, url: &str) -> Result<(), String> {
        p.check_url(&Url::parse(url).unwrap()).map_err(|e| e.0)
    }

    #[test]
    fn metadata_and_link_local_are_always_blocked() {
        let p = policy(true);
        let err = check(&p, "http://169.254.169.254/latest/meta-data").unwrap_err();
        assert_eq!(err, "Blocked by the network rules of “staging”: 169.254.169.254 is a cloud metadata address.");
        for url in [
            "http://[::ffff:169.254.169.254]/",
            "http://[::ffff:a9fe:a9fe]/",
            "http://[fe80::1]/",
            "http://[fd00:ec2::254]/",
            "http://100.100.100.200/",
            "http://169.254.1.1/",
            "http://0.0.0.0/",
            "http://[::]/",
            "http://255.255.255.255/",
            "http://224.0.0.1/",
            "http://[64:ff9b::a9fe:a9fe]/",
            "http://METADATA.google.internal./",
            "http://metadata/",
            // Odd literal forms are normalised by the URL parser.
            "http://2852039166/",
        ] {
            assert!(check(&p, url).is_err(), "{url}");
        }
    }

    #[test]
    fn private_addresses_follow_allow_private() {
        for url in ["http://10.0.0.5/", "http://127.0.0.1:8080/", "http://localhost:3000/", "http://api.localhost/", "http://[::1]/", "http://172.16.0.1/", "http://192.168.1.1/", "http://100.64.0.1/", "http://[fd12::1]/", "http://[::ffff:10.0.0.5]/"] {
            assert!(check(&policy(true), url).is_ok(), "{url}");
            assert!(check(&policy(false), url).is_err(), "{url}");
        }
        assert_eq!(
            check(&policy(false), "http://10.0.0.5/x?key=SECRET").unwrap_err(),
            "Blocked by the network rules of “staging”: 10.0.0.5 is a private address, and this environment doesn't allow private addresses."
        );
    }

    #[test]
    fn only_http_and_https() {
        for url in ["ftp://example.com/", "file:///etc/passwd", "gopher://localhost/"] {
            assert!(check(&policy(true), url).unwrap_err().contains("only http and https"), "{url}");
        }
        assert!(check(&policy(true), "https://example.com/").is_ok());
    }

    #[test]
    fn allow_hosts_wildcards_match_subdomains_only() {
        assert!(host_matches("*.example.com", "a.example.com"));
        assert!(host_matches("*.Example.com.", "b.a.example.com"));
        assert!(!host_matches("*.example.com", "example.com"));
        assert!(!host_matches("*.example.com", "evilexample.com"));
        assert!(host_matches("API.example.com", "api.example.com"));
        assert!(!host_matches("api.example.com", "x.api.example.com"));
    }

    #[test]
    fn allow_hosts_gate_public_hosts_only() {
        let p = NetPolicy { allow_private: true, allow_hosts: vec!["*.example.com".into()], env: String::new() };
        let public = |host: &str| p.filter(host, vec![SocketAddr::from(([93, 184, 216, 34], 0))]);
        assert!(public("a.example.com").is_ok());
        assert_eq!(public("api.evil.com").unwrap_err().0, "Blocked by the network rules: api.evil.com isn't in this environment's allowed hosts.");
        // Private destinations are governed by allow_private alone.
        assert!(p.filter("db.internal", vec![SocketAddr::from(([10, 0, 0, 5], 0))]).is_ok());
        assert!(check(&p, "http://127.0.0.1/").is_ok());
        assert!(check(&p, "http://8.8.8.8/").is_err());
    }

    #[test]
    fn resolver_drops_disallowed_addresses() {
        let p = policy(true);
        let mixed = vec![SocketAddr::from(([169, 254, 169, 254], 0)), SocketAddr::from(([10, 0, 0, 5], 0))];
        assert_eq!(p.filter("rebind.test", mixed).unwrap(), vec![SocketAddr::from(([10, 0, 0, 5], 0))]);
        let err = p.filter("rebind.test", vec![SocketAddr::from(([169, 254, 169, 254], 0))]).unwrap_err();
        assert_eq!(err.0, "Blocked by the network rules of “staging”: rebind.test (169.254.169.254) is a cloud metadata address.");
    }

    #[test]
    fn resolver_rejects_localhost_when_private_is_off() {
        let r = Resolver(Arc::new(policy(false)));
        let err = tauri::async_runtime::block_on(r.resolve(Name::from_str("localhost").unwrap())).err().unwrap();
        assert!(err.to_string().contains("localhost is a private address"), "{err}");
        let r = Resolver(Arc::new(policy(true)));
        let addrs: Vec<_> = tauri::async_runtime::block_on(r.resolve(Name::from_str("localhost").unwrap())).ok().unwrap().collect();
        assert!(addrs.iter().all(|a| a.ip().is_loopback()) && !addrs.is_empty(), "{addrs:?}");
    }

    #[test]
    fn check_host_applies_the_same_rules() {
        let (on, off) = (policy(true), policy(false));
        assert_eq!(on.check_host("127.0.0.1", 5672).unwrap(), vec![SocketAddr::from(([127, 0, 0, 1], 5672))]);
        assert_eq!(on.check_host("[::1]", 9092).unwrap(), vec![SocketAddr::from((Ipv6Addr::LOCALHOST, 9092))]);
        assert!(on.check_host("localhost", 9092).unwrap().iter().all(|a| a.ip().is_loopback() && a.port() == 9092));
        assert_eq!(on.check_host("169.254.169.254", 80).unwrap_err().0, "Blocked by the network rules of “staging”: 169.254.169.254 is a cloud metadata address.");
        assert!(on.check_host("metadata.google.internal", 80).is_err());
        assert!(off.check_host("localhost", 5672).unwrap_err().0.contains("localhost is a private address"));
        assert!(off.check_host("10.0.0.5", 5672).unwrap_err().0.contains("10.0.0.5 is a private address"));
        let only = NetPolicy { allow_private: true, allow_hosts: vec!["*.example.com".into()], env: String::new() };
        assert_eq!(only.check_host("8.8.8.8", 9092).unwrap_err().0, "Blocked by the network rules: 8.8.8.8 isn't in this environment's allowed hosts.");
        assert!(on.check_host("no-such-host.invalid", 5672).unwrap().is_empty());
    }

    #[test]
    fn default_policy_allows_private() {
        let p: NetPolicy = serde_json::from_str("{}").unwrap();
        assert!(p.allow_private && p.allow_hosts.is_empty() && p.env.is_empty());
        let p: NetPolicy = serde_json::from_str(r#"{"allowPrivate":false,"allowHosts":["*.x.com"],"env":"prod"}"#).unwrap();
        assert!(!p.allow_private && p.allow_hosts == ["*.x.com"] && p.env == "prod");
    }
}
