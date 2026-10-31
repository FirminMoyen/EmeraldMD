//! `emeraldmd-server token add | list | revoke`: manage the `[[tokens]]` of
//! a config file without editing it by hand.
//!
//! Edits go through `toml_edit`, so comments and formatting survive, and the
//! edited config is validated before it replaces the file. The plain token
//! is returned to the caller to print once; only its argon2 hash is written.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use toml_edit::{Array, ArrayOfTables, DocumentMut, Item, Table, Value, value};

use crate::auth::{hash_token, new_token};
use crate::config::Config;

/// A configured token, as `token list` shows it. Never its hash.
#[derive(Debug, PartialEq, Eq)]
pub struct TokenInfo {
    pub name: String,
    /// `None`: every vault.
    pub vaults: Option<Vec<String>>,
    /// The token can only read.
    pub read_only: bool,
    /// From `EMERALDMD_TOKEN_HASHES` rather than the config file.
    pub from_env: bool,
}

/// Tokens from the config file (if any) and the environment.
pub fn list(file: Option<&Path>, env: impl Fn(&str) -> Option<String>) -> Result<Vec<TokenInfo>, String> {
    let from_file = Config::read(file, |_| None).map_err(|e| e.to_string())?;
    let from_env = Config::read(None, env).map_err(|e| e.to_string())?;
    let info = |t: crate::config::TokenConfig, from_env| TokenInfo { name: t.name, vaults: t.vaults, read_only: t.read_only, from_env };
    Ok(from_file.tokens.into_iter().map(|t| info(t, false)).chain(from_env.tokens.into_iter().map(|t| info(t, true))).collect())
}

/// Creates a token named `name` for `vaults` (empty: every vault), adds its
/// hash to `file`, and returns the token.
pub fn add(file: &Path, name: &str, vaults: &[String], read_only: bool, env: impl Fn(&str) -> Option<String>) -> Result<String, String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-@".contains(c)) {
        return Err(format!("token name {name:?} may only contain letters, digits, '.', '_', '-' and '@' (at most 64)"));
    }
    let (file, text) = read(file)?;
    let current = parse(&text, &file, &env)?;
    if current.tokens.iter().any(|t| t.name == name) {
        return Err(format!("a token named {name:?} already exists; revoke it first or choose another name"));
    }
    let mut ids: Vec<&str> = Vec::new();
    for id in vaults {
        if !current.vaults.iter().any(|v| v.id == *id) {
            return Err(format!("unknown vault {id:?}; the configured vaults are: {}", vault_ids(&current)));
        }
        if !ids.contains(&id.as_str()) {
            ids.push(id);
        }
    }

    let token = new_token();
    let mut table = Table::new();
    table["name"] = value(name);
    table["hash"] = value(hash_token(&token));
    if !ids.is_empty() {
        table["vaults"] = value(Array::from_iter(ids));
    }
    if read_only {
        table["read_only"] = value(true);
    }
    let mut doc = document(&text, &file)?;
    match doc.get_mut("tokens") {
        None => {
            let mut tables = ArrayOfTables::new();
            tables.push(table);
            doc.insert("tokens", Item::ArrayOfTables(tables));
        }
        Some(Item::ArrayOfTables(tables)) => {
            // Right after the last token, wherever the tokens are in the file.
            if let Some(position) = tables.iter().filter_map(Table::position).max() {
                table.set_position(Some(position));
            }
            tables.push(table);
        }
        Some(Item::Value(Value::Array(inline))) => inline.push(table.into_inline_table()),
        Some(_) => return Err(format!("`tokens` in {} is not a list of tokens", file.display())),
    }
    save(&file, &doc.to_string(), &env)?;
    Ok(token)
}

/// Removes the token named `name` from `file`. Returns how many tokens are left.
pub fn revoke(file: &Path, name: &str, env: impl Fn(&str) -> Option<String>) -> Result<usize, String> {
    let (file, text) = read(file)?;
    let mut doc = document(&text, &file)?;
    let named = |t: Option<&Item>| t.and_then(Item::as_str) == Some(name);
    let removed = match doc.get_mut("tokens") {
        Some(Item::ArrayOfTables(tables)) => {
            let found = tables.iter().position(|t| named(t.get("name")));
            found.map(|i| tables.remove(i)).is_some()
        }
        Some(Item::Value(Value::Array(inline))) => {
            let found = inline.iter().position(|t| t.as_inline_table().and_then(|t| t.get("name")).and_then(Value::as_str) == Some(name));
            found.map(|i| inline.remove(i)).is_some()
        }
        _ => false,
    };
    if !removed {
        let env_tokens = Config::read(None, &env).map_err(|e| e.to_string())?.tokens;
        if env_tokens.iter().any(|t| t.name == name) {
            return Err(format!(
                "{name:?} comes from EMERALDMD_TOKEN_HASHES; remove its hash from that variable and restart the server"
            ));
        }
        return Err(format!("no token named {name:?} in {}", file.display()));
    }
    let text = doc.to_string();
    save(&file, &text, &env)?;
    Ok(parse(&text, &file, &env)?.tokens.len())
}

fn vault_ids(config: &Config) -> String {
    config.vaults.iter().map(|v| v.id.as_str()).collect::<Vec<_>>().join(", ")
}

/// The real file behind `path` (so a symlinked config stays a symlink), and its text.
fn read(path: &Path) -> Result<(PathBuf, String), String> {
    let real = fs::canonicalize(path).map_err(|e| format!("cannot open the config file {}: {e}", path.display()))?;
    let text = fs::read_to_string(&real).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok((real, text))
}

fn document(text: &str, file: &Path) -> Result<DocumentMut, String> {
    text.parse().map_err(|e| format!("invalid config file {}: {e}", file.display()))
}

fn parse(text: &str, file: &Path, env: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
    let mut config = Config::from_toml(text, file).map_err(|e| e.to_string())?;
    config.apply_env(env).map_err(|e| e.to_string())?;
    Ok(config)
}

/// Validates the new text as the server would load it, then replaces the
/// file: written next to it and renamed over it, keeping its permissions.
/// A file bind-mounted on its own (as Docker does with `-v file:file`)
/// cannot be replaced that way, so it is then rewritten in place.
fn save(file: &Path, text: &str, env: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    parse(text, file, env)?.validate_entries().map_err(|e| format!("the edited config would not load: {e}"))?;
    let dir = file.parent().unwrap_or(Path::new("."));
    let name = file.file_name().map_or_else(|| "config".into(), |n| n.to_string_lossy().into_owned());
    let temp = dir.join(format!(".{name}.{}.tmp", crate::auth::random_hex(6)));
    let replaced = (|| -> std::io::Result<()> {
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        out.set_permissions(fs::metadata(file)?.permissions())?;
        out.write_all(text.as_bytes())?;
        out.sync_all()?;
        fs::rename(&temp, file)
    })();
    if replaced.is_err() {
        let _ = fs::remove_file(&temp);
        fs::write(file, text).map_err(|e| format!("cannot write {}: {e}", file.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"# EmeraldMD server
bind = "127.0.0.1:8484"   # localhost only

# Devices
[[tokens]]
name = "laptop" # my laptop
hash = "$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo"

[[vaults]]
id = "notes"
path = "/srv/notes"

[[vaults]]
id = "work"
path = "/srv/work"
"#;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn config_file(text: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("emeraldmd-server.toml");
        fs::write(&file, text).unwrap();
        (dir, file)
    }

    #[test]
    fn add_can_make_a_read_only_token() {
        let (_dir, file) = config_file(CONFIG);
        add(&file, "reader", &[], true, no_env).unwrap();
        assert!(fs::read_to_string(&file).unwrap().contains("read_only = true"));
        let config = Config::load(Some(&file), no_env).unwrap();
        assert!(config.tokens.iter().find(|t| t.name == "reader").unwrap().read_only);
        assert!(list(Some(&file), no_env).unwrap().iter().any(|t| t.name == "reader" && t.read_only));
    }

    #[test]
    fn add_appends_a_hash_after_the_last_token_and_keeps_the_rest() {
        let (_dir, file) = config_file(CONFIG);
        let token = add(&file, "phone", &["work".into(), "work".into()], false, no_env).unwrap();
        assert!(token.starts_with("emd_"));
        let text = fs::read_to_string(&file).unwrap();
        assert!(!text.contains(&token), "only the hash is written");
        // Everything that was there is still there, comments included.
        let before_vaults = CONFIG.split("[[vaults]]").next().unwrap();
        assert!(text.starts_with(before_vaults), "{text}");
        assert!(text.ends_with(&CONFIG[CONFIG.find("[[vaults]]").unwrap()..]), "{text}");
        let phone = text.find("name = \"phone\"").unwrap();
        assert!(phone > text.find("name = \"laptop\"").unwrap() && phone < text.find("[[vaults]]").unwrap(), "{text}");

        let config = Config::load(Some(&file), no_env).unwrap();
        let added = &config.tokens[1];
        assert_eq!((added.name.as_str(), added.vaults.as_deref()), ("phone", Some(&["work".to_owned()][..])));
        use argon2::PasswordVerifier;
        let hash = argon2::password_hash::phc::PasswordHash::new(&added.hash).unwrap();
        assert!(argon2::Argon2::default().verify_password(token.as_bytes(), &hash).is_ok());
    }

    #[test]
    fn add_refuses_bad_names_duplicates_and_unknown_vaults() {
        let (_dir, file) = config_file(CONFIG);
        assert!(add(&file, "laptop", &[], false, no_env).unwrap_err().contains("already exists"));
        assert!(add(&file, "my phone", &[], false, no_env).is_err());
        assert!(add(&file, "", &[], false, no_env).is_err());
        assert!(add(&file, "phone", &["nope".into()], false, no_env).unwrap_err().contains("notes, work"));
        let env = |key: &str| (key == "EMERALDMD_TOKEN_HASHES").then(|| crate::auth::hash_token("x"));
        assert!(add(&file, "env-1", &[], false, env).unwrap_err().contains("already exists"));
        assert_eq!(fs::read_to_string(&file).unwrap(), CONFIG, "nothing written on errors");
        assert!(add(&file.with_extension("missing"), "phone", &[], false, no_env).is_err());
    }

    #[test]
    fn add_creates_the_first_token_and_handles_inline_lists() {
        let (_dir, file) = config_file("[[vaults]]\nid = \"notes\"\npath = \"/srv/notes\"\n");
        add(&file, "first", &[], false, no_env).unwrap();
        let config = Config::load(Some(&file), no_env).unwrap();
        assert_eq!(config.tokens[0].name, "first");
        assert_eq!(config.tokens[0].vaults, None);

        let (_dir, file) = config_file("tokens = []\n\n[[vaults]]\nid = \"notes\"\npath = \"/srv/notes\"\n");
        add(&file, "inline", &["notes".into()], false, no_env).unwrap();
        assert_eq!(Config::load(Some(&file), no_env).unwrap().tokens[0].name, "inline");
        assert!(fs::read_to_string(&file).unwrap().starts_with("tokens = [{"));
    }

    #[test]
    fn list_shows_names_and_scopes_never_hashes() {
        let (_dir, file) = config_file(CONFIG);
        add(&file, "phone", &["notes".into()], false, no_env).unwrap();
        let env = |key: &str| (key == "EMERALDMD_TOKEN_HASHES").then(|| crate::auth::hash_token("x"));
        let tokens = list(Some(&file), env).unwrap();
        assert_eq!(
            tokens,
            [
                TokenInfo { name: "laptop".into(), vaults: None, read_only: false, from_env: false },
                TokenInfo { name: "phone".into(), vaults: Some(vec!["notes".into()]), read_only: false, from_env: false },
                TokenInfo { name: "env-1".into(), vaults: None, read_only: false, from_env: true },
            ]
        );
    }

    #[test]
    fn revoke_removes_one_token_and_keeps_the_rest() {
        let (_dir, file) = config_file(CONFIG);
        add(&file, "phone", &[], false, no_env).unwrap();
        assert_eq!(revoke(&file, "phone", no_env).unwrap(), 1);
        assert_eq!(fs::read_to_string(&file).unwrap(), CONFIG, "back to the original text");
        assert!(revoke(&file, "phone", no_env).unwrap_err().contains("no token named"));
        let env = |key: &str| (key == "EMERALDMD_TOKEN_HASHES").then(|| crate::auth::hash_token("x"));
        assert!(revoke(&file, "env-1", env).unwrap_err().contains("EMERALDMD_TOKEN_HASHES"));
        // The last token can go: a reload then locks everyone out.
        assert_eq!(revoke(&file, "laptop", no_env).unwrap(), 0);
        assert!(Config::read(Some(&file), no_env).unwrap().tokens.is_empty());
        assert!(fs::read_to_string(&file).unwrap().contains("# EmeraldMD server"));
    }

    #[cfg(unix)]
    #[test]
    fn edits_keep_the_file_mode_and_symlinks() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let (dir, file) = config_file(CONFIG);
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        let link = dir.path().join("link.toml");
        symlink(&file, &link).unwrap();
        add(&link, "phone", &[], false, no_env).unwrap();
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(fs::read_to_string(&file).unwrap().contains("phone"));
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).collect();
        assert!(leftovers.is_empty());
    }
}
