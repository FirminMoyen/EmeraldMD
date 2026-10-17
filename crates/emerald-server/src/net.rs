//! Client addresses: which IP a request comes from, honouring
//! `X-Forwarded-For` only from configured reverse proxies.

use std::fmt;
use std::net::IpAddr;
use std::str::FromStr;

use axum::http::HeaderMap;

/// An IP address or CIDR range, e.g. `127.0.0.1`, `10.0.0.0/8` or `fd00::/8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IpNet {
    addr: IpAddr,
    prefix: u8,
}

impl IpNet {
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => masked(u32::from(net).into(), 32, self.prefix) == masked(u32::from(ip).into(), 32, self.prefix),
            (IpAddr::V6(net), IpAddr::V6(ip)) => masked(net.into(), 128, self.prefix) == masked(ip.into(), 128, self.prefix),
            _ => false,
        }
    }
}

fn masked(bits: u128, width: u8, prefix: u8) -> u128 {
    if prefix == 0 { 0 } else { bits >> (width - prefix) }
}

impl FromStr for IpNet {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let invalid = || format!("{s:?} is not an IP address or CIDR range");
        let (addr, prefix) = match s.trim().split_once('/') {
            Some((addr, prefix)) => (addr, Some(prefix.parse::<u8>().map_err(|_| invalid())?)),
            None => (s.trim(), None),
        };
        let addr = addr.parse::<IpAddr>().map_err(|_| invalid())?.to_canonical();
        let width = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(width);
        if prefix > width {
            return Err(invalid());
        }
        Ok(Self { addr, prefix })
    }
}

impl fmt::Display for IpNet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

/// The address a request comes from. Behind trusted proxies this is the
/// right-most `X-Forwarded-For` entry that is not itself a trusted proxy:
/// entries further left were written by the client and can be forged.
pub fn client_ip(peer: IpAddr, headers: &HeaderMap, trusted: &[IpNet]) -> IpAddr {
    let peer = peer.to_canonical();
    let is_trusted = |ip: IpAddr| trusted.iter().any(|net| net.contains(ip));
    if !is_trusted(peer) {
        return peer;
    }
    let hops: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .collect();
    let mut client = peer;
    for hop in hops.iter().rev() {
        let Some(ip) = parse_hop(hop) else { break };
        client = ip;
        if !is_trusted(ip) {
            break;
        }
    }
    client
}

/// `1.2.3.4`, `2001:db8::1`, or either with a port (`1.2.3.4:5678`, `[2001:db8::1]:5678`).
fn parse_hop(hop: &str) -> Option<IpAddr> {
    hop.parse::<IpAddr>()
        .or_else(|_| hop.parse::<std::net::SocketAddr>().map(|s| s.ip()))
        .ok()
        .map(|ip| ip.to_canonical())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nets(list: &[&str]) -> Vec<IpNet> {
        list.iter().map(|s| s.parse().unwrap()).collect()
    }

    fn forwarded(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", value.parse().unwrap());
        headers
    }

    #[test]
    fn parses_addresses_and_ranges() {
        let net: IpNet = "10.1.0.0/16".parse().unwrap();
        assert!(net.contains("10.1.200.3".parse().unwrap()));
        assert!(!net.contains("10.2.0.1".parse().unwrap()));
        assert!(net.contains("::ffff:10.1.0.9".parse().unwrap()), "IPv4-mapped IPv6 counts as IPv4");
        let single: IpNet = "127.0.0.1".parse().unwrap();
        assert!(single.contains("127.0.0.1".parse().unwrap()) && !single.contains("127.0.0.2".parse().unwrap()));
        let v6: IpNet = "fd00::/8".parse().unwrap();
        assert!(v6.contains("fd12::1".parse().unwrap()) && !v6.contains("fe80::1".parse().unwrap()));
        let all: IpNet = "0.0.0.0/0".parse().unwrap();
        assert!(all.contains("8.8.8.8".parse().unwrap()));
        for bad in ["", "10.0.0.0/33", "::/129", "localhost", "10.0.0.0/x"] {
            assert!(bad.parse::<IpNet>().is_err(), "{bad}");
        }
        assert_eq!(v6.to_string(), "fd00::/8");
    }

    #[test]
    fn forwarded_for_counts_only_behind_a_trusted_proxy() {
        let peer: IpAddr = "172.28.84.2".parse().unwrap();
        let headers = forwarded("6.6.6.6, 203.0.113.7");
        // Without trusted proxies the header is ignored.
        assert_eq!(client_ip(peer, &headers, &[]), peer);
        // A peer outside the trusted range cannot choose its address either.
        assert_eq!(client_ip(peer, &headers, &nets(&["10.0.0.0/8"])), peer);
        // Behind the proxy: the last hop the proxy appended, not what the client wrote.
        assert_eq!(client_ip(peer, &headers, &nets(&["172.28.84.0/24"])), "203.0.113.7".parse::<IpAddr>().unwrap());
        // Chained proxies are skipped.
        let chained = forwarded("203.0.113.7, 172.28.84.9");
        assert_eq!(client_ip(peer, &chained, &nets(&["172.28.84.0/24"])), "203.0.113.7".parse::<IpAddr>().unwrap());
        // Ports and IPv6 brackets are tolerated; garbage stops the walk at the last good hop.
        let ported = forwarded("[2001:db8::1]:443");
        assert_eq!(client_ip(peer, &ported, &nets(&["172.28.84.0/24"])), "2001:db8::1".parse::<IpAddr>().unwrap());
        let garbage = forwarded("not-an-ip");
        assert_eq!(client_ip(peer, &garbage, &nets(&["172.28.84.0/24"])), peer);
        assert_eq!(client_ip(peer, &HeaderMap::new(), &nets(&["172.28.84.0/24"])), peer);
    }
}
