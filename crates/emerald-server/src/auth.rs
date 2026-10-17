//! Bearer-token authentication and WebSocket tickets.
//!
//! Tokens are checked against the argon2 hashes from the config. Once a token
//! has been verified, its SHA-256 digest is kept in memory so later requests
//! skip argon2; the plain token is never stored, and digests are compared in
//! constant time. Browsers cannot send headers when opening a WebSocket, so
//! clients exchange their token for a short-lived, single-use ticket and pass
//! that in the URL instead.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use sha2::{Digest, Sha256};
use subtle::{ConditionallySelectable, ConstantTimeEq};
use tokio::sync::Semaphore;

use crate::config::TokenConfig;

pub const TICKET_TTL: Duration = Duration::from_secs(30);
/// Bounds the CPU that requests with unknown tokens can burn on argon2.
const MAX_CONCURRENT_VERIFICATIONS: usize = 2;
/// Verifications allowed to wait for a slot; more are turned away at once
/// instead of piling up connections.
const MAX_WAITING_VERIFICATIONS: usize = 32;
/// Outstanding tickets; only authenticated clients can create them.
const MAX_TICKETS: usize = 10_000;

/// Who a request is from, and which vaults it may open.
#[derive(Debug)]
pub struct Principal {
    pub name: String,
    /// The token's hash from the config, which identifies it across reloads.
    pub(crate) key: Arc<str>,
    /// `None`: every vault.
    vaults: Option<HashSet<String>>,
}

impl Principal {
    pub fn can_open(&self, vault: &str) -> bool {
        self.vaults.as_ref().is_none_or(|ids| ids.contains(vault))
    }
}

struct Token {
    hash: PasswordHash,
    principal: Arc<Principal>,
}

pub enum Verdict {
    Valid(Arc<Principal>),
    Invalid,
    /// Too many verifications are already waiting; try again shortly.
    Busy,
}

/// The configured tokens. Rebuilt on every reload; only verifications of
/// tokens that are still configured carry over, so revoked ones stop working
/// at once.
pub struct Authenticator {
    tokens: Vec<Token>,
    /// SHA-256 of verified tokens, with their index in `tokens`.
    verified: Mutex<Vec<([u8; 32], u64)>>,
    slots: Semaphore,
    waiting: AtomicUsize,
}

fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

impl Authenticator {
    /// The hashes must already be validated (see `Config::validate`).
    pub fn new(tokens: &[TokenConfig]) -> Self {
        let tokens = tokens
            .iter()
            .filter_map(|t| {
                let hash = PasswordHash::new(&t.hash).ok()?;
                let vaults = t.vaults.as_ref().map(|ids| ids.iter().cloned().collect());
                let principal = Principal { name: t.name.clone(), key: Arc::from(t.hash.as_str()), vaults };
                Some(Token { hash, principal: Arc::new(principal) })
            })
            .collect();
        Self {
            tokens,
            verified: Mutex::new(Vec::new()),
            slots: Semaphore::new(MAX_CONCURRENT_VERIFICATIONS),
            waiting: AtomicUsize::new(0),
        }
    }

    /// Remembers the verifications `previous` made of tokens that are still
    /// configured (same hash), so a reload does not send every client back
    /// through argon2 and the failed-login limit.
    pub fn keep_verified(&self, previous: &Authenticator) {
        let carried: Vec<([u8; 32], u64)> = previous
            .verified()
            .iter()
            .filter_map(|(digest, old)| {
                let key = &previous.tokens[*old as usize].principal.key;
                let new = self.tokens.iter().position(|t| t.principal.key == *key)?;
                Some((*digest, new as u64))
            })
            .collect();
        self.verified().extend(carried);
    }

    fn verified(&self) -> MutexGuard<'_, Vec<([u8; 32], u64)>> {
        self.verified.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The principal of a token verified earlier, without running argon2.
    /// Every remembered digest is compared, each in constant time, so the
    /// timing says nothing about how close a guess came.
    pub fn cached(&self, token: &str) -> Option<Arc<Principal>> {
        let digest = digest(token);
        let mut found = subtle::Choice::from(0);
        let mut index = 0u64;
        for (known, i) in self.verified().iter() {
            let equal = known.ct_eq(&digest);
            index.conditional_assign(i, equal);
            found |= equal;
        }
        bool::from(found).then(|| self.tokens[index as usize].principal.clone())
    }

    pub async fn verify(self: &Arc<Self>, token: &str) -> Verdict {
        if let Some(principal) = self.cached(token) {
            return Verdict::Valid(principal);
        }
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_WAITING_VERIFICATIONS {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Verdict::Busy;
        }
        let permit = self.slots.acquire().await;
        self.waiting.fetch_sub(1, Ordering::SeqCst);
        let Ok(_permit) = permit else { return Verdict::Busy };
        // Verified by another request while this one waited?
        if let Some(principal) = self.cached(token) {
            return Verdict::Valid(principal);
        }
        let this = Arc::clone(self);
        let owned = token.to_owned();
        let found = tokio::task::spawn_blocking(move || {
            this.tokens.iter().position(|t| Argon2::default().verify_password(owned.as_bytes(), &t.hash).is_ok())
        })
        .await;
        match found {
            Ok(Some(i)) => {
                self.verified().push((digest(token), i as u64));
                Verdict::Valid(self.tokens[i].principal.clone())
            }
            _ => Verdict::Invalid,
        }
    }

    /// Whether the token with this key is still configured and may open `vault`.
    pub fn allows(&self, key: &str, vault: &str) -> bool {
        self.tokens.iter().any(|t| &*t.principal.key == key && t.principal.can_open(vault))
    }

    pub fn len(&self) -> usize {
        self.tokens.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tokens.is_empty()
    }
}

struct Ticket {
    principal: Arc<Principal>,
    vault: String,
    expires: Instant,
}

/// Single-use tickets for opening an event stream. They outlive config
/// reloads; redeeming one re-checks the token against the current config.
#[derive(Default)]
pub struct Tickets {
    tickets: Mutex<HashMap<String, Ticket>>,
}

impl Tickets {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, Ticket>> {
        self.tickets.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A ticket valid for [`TICKET_TTL`], carrying the token's identity but
    /// only for `vault`. `None` if too many are outstanding.
    pub fn issue(&self, principal: &Principal, vault: &str) -> Option<String> {
        let mut tickets = self.lock();
        let now = Instant::now();
        tickets.retain(|_, t| t.expires > now);
        if tickets.len() >= MAX_TICKETS {
            return None;
        }
        let ticket = random_hex(32);
        let principal = Arc::new(Principal {
            name: principal.name.clone(),
            key: principal.key.clone(),
            vaults: Some(HashSet::from([vault.to_owned()])),
        });
        tickets.insert(ticket.clone(), Ticket { principal, vault: vault.to_owned(), expires: now + TICKET_TTL });
        Some(ticket)
    }

    /// The ticket's principal and vault, once.
    pub fn redeem(&self, ticket: &str) -> Option<(Arc<Principal>, String)> {
        let ticket = self.lock().remove(ticket)?;
        (ticket.expires > Instant::now()).then_some((ticket.principal, ticket.vault))
    }
}

/// Hashes a token with argon2id and the recommended default parameters.
pub fn hash_token(token: &str) -> String {
    Argon2::default().hash_password(token.as_bytes()).expect("argon2 hashing with default parameters").to_string()
}

/// A new random token: `emd_` and 256 random bits in hex.
pub fn new_token() -> String {
    format!("emd_{}", random_hex(32))
}

pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("the OS random number generator is available");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::{Algorithm, Params, Version};

    /// Cheap parameters keep the tests fast; verification reads them from the hash.
    fn quick_hash(token: &str) -> String {
        let params = Params::new(8, 1, 1, None).unwrap();
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params).hash_password(token.as_bytes()).unwrap().to_string()
    }

    fn authenticator() -> Arc<Authenticator> {
        Arc::new(Authenticator::new(&[
            TokenConfig { name: "all".into(), hash: quick_hash("secret-1"), vaults: None },
            TokenConfig { name: "one".into(), hash: quick_hash("secret-2"), vaults: Some(vec!["a".into()]) },
        ]))
    }

    async fn valid(auth: &Arc<Authenticator>, token: &str) -> Option<Arc<Principal>> {
        match auth.verify(token).await {
            Verdict::Valid(principal) => Some(principal),
            _ => None,
        }
    }

    #[tokio::test]
    async fn verifies_tokens_against_hashes() {
        let auth = authenticator();
        assert!(auth.cached("secret-1").is_none());
        assert_eq!(valid(&auth, "secret-1").await.unwrap().name, "all");
        // Second time comes from the digest cache.
        assert_eq!(auth.cached("secret-1").unwrap().name, "all");
        assert_eq!(valid(&auth, "secret-1").await.unwrap().name, "all");
        let one = valid(&auth, "secret-2").await.unwrap();
        assert!(one.can_open("a") && !one.can_open("b"));
        assert_eq!(auth.cached("secret-2").unwrap().name, "one");
        assert!(valid(&auth, "secret-3").await.is_none());
        assert!(valid(&auth, "").await.is_none());
        assert!(auth.cached("secret-3").is_none(), "invalid tokens are not remembered");
        assert!(auth.allows(&one.key, "a") && !auth.allows(&one.key, "b") && !auth.allows("unknown", "a"));
    }

    #[tokio::test]
    async fn reloads_keep_verifications_of_tokens_still_configured() {
        let old = authenticator();
        valid(&old, "secret-1").await.unwrap();
        valid(&old, "secret-2").await.unwrap();
        let tokens = [
            // Same hash, new position and a narrower scope.
            TokenConfig { name: "new".into(), hash: quick_hash("secret-9"), vaults: None },
            TokenConfig { name: "all".into(), hash: old.tokens[0].principal.key.to_string(), vaults: Some(vec!["b".into()]) },
        ];
        let new = Arc::new(Authenticator::new(&tokens));
        new.keep_verified(&old);
        let kept = new.cached("secret-1").unwrap();
        assert!(kept.can_open("b") && !kept.can_open("a"), "the new scope applies");
        assert!(new.cached("secret-2").is_none(), "revoked");
        assert!(valid(&new, "secret-2").await.is_none());
    }

    #[tokio::test]
    async fn tickets_are_single_use_and_scoped_to_one_vault() {
        let auth = authenticator();
        let tickets = Tickets::default();
        let all = valid(&auth, "secret-1").await.unwrap();
        let ticket = tickets.issue(&all, "b").unwrap();
        let (principal, vault) = tickets.redeem(&ticket).unwrap();
        assert_eq!(vault, "b");
        assert!(principal.can_open("b") && !principal.can_open("a"));
        assert_eq!(principal.key, all.key);
        assert!(tickets.redeem(&ticket).is_none());
        assert!(tickets.redeem("not-a-ticket").is_none());
    }

    #[test]
    fn new_tokens_hash_and_verify() {
        let token = new_token();
        assert!(token.starts_with("emd_") && token.len() == 68);
        let hash = hash_token(&token);
        assert!(hash.starts_with("$argon2id$"));
        let parsed = PasswordHash::new(&hash).unwrap();
        assert!(Argon2::default().verify_password(token.as_bytes(), &parsed).is_ok());
    }
}
