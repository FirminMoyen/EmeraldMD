//! Abuse limits: failed authentication per client address, and open event
//! streams per token.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Credentials a client address may try in a burst before it is slowed down.
pub const FAILURE_BURST: u32 = 10;
/// After the burst, one more try per this interval (10 per minute).
pub const FAILURE_REFILL: Duration = Duration::from_secs(6);
/// Addresses remembered at once; beyond that they share one bucket.
const MAX_TRACKED: usize = 10_000;

/// Who a bucket belongs to. IPv6 clients usually control a whole /64, so
/// they are counted by that prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ClientKey {
    V4(u32),
    V6(u64),
    Overflow,
}

impl From<IpAddr> for ClientKey {
    fn from(ip: IpAddr) -> Self {
        match ip.to_canonical() {
            IpAddr::V4(ip) => Self::V4(ip.into()),
            IpAddr::V6(ip) => Self::V6((u128::from(ip) >> 64) as u64),
        }
    }
}

struct Bucket {
    tokens: f64,
    updated: Instant,
}

/// A token bucket per client address, spent by every credential that has to
/// be checked with argon2 (a token not seen before, or a ticket) and refunded
/// when it turns out valid. Known-good tokens skip the bucket entirely, so a
/// client that keeps retrying a revoked token does not lock out the other
/// devices behind the same address.
pub struct FailureLimiter {
    buckets: Mutex<HashMap<ClientKey, Bucket>>,
    burst: f64,
    refill: Duration,
}

impl Default for FailureLimiter {
    fn default() -> Self {
        Self::new(FAILURE_BURST, FAILURE_REFILL)
    }
}

impl FailureLimiter {
    pub fn new(burst: u32, refill: Duration) -> Self {
        Self { buckets: Mutex::new(HashMap::new()), burst: f64::from(burst), refill }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<ClientKey, Bucket>> {
        self.buckets.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn refilled(&self, bucket: &mut Bucket, now: Instant) {
        let earned = now.saturating_duration_since(bucket.updated).as_secs_f64() / self.refill.as_secs_f64();
        bucket.tokens = (bucket.tokens + earned).min(self.burst);
        bucket.updated = now;
    }

    /// Spends one try for `ip`. `Err` holds how long until the next one.
    pub fn try_acquire(&self, ip: IpAddr) -> Result<(), Duration> {
        let now = Instant::now();
        let mut buckets = self.lock();
        let mut key = ClientKey::from(ip);
        if !buckets.contains_key(&key) && buckets.len() >= MAX_TRACKED {
            // Forget clients that have earned all their tries back.
            buckets.retain(|_, b| {
                let earned = now.saturating_duration_since(b.updated).as_secs_f64() / self.refill.as_secs_f64();
                b.tokens + earned < self.burst
            });
            if buckets.len() >= MAX_TRACKED {
                key = ClientKey::Overflow;
            }
        }
        let bucket = buckets.entry(key).or_insert(Bucket { tokens: self.burst, updated: now });
        self.refilled(bucket, now);
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err(self.refill.mul_f64(1.0 - bucket.tokens))
        }
    }

    /// Gives back the try spent on a credential that was valid.
    pub fn refund(&self, ip: IpAddr) {
        let now = Instant::now();
        let mut buckets = self.lock();
        if let Some(bucket) = buckets.get_mut(&ClientKey::from(ip)) {
            self.refilled(bucket, now);
            bucket.tokens = (bucket.tokens + 1.0).min(self.burst);
        }
    }
}

/// Counts open event streams per token (by its hash), so one leaked or
/// buggy client cannot hold an unbounded number of connections.
pub struct StreamCounter {
    open: Mutex<HashMap<Arc<str>, usize>>,
    max_per_token: usize,
}

impl StreamCounter {
    pub fn new(max_per_token: usize) -> Arc<Self> {
        Arc::new(Self { open: Mutex::new(HashMap::new()), max_per_token })
    }

    pub fn max_per_token(&self) -> usize {
        self.max_per_token
    }

    /// A slot for one more stream, released when the permit is dropped.
    pub fn acquire(self: &Arc<Self>, token: &Arc<str>) -> Option<StreamPermit> {
        let mut open = self.open.lock().unwrap_or_else(|e| e.into_inner());
        let count = open.entry(token.clone()).or_insert(0);
        if *count >= self.max_per_token {
            return None;
        }
        *count += 1;
        Some(StreamPermit { counter: Arc::clone(self), token: token.clone() })
    }

    #[cfg(test)]
    fn open(&self, token: &str) -> usize {
        self.open.lock().unwrap().get(token).copied().unwrap_or(0)
    }
}

pub struct StreamPermit {
    counter: Arc<StreamCounter>,
    token: Arc<str>,
}

impl Drop for StreamPermit {
    fn drop(&mut self) {
        let mut open = self.counter.open.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(count) = open.get_mut(&self.token) {
            *count -= 1;
            if *count == 0 {
                open.remove(&self.token);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_of_failures_then_one_per_interval() {
        let limiter = FailureLimiter::new(3, Duration::from_secs(60));
        let ip: IpAddr = "203.0.113.7".parse().unwrap();
        for _ in 0..3 {
            limiter.try_acquire(ip).unwrap();
        }
        let wait = limiter.try_acquire(ip).unwrap_err();
        assert!(wait > Duration::from_secs(50) && wait <= Duration::from_secs(60), "{wait:?}");
        // Another client is not affected.
        limiter.try_acquire("203.0.113.8".parse().unwrap()).unwrap();
        // A valid credential gives its try back.
        limiter.refund(ip);
        limiter.try_acquire(ip).unwrap();
        assert!(limiter.try_acquire(ip).is_err());
    }

    #[test]
    fn ipv6_clients_are_counted_by_their_64_prefix() {
        let limiter = FailureLimiter::new(1, Duration::from_secs(60));
        limiter.try_acquire("2001:db8:1:2::1".parse().unwrap()).unwrap();
        assert!(limiter.try_acquire("2001:db8:1:2:ffff::9".parse().unwrap()).is_err());
        limiter.try_acquire("2001:db8:1:3::1".parse().unwrap()).unwrap();
    }

    #[test]
    fn tries_come_back_over_time() {
        let limiter = FailureLimiter::new(1, Duration::from_millis(20));
        let ip: IpAddr = "198.51.100.1".parse().unwrap();
        limiter.try_acquire(ip).unwrap();
        assert!(limiter.try_acquire(ip).is_err());
        std::thread::sleep(Duration::from_millis(30));
        limiter.try_acquire(ip).unwrap();
    }

    #[test]
    fn stream_permits_are_counted_per_token() {
        let counter = StreamCounter::new(2);
        let (a, b): (Arc<str>, Arc<str>) = (Arc::from("a"), Arc::from("b"));
        let first = counter.acquire(&a).unwrap();
        let _second = counter.acquire(&a).unwrap();
        assert!(counter.acquire(&a).is_none());
        let _other = counter.acquire(&b).unwrap();
        drop(first);
        assert_eq!(counter.open("a"), 1);
        let _third = counter.acquire(&a).unwrap();
    }
}
