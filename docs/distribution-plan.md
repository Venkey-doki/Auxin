# Distribution plan

How Auxin goes public: where the code, website and downloads live, how a release is
built, and what has to happen before the repo is opened. Settled 2026-10-26.

## Decisions

| Question | Decision |
|---|---|
| Code | Open source, one public GitHub repo. |
| Price | Free. No accounts, licence keys or checkout. |
| Platforms | macOS, Windows and Linux from the first release. |
| Website | In this repo under `website/` (Astro + Starlight), deployed by Vercel on the free `*.vercel.app` address. No domain for now. |
| Downloads | GitHub Releases, built by CI. Never committed, never hosted on Vercel. |
| macOS signing | No Apple Developer account. Builds are ad-hoc signed; the site explains the one-time "Open Anyway" step and offers a terminal install that avoids it. |
| Windows signing | Unsigned at first (SmartScreen shows "Run anyway"). Apply to SignPath Foundation for free open-source signing later. |
| User data | Stays on the user's machine. Auxin makes no network calls of its own. |
| Flow schema | Shipped inside each project (`.auxin/schema/`), not hosted anywhere. |
| Updates | No automatic update checks in the first release. Possibly an opt-in check later. |

## Where things live

```
auxin/
  src/, src-tauri/      the app
  docs/                 engineering specs (flows-spec.md, map.md, this file)
  website/              landing page, download page, user guide, changelog
  .github/workflows/
    ci.yml              tests on every PR (tsc, vitest, cargo test, clippy)
    release.yml         builds all platforms on a v* tag, publishes a GitHub Release
```

`docs/` stays for people working on Auxin. The user guide in `website/` is for people
using it: shorter, task-based, with screenshots.

Vercel builds only `website/` (project Root Directory), skips deployments when nothing
in `website/` changed, and gives each PR a preview link. Previews for PRs from forks
need approving by hand; that's Vercel's protection, not a problem.

## Data on the user's machine

Nothing Auxin stores leaves the computer:

- In the project, under `.auxin/`: flows, environments, secrets (`*.secret.json`, gitignored), run history, the map (`topology.json`, `runs/observed.json`), and the flow schema.
- In the app's own folders: workspace settings (app config folder) and large response bodies (app cache folder).
- In memory only: OpenTelemetry spans, cleared when the app quits.

The landing page should say this plainly: Auxin never phones home.

## Flow schema, local

Today every flow file carries `"$schema": "https://auxin.dev/schema/flow-2.json"`
(`src/flows/model.ts`). Auxin never fetches it, no such file exists, and we don't own
the domain. Only editors use `$schema`, for autocomplete when a flow file is edited by
hand.

Change:

- Write a JSON Schema for flow files (`flow-2.json`) and keep it in the app's source.
- When Auxin writes to a project's `.auxin/`, it also writes `.auxin/schema/flow-2.json`, rewriting it only if its content differs (so a newer Auxin updates it).
- Flow files point at it relatively: `"$schema": "../schema/flow-2.json"`. VS Code and other editors resolve relative paths, so autocomplete works offline.
- Existing files migrate on their own: Auxin ignores `$schema` when reading and rewrites it on every save.
- Update `docs/flows-spec.md` §2.1.

## Release pipeline

On a pushed tag `v*`, `release.yml` runs `tauri-action` on GitHub's runners (free for
public repos):

| Platform | Runner | Files |
|---|---|---|
| macOS | `macos-latest` | `.dmg` for Apple Silicon and for Intel (or one universal `.dmg`), ad-hoc signed (`signingIdentity: "-"`) |
| Windows | `windows-latest` | `.exe` (NSIS) and `.msi` |
| Linux | `ubuntu-22.04` | `.AppImage`, `.deb`, `.rpm` |

It creates a draft GitHub Release with the files and the changelog entry; publishing it
is a manual check. The website links to GitHub's stable
`releases/latest/download/<file>` URLs, so it doesn't need rebuilding per release.
File names must therefore not contain the version (set them in the workflow).

The version lives in `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and
`package.json`; bump all three before tagging.

## Installing without the warnings

- **macOS, from the site:** download the `.dmg`, drag to Applications, open once. macOS refuses; open System Settings → Privacy & Security → Open Anyway. The install page shows this with screenshots, plus the fallback `xattr -dr com.apple.quarantine /Applications/Auxin.app`.
- **macOS and Linux, from a terminal:** `curl -fsSL https://<name>.vercel.app/install.sh | sh`. The script is a static file on the site; it detects the OS and CPU, downloads the right file from GitHub Releases and installs it. Files fetched by `curl` aren't quarantined, so the app opens without the prompt. Its source is in the repo so people can read it first.
- **Homebrew:** a tap of our own (`brew install <user>/tap/auxin`), updated by the release workflow. The main Homebrew cask repo is not an option for an unsigned app.
- **Windows:** run the installer; on SmartScreen, More info → Run anyway, until signing is in place.
- **Linux:** AppImage (make executable, run), or `.deb` / `.rpm` with the system package tool.

## Updates

None automatic in the first release: the user downloads a new version from the site,
and the changelog says what changed. If an update check is added later it is a setting,
off by default, that only asks GitHub for the latest version number and links to the
download page. Tauri's self-updater (which needs a signing key and a `latest.json` on
GitHub Releases) can come after that, also opt-in.

## Website

Pages:

1. **Home:** what Auxin is, a screenshot or short video, "runs on your machine, no account, no cloud", the download button for the visitor's OS.
2. **Download:** every platform's files, the terminal install, Homebrew, and links to the install guides.
3. **Install guides:** one per OS, including the first-launch security steps.
4. **User guide:** open a workspace → start services and groups → logs → environments and secrets → your first flow (requests, variables, checks, if and parallel blocks, queue steps) → run history, trends and replay → the Map → OpenTelemetry → troubleshooting and FAQ.
5. **Changelog:** from `CHANGELOG.md`.
6. **Contributing:** links to the repo, `CONTRIBUTING.md`, how to report a security issue.

## Before the repo goes public

- [ ] Pick a licence (MIT, Apache-2.0, or both, as is common for Rust and Tauri projects) and add `LICENSE`.
- [ ] `README.md` with a screenshot, what it does, install links, how to build from source.
- [ ] `CONTRIBUTING.md`, `SECURITY.md` (Auxin runs commands and handles secrets, so say how to report a vulnerability privately), `CODE_OF_CONDUCT.md`, issue and PR templates, `CHANGELOG.md`.
- [ ] Scan the whole git history for secrets (gitleaks) and fix anything found before publishing.
- [ ] Change the bundle identifier `com.auxin.app` (`src-tauri/tauri.conf.json`). Tauri warns against identifiers ending in `.app`, and changing it after release moves where the app keeps its settings, so users would lose them. Something like `io.github.<user>.auxin`.
- [ ] Check the name: search for other developer tools called Auxin.
- [ ] Choose the Vercel project name; it becomes the site address and the install-script URL, so treat it as permanent.

## Order of work

Each step is one commit, reviewed before the next.

1. Local flow schema.
2. Bundle identifier change.
3. `ci.yml`: tests on every PR.
4. `release.yml`: builds for all platforms, draft GitHub Release; tried with a pre-release tag.
5. `website/` skeleton: home, download page, install guides; connected to Vercel.
6. User guide content and screenshots.
7. `install.sh` and the Homebrew tap.
8. Open-source files and the history scan; then make the repo public and publish v0.1.0.

Later: SignPath signing for Windows, an opt-in update check, winget and Flathub.

## Open decisions

- Licence.
- Vercel project name (the permanent address).
- macOS: one universal `.dmg` (bigger download, one button) or separate Apple Silicon and Intel files.
- The new bundle identifier.
