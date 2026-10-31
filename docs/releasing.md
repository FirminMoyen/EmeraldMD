# Releasing

1. Set the version in `Cargo.toml` (`[workspace.package] version`),
   `apps/desktop/src-tauri/tauri.conf.json` and `apps/desktop/package.json`.
   They must match.
2. Commit, then tag and push:

   ```bash
   git tag v0.2.0
   ```

   ```bash
   git push origin v0.2.0
   ```

3. The **Release** workflow (`.github/workflows/release.yml`) builds:

   | Platform | Files |
   |---|---|
   | macOS (one universal build for Apple silicon and Intel) | `.dmg`, `.app.tar.gz` |
   | Windows x64 | `.msi`, `-setup.exe` (NSIS) |
   | Linux x64 | `.AppImage`, `.deb`, `.rpm` |
   | Server | `ghcr.io/<owner>/emeraldmd-server:<version>` for amd64 and arm64 |

   and attaches the installers to a **draft** GitHub release.
4. Check the draft, then publish it.

You can also run the workflow by hand (Actions → Release → Run workflow). The
installers then land in the run's artifacts, and no release is created or
image pushed.

## Code signing (not set up yet)

Unsigned builds work, but macOS Gatekeeper and Windows SmartScreen warn on
first launch. Signing needs accounts and certificates that the project owner
has to create:

- **macOS:** an Apple Developer account (paid). With a Developer ID
  Application certificate and an app-specific password, add the
  `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`,
  `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` repository secrets, and pass
  them as env to `tauri-action`. Tauri then signs and notarizes. Signed
  builds run with the hardened runtime, which blocks the microphone unless
  the app has the `com.apple.security.device.audio-input` entitlement: add an
  entitlements file with it (`bundle.macOS.entitlements` in
  `tauri.conf.json`) so the Audio recorder keeps working. The usage text
  macOS shows is already in `src-tauri/Info.plist`.
- **Windows:** a code-signing certificate (OV/EV, or Azure Trusted Signing),
  configured in `tauri.conf.json` under `bundle.windows`.
- **Auto-update:** generate an updater key pair (`npx tauri signer generate`),
  store the private key as a secret, and enable `uploadUpdaterJson`.

iOS and Android builds also need an Apple Developer account and a Google Play
developer account. See the roadmap (phase 4).
