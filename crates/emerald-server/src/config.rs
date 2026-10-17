//! Server configuration: a TOML file, overridden by `EMERALDMD_*` environment
//! variables. Tokens are configured as argon2 hashes only; the plain tokens
//! are never written anywhere by the server.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use argon2::password_hash::phc::PasswordHash;
use serde::Deserialize;

use crate::net::IpNet;

pub const DEFAULT_BIND: &str = "127.0.0.1:8484";
pub const DEFAULT_MAX_BODY_MB: usize = 64;
pub const DEFAULT_MAX_STREAMS_PER_TOKEN: usize = 16;

/// Origins of the EmeraldMD app's webview: `tauri://localhost` on macOS, iOS
/// and Linux, `http(s)://tauri.localhost` on Windows and Android.
pub const APP_ORIGINS: [&str; 3] = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("could not read {path}: {source}")]
    Read { path: PathBuf, source: std::io::Error },
    #[error("invalid config file {path}: {source}")]
    Parse { path: PathBuf, source: Box<toml::de::Error> },
    #[error("{0}")]
    Invalid(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VaultConfig {
    /// Used in URLs: letters, digits, `-` and `_`.
    pub id: String,
    pub path: PathBuf,
    /// Shown in the app. Defaults to the folder name.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenConfig {
    /// A label for logs, e.g. the device the token was made for.
    pub name: String,
    /// Argon2 PHC string, as printed by `emeraldmd-server token new`.
    pub hash: String,
    /// Vault ids this token may open. Omitted: every vault.
    pub vaults: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default = "default_bind")]
    pub bind: SocketAddr,
    /// Extra browser origins allowed to call the API, besides [`APP_ORIGINS`].
    #[serde(default)]
    pub allowed_origins: Vec<String>,
    /// Largest accepted request body (a note's content), in MiB.
    #[serde(default = "default_max_body_mb")]
    pub max_body_mb: usize,
    /// Reverse proxies (IP addresses or CIDR ranges) whose `X-Forwarded-For`
    /// header names the client. Empty: the header is ignored.
    #[serde(default)]
    pub trusted_proxies: Vec<String>,
    /// Event streams (WebSockets) one token may hold open at once.
    #[serde(default = "default_max_streams_per_token")]
    pub max_streams_per_token: usize,
    #[serde(default)]
    pub vaults: Vec<VaultConfig>,
    #[serde(default)]
    pub tokens: Vec<TokenConfig>,
}

fn default_bind() -> SocketAddr {
    DEFAULT_BIND.parse().expect("valid default address")
}

fn default_max_body_mb() -> usize {
    DEFAULT_MAX_BODY_MB
}

fn default_max_streams_per_token() -> usize {
    DEFAULT_MAX_STREAMS_PER_TOKEN
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: default_bind(),
            allowed_origins: Vec::new(),
            max_body_mb: DEFAULT_MAX_BODY_MB,
            trusted_proxies: Vec::new(),
            max_streams_per_token: DEFAULT_MAX_STREAMS_PER_TOKEN,
            vaults: Vec::new(),
            tokens: Vec::new(),
        }
    }
}

impl Config {
    pub fn from_toml(text: &str, path: &Path) -> Result<Self, ConfigError> {
        toml::from_str(text).map_err(|source| ConfigError::Parse { path: path.to_owned(), source: Box::new(source) })
    }

    /// Reads `file` (if given), applies the environment, and validates.
    pub fn load(file: Option<&Path>, env: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let config = Self::read(file, env)?;
        config.validate()?;
        Ok(config)
    }

    /// Reads `file` (if given) and applies the environment, without validating.
    pub fn read(file: Option<&Path>, env: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        let mut config = match file {
            Some(path) => {
                let text = std::fs::read_to_string(path).map_err(|source| ConfigError::Read { path: path.to_owned(), source })?;
                Self::from_toml(&text, path)?
            }
            None => Self::default(),
        };
        config.apply_env(env)?;
        Ok(config)
    }

    /// `EMERALDMD_BIND`, `EMERALDMD_VAULTS` (`id=path` pairs separated by `;`),
    /// `EMERALDMD_TOKEN_HASHES` (whitespace-separated hashes, each allowed every
    /// vault), `EMERALDMD_ALLOWED_ORIGINS` and `EMERALDMD_TRUSTED_PROXIES`
    /// (both comma-separated).
    pub fn apply_env(&mut self, env: impl Fn(&str) -> Option<String>) -> Result<(), ConfigError> {
        if let Some(bind) = env("EMERALDMD_BIND").filter(|s| !s.trim().is_empty()) {
            self.bind = bind.trim().parse().map_err(|_| ConfigError::Invalid(format!("EMERALDMD_BIND is not an address: {bind}")))?;
        }
        if let Some(vaults) = env("EMERALDMD_VAULTS") {
            for pair in vaults.split(';').map(str::trim).filter(|s| !s.is_empty()) {
                let (id, path) = pair
                    .split_once('=')
                    .ok_or_else(|| ConfigError::Invalid(format!("EMERALDMD_VAULTS entry is not id=path: {pair}")))?;
                self.vaults.push(VaultConfig { id: id.trim().to_owned(), path: PathBuf::from(path.trim()), name: None });
            }
        }
        if let Some(hashes) = env("EMERALDMD_TOKEN_HASHES") {
            for (i, hash) in hashes.split_whitespace().enumerate() {
                self.tokens.push(TokenConfig { name: format!("env-{}", i + 1), hash: hash.to_owned(), vaults: None });
            }
        }
        let list = |value: String| value.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect::<Vec<_>>();
        if let Some(origins) = env("EMERALDMD_ALLOWED_ORIGINS") {
            self.allowed_origins.extend(list(origins));
        }
        if let Some(proxies) = env("EMERALDMD_TRUSTED_PROXIES") {
            self.trusted_proxies.extend(list(proxies));
        }
        Ok(())
    }

    /// Everything [`Config::validate_entries`] checks, and at least one token:
    /// a server nobody can use is a setup mistake.
    pub fn validate(&self) -> Result<(), ConfigError> {
        self.validate_entries()?;
        if self.tokens.is_empty() {
            return Err(ConfigError::Invalid(
                "no tokens are configured; create one with `emeraldmd-server token add <name>`, or add a hash from \
                 `emeraldmd-server token new` to [[tokens]] or EMERALDMD_TOKEN_HASHES"
                    .into(),
            ));
        }
        Ok(())
    }

    /// Checks every entry, but accepts a config without tokens: reloading one
    /// after revoking the last token must lock everyone out, not keep the old tokens.
    pub fn validate_entries(&self) -> Result<(), ConfigError> {
        let invalid = |msg: String| Err(ConfigError::Invalid(msg));
        if self.vaults.is_empty() {
            return invalid("no vaults are configured; add a [[vaults]] entry or set EMERALDMD_VAULTS".into());
        }
        let mut ids = HashSet::new();
        for vault in &self.vaults {
            if vault.id.is_empty() || !vault.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                return invalid(format!("vault id {:?} may only contain letters, digits, - and _", vault.id));
            }
            if !ids.insert(vault.id.as_str()) {
                return invalid(format!("vault id {:?} is used twice", vault.id));
            }
        }
        let mut names = HashSet::new();
        for token in &self.tokens {
            if let Err(msg) = check_token_name(&token.name) {
                return invalid(msg);
            }
            if !names.insert(token.name.as_str()) {
                return invalid(format!("token name {:?} is used twice; names identify tokens for `token revoke`", token.name));
            }
            if PasswordHash::new(&token.hash).is_err() {
                return invalid(format!(
                    "token {:?}: hash is not an argon2 PHC string (it should start with $argon2id$); \
                     plain tokens are not accepted in the config",
                    token.name
                ));
            }
            for id in token.vaults.iter().flatten() {
                if !ids.contains(id.as_str()) {
                    return invalid(format!("token {:?} refers to unknown vault {id:?}", token.name));
                }
            }
        }
        if self.max_body_mb == 0 {
            return invalid("max_body_mb must be at least 1".into());
        }
        if self.max_streams_per_token == 0 {
            return invalid("max_streams_per_token must be at least 1".into());
        }
        for proxy in &self.trusted_proxies {
            proxy.parse::<IpNet>().map_err(|e| ConfigError::Invalid(format!("trusted_proxies: {e}")))?;
        }
        Ok(())
    }

    pub fn origins(&self) -> Vec<String> {
        APP_ORIGINS.iter().map(|s| (*s).to_owned()).chain(self.allowed_origins.iter().cloned()).collect()
    }

    /// The parsed `trusted_proxies`; invalid entries were refused by validation.
    pub fn trusted_proxies(&self) -> Vec<IpNet> {
        self.trusted_proxies.iter().filter_map(|p| p.parse().ok()).collect()
    }
}

/// Token names show up in logs and select tokens for `token revoke`.
pub fn check_token_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.len() > 64 || name.chars().any(char::is_control) {
        return Err(format!("token name {name:?} must be 1 to 64 characters, without control characters"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo";

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn parses_a_config_file() {
        let text = format!(
            r#"
            bind = "0.0.0.0:9000"
            allowed_origins = ["https://notes.example.com"]

            [[vaults]]
            id = "notes"
            path = "/srv/notes"
            name = "My notes"

            [[tokens]]
            name = "laptop"
            hash = "{HASH}"
            vaults = ["notes"]
            "#
        );
        let mut config = Config::from_toml(&text, Path::new("test.toml")).unwrap();
        config.apply_env(no_env).unwrap();
        config.validate().unwrap();
        assert_eq!(config.bind.to_string(), "0.0.0.0:9000");
        assert_eq!(config.vaults[0].name.as_deref(), Some("My notes"));
        assert_eq!(config.tokens[0].vaults.as_deref(), Some(&["notes".to_owned()][..]));
        assert_eq!(config.max_body_mb, DEFAULT_MAX_BODY_MB);
        assert!(config.origins().contains(&"tauri://localhost".to_owned()));
        assert!(config.origins().contains(&"https://notes.example.com".to_owned()));
    }

    #[test]
    fn environment_adds_vaults_and_tokens() {
        let env = |key: &str| match key {
            "EMERALDMD_BIND" => Some("127.0.0.1:1234".to_owned()),
            "EMERALDMD_VAULTS" => Some("a=/data/a; b = /data/b ;".to_owned()),
            "EMERALDMD_TOKEN_HASHES" => Some(format!("{HASH}\n{HASH}")),
            _ => None,
        };
        let mut config = Config::default();
        config.apply_env(env).unwrap();
        config.validate().unwrap();
        assert_eq!(config.bind.port(), 1234);
        let vaults: Vec<_> = config.vaults.iter().map(|v| (v.id.as_str(), v.path.to_str().unwrap())).collect();
        assert_eq!(vaults, [("a", "/data/a"), ("b", "/data/b")]);
        assert_eq!(config.tokens.len(), 2);
        assert_eq!(config.tokens[1].name, "env-2");
    }

    #[test]
    fn rejects_unsafe_or_incomplete_configs() {
        let vault = VaultConfig { id: "notes".into(), path: "/srv".into(), name: None };
        let token = TokenConfig { name: "t".into(), hash: HASH.into(), vaults: None };
        let base = Config { vaults: vec![vault.clone()], tokens: vec![token.clone()], ..Config::default() };
        base.validate().unwrap();

        let plain = Config { tokens: vec![TokenConfig { hash: "hunter2".into(), ..token.clone() }], ..base.clone() };
        assert!(plain.validate().unwrap_err().to_string().contains("plain tokens are not accepted"));
        let no_tokens = Config { tokens: vec![], ..base.clone() };
        assert!(no_tokens.validate().is_err());
        let no_vaults = Config { vaults: vec![], ..base.clone() };
        assert!(no_vaults.validate().is_err());
        let bad_id = Config { vaults: vec![VaultConfig { id: "a/b".into(), ..vault.clone() }], ..base.clone() };
        assert!(bad_id.validate().is_err());
        let duplicate = Config { vaults: vec![vault.clone(), vault.clone()], ..base.clone() };
        assert!(duplicate.validate().is_err());
        let unknown = Config { tokens: vec![TokenConfig { vaults: Some(vec!["nope".into()]), ..token.clone() }], ..base.clone() };
        assert!(unknown.validate().is_err());
        let same_name = Config { tokens: vec![token.clone(), token.clone()], ..base.clone() };
        assert!(same_name.validate().unwrap_err().to_string().contains("used twice"));
        let bad_name = Config { tokens: vec![TokenConfig { name: "a\nb".into(), ..token }], ..base.clone() };
        assert!(bad_name.validate().is_err());
        let bad_proxy = Config { trusted_proxies: vec!["proxy.local".into()], ..base.clone() };
        assert!(bad_proxy.validate().unwrap_err().to_string().contains("trusted_proxies"));
        // A reload may leave no tokens at all: that locks everyone out, as intended.
        let revoked_all = Config { tokens: vec![], ..base };
        assert!(revoked_all.validate().is_err());
        revoked_all.validate_entries().unwrap();
    }

    #[test]
    fn trusted_proxies_come_from_the_file_and_the_environment() {
        let text = "trusted_proxies = [\"10.0.0.0/8\"]\n";
        let mut config = Config::from_toml(text, Path::new("test.toml")).unwrap();
        config.apply_env(|key| (key == "EMERALDMD_TRUSTED_PROXIES").then(|| "127.0.0.1, ::1".to_owned())).unwrap();
        let proxies: Vec<String> = config.trusted_proxies().iter().map(ToString::to_string).collect();
        assert_eq!(proxies, ["10.0.0.0/8", "127.0.0.1/32", "::1/128"]);
        assert_eq!(config.max_streams_per_token, DEFAULT_MAX_STREAMS_PER_TOKEN);
    }
}
