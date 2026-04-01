# Hades-Hybrid-OS

> The HADES Layer: Transforming ChatGPT into a native desktop OS. Hybrid web-local bridge with high-fidelity voice, IoT automation, and custom HUD.

HADES is an experimental local desktop shell that extends a browser-based AI session with a local orchestration layer. The project keeps decision-making and conversation in the web session, while wake word handling, reminders, alarms, and voice pipeline management run locally.

This repository is prepared as a public-safe source snapshot. It intentionally excludes secrets, runtime user profiles, cached tokens, and bundled browser binaries.

## Overview

HADES combines three layers:

- `Launcher`: starts an isolated desktop shell and loads the runtime extension
- `Bridge Extension`: connects the page, the local runtime, and the backend
- `Local Backend`: handles reminders, alarms, provider adapters, and device integrations

## Architecture

### 1. HADES Launcher

The launcher opens an isolated desktop session and prepares a clean runtime extension copy for each run.

Key files:

- `app/dev-electron-launcher.js`
- `app/chatgpt-shell-config.js`

### 2. HADES Bridge

The extension injects the HADES panel, manages wake-word flow, observes the page, and forwards tool requests to the local backend.

Key files:

- `app/chatgpt-bridge-extension/content-script.js`
- `app/chatgpt-bridge-extension/service-worker.js`
- `app/chatgpt-bridge-extension/wake-bridge.js`
- `app/chatgpt-bridge-extension/theme-start.js`

### 3. HADES Core

The backend provides local scheduling, provider adapters, and runtime endpoints used by the extension.

Key file:

- `server.js`

## Features

- Wake word flow with low-cost browser speech detection and higher-accuracy command transcription
- Local reminders and alarms independent from built-in chat task systems
- Bridge-driven local tool execution
- Desktop HUD and session panel
- Custom HADES branding and UI shell
- Optional provider integrations for Spotify, Tuya, Deepgram, and OpenAI

## Compliance and Risk Notice

This project is unofficial and experimental.

It is **not affiliated with, endorsed by, or sponsored by** OpenAI, Spotify, Deepgram, Google, Chromium, or any other third-party provider referenced by the codebase.

Users are solely responsible for ensuring their setup and usage comply with:

- applicable laws and regulations
- the terms and policies of any third-party service they connect
- local privacy, device, and network rules in their environment

Relevant policy pages to review before use:

- OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
- OpenAI Brand Guidelines: https://openai.com/brand/
- Spotify Developer Policy: https://developer.spotify.com/policy
- Deepgram Authentication Docs: https://developers.deepgram.com/docs/authenticating

If you are unsure whether a specific integration is permitted for your use case, do not use it with a primary account or sensitive environment until you have reviewed the applicable policies yourself.

## Disclaimer

This software is provided **"as is"**, without warranty of any kind.

The maintainers do not guarantee:

- continued compatibility with third-party services
- account safety or service availability
- policy compliance for your specific usage
- uninterrupted operation or suitability for production

By using this project, you accept full responsibility for your environment, credentials, connected services, and any outcomes resulting from usage.

## What Is Included

- application source
- bridge extension source
- backend source
- tests
- environment template

## What Is Not Included

- personal API keys
- user session data
- browser profile data
- cached runtime tokens
- local screenshots and debug artifacts
- bundled Chromium binaries

## Requirements

- Windows
- Node.js 20+ recommended
- npm

Optional integrations:

- Deepgram API key for command transcription
- Spotify developer credentials for Spotify integration
- Tuya device credentials for IoT control
- OpenAI API key if you use the backend OpenAI proxy features

## Installation

1. Clone the repository.

```powershell
git clone <YOUR_REPO_URL>
cd Hades-Hybrid-OS
```

2. Install dependencies.

```powershell
npm install
```

3. Create your local environment file.

```powershell
Copy-Item .env.example .env
```

4. Open `.env` and fill in only the providers you want to use.

Minimum practical setup for voice command flow:

- `DEEPGRAM_API_KEY`

Optional values:

- `SPOTIFY_CLIENT_ID`
- `SPOTIFY_CLIENT_SECRET`
- `SPOTIFY_REDIRECT_URI`
- `TUYA_DEVICE_ID`
- `TUYA_DEVICE_KEY`
- `TUYA_DEVICE_IP`
- `TUYA_DEVICE_VERSION`
- `OPENAI_API_KEY`

5. Start the project.

```powershell
npm run start
```

The launcher will use a local Chromium build if one exists under `./chromium`. If no bundled Chromium is present, it falls back to the Electron runtime installed with the project.

## First-Run Notes

To get the project working reliably on a fresh machine, expect the following:

- you must sign into your own ChatGPT account on first launch
- microphone permission must be allowed for the desktop shell
- the wake-word flow depends on browser speech recognition plus a valid `DEEPGRAM_API_KEY`
- Spotify features require your own Spotify developer credentials and an active Spotify device
- Tuya features require your own Tuya device credentials and reachable local device IP

The public repository does **not** contain the original author profile, cached sessions, provider tokens, or browser data. That means the first launch will not look exactly like the author environment until you complete your own login and provider setup.

## Closest Match to the Author Setup

If you want behavior as close as possible to the author setup, use this checklist:

1. Run on Windows.
2. Install dependencies with `npm install`.
3. Create `.env` from `.env.example`.
4. Add at minimum `DEEPGRAM_API_KEY`.
5. Add optional provider keys for Spotify, Tuya, and OpenAI only if you plan to use those features.
6. Prefer a local Chromium build under `./chromium` for the closest shell behavior.
7. Start the app with `npm run start`.
8. Sign into ChatGPT in the opened shell window.
9. Grant microphone permission when prompted.
10. Verify that the HADES bridge panel appears and the backend reports healthy status.

If `./chromium` is missing, the project falls back to Electron. That is supported, but the behavior may not be identical to the author's exact setup.

## Feature Requirements

- Wake word + command voice flow: `DEEPGRAM_API_KEY`, microphone access, browser speech recognition support
- Alarm and reminders: no external provider required, runs locally
- Spotify: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, and an open Spotify device
- Tuya: `TUYA_DEVICE_ID`, `TUYA_DEVICE_KEY`, `TUYA_DEVICE_IP`, `TUYA_DEVICE_VERSION`
- Backend OpenAI proxy features: `OPENAI_API_KEY`

## Development Commands

Start desktop shell:

```powershell
npm run start
```

Start backend only:

```powershell
npm run start:server
```

Run tests:

```powershell
npm test
```

## Project Structure

```text
app/
  chatgpt-bridge-extension/
  chatgpt-shell-config.js
  dev-electron-launcher.js
src/
tests/
server.js
.env.example
package.json
```

## Publishing Notes

Before pushing changes, make sure the following never enter version control:

- `.env`
- `spotify-token.json`
- `UserData/`
- `chromium/`
- screenshots, debug dumps, and local caches

This repository snapshot already includes a `.gitignore` for those paths.
