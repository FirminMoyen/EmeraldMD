//! Bearer-token authentication and WebSocket tickets.
//!
//! Tokens are checked against the argon2 hashes from the config. Once a token
//! has been verified, its SHA-256 digest is kept in memory so later requests
//! skip argon2; the plain token is never stored. Browsers cannot send headers
//! when opening a WebSocket, so clients exchange their token for a short-lived,
//! single-use ticket and pass that in the URL instead.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::config::TokenConfig;

pub const TICKET_TTL: Duration = Duration::from_secs(30);
/// Bounds the CPU that requests with unknown tokens can burn on argon2.
const MAX_CONCURRENT_VERIFICATIONS: usize = 2;

/// Who a request is from, and which vaults it may open.
#[derive(Debug)]
pub struct Principal {
    pub name: String,
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

struct Ticket {
    principal: Arc<Principal>,
    expires: Instant,
}

pub struct Authenticator {
    tokens: Vec<Token>,
    verified: Mutex<HashMap<[u8; 32], usize>>,
    limiter: Semaphore,
    tickets: Mutex<HashMap<String, Ticket>>,
}

impl Authenticator {
    /// The hashes must already be validated (see `Config::validate`).
    pub fn new(tokens: &[TokenConfig]) -> Self {
        let tokens = tokens
            .iter()
            .filter_map(|t| {
                let hash = PasswordHash::new(&t.hash).ok()?;
                let vaults = t.vaults.as_ref().map(|ids| ids.iter().cloned().collect());
                Some(Token { hash, principal: Arc::new(Principal { name: t.name.clone(), vaults }) })
            })
            .collect();
        Self {
            tokens,
            verified: Mutex::new(HashMap::new()),
            limiter: Semaphore::new(MAX_CONCURRENT_VERIFICATIONS),
            tickets: Mutex::new(HashMap::new()),
        }
    }

    pub async fn verify(self: &Arc<Self>, token: &str) -> Option<Arc<Principal>> {
        let digest: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        if let Some(&i) = self.verified.lock().ok()?.get(&digest) {
            return Some(self.tokens[i].principal.clone());
        }
        let _permit = self.limiter.acquire().await.ok()?;
        let this = Arc::clone(self);
        let token = token.to_owned();
        let found = tokio::task::spawn_blocking(move || {
            this.tokens.iter().position(|t| Argon2::default().verify_password(token.as_bytes(), &t.hash).is_ok())
        })
        .await
        .ok()??;
        self.verified.lock().ok()?.insert(digest, found);
        Some(self.tokens[found].principal.clone())
    }

    /// A single-use ticket for opening the event stream, valid for [`TICKET_TTL`].
    /// It carries the token's identity but only for `vault`.
    pub fn issue_ticket(&self, principal: &Principal, vault: &str) -> String {
        let ticket = random_hex(32);
        let principal = Arc::new(Principal { name: principal.name.clone(), vaults: Some(HashSet::from([vault.to_owned()])) });
        if let Ok(mut tickets) = self.tickets.lock() {
            let now = Instant::now();
            tickets.retain(|_, t| t.expires > now);
            tickets.insert(ticket.clone(), Ticket { principal, expires: now + TICKET_TTL });
        }
        ticket
    }

    pub fn redeem_ticket(&self, ticket: &str) -> Option<Arc<Principal>> {
        let ticket = self.tickets.lock().ok()?.remove(ticket)?;
        (ticket.expires > Instant::now()).then_some(ticket.principal)
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

    #[tokio::test]
    async fn verifies_tokens_against_hashes() {
        let auth = authenticator();
        assert_eq!(auth.verify("secret-1").await.unwrap().name, "all");
        // Second time comes from the digest cache.
        assert_eq!(auth.verify("secret-1").await.unwrap().name, "all");
        let one = auth.verify("secret-2").await.unwrap();
        assert!(one.can_open("a") && !one.can_open("b"));
        assert!(auth.verify("secret-3").await.is_none());
        assert!(auth.verify("").await.is_none());
    }

    #[tokio::test]
    async fn tickets_are_single_use_and_scoped_to_one_vault() {
        let auth = authenticator();
        let all = auth.verify("secret-1").await.unwrap();
        let ticket = auth.issue_ticket(&all, "b");
        let principal = auth.redeem_ticket(&ticket).unwrap();
        assert!(principal.can_open("b") && !principal.can_open("a"));
        assert!(auth.redeem_ticket(&ticket).is_none());
        assert!(auth.redeem_ticket("not-a-ticket").is_none());
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
