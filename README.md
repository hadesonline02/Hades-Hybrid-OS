# HADES Hybrid OS

## Legal Notice

This project is released under the MIT License, but that license does not waive responsibility for how third-party services are used. If you use this software in ways that violate the Terms of Service of OpenAI, Spotify, Google, Deepgram, or any other provider, all resulting risk and liability remain with the user.

This repository is shared for educational, research, and proof-of-concept purposes. The author is not responsible for account restrictions, data loss, service bans, or legal consequences caused by usage of this project.

## Overview

HADES is an experimental local desktop shell that extends a browser-based AI session with a local orchestration layer. Conversation and decision flow stay close to the browser session, while wake word handling, reminders, alarms, desktop controls, and provider integrations are managed locally for lower latency and better control.

This public repository is a sanitized source snapshot. Secrets, user profiles, cached tokens, and bundled browser/runtime data are intentionally excluded.

## Architecture

HADES is organized into three main layers:

- Launcher: starts the desktop shell and prepares an isolated runtime session.
- Bridge extension: injects the HADES UI, observes the browser session, and forwards tool actions to the local backend.
- Core backend: manages scheduling, provider adapters, voice orchestration, and local APIs.

Important files:

- `app/dev-electron-launcher.js`
- `app/electron-main.js`
- `app/chatgpt-bridge-extension/content-script.js`
- `app/chatgpt-bridge-extension/service-worker.js`
- `server.js`

## Features

- Wake word pipeline for hands-free interaction
- Local alarm and reminder scheduling
- Spotify and Tuya integration hooks
- Desktop overlay, ambient UI, and operations cockpit
- Browser-to-local tool bridge for hybrid assistant workflows

## Repository Safety

The following items are intentionally not included in this public-safe copy:

- Real `.env` files
- OAuth/session token files such as `spotify-token.json`
- Browser profile data such as `UserData/`
- Bundled Chromium binaries
- Local virtual environments, caches, and temporary assets

## Requirements

Primary target:

- Windows
- Node.js 20+
- npm

Optional voice/runtime extras:

- Python 3.11+ recommended
- Google credentials for cloud speech workflows
- Deepgram API key for command transcription
- Spotify developer credentials
- Tuya device credentials

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/hadesonline02/Hades-Hybrid-OS.git
cd Hades-Hybrid-OS
```

### 2. Install Node.js dependencies

```bash
npm install
```

### 3. Install optional Python dependencies

If you want to use the Python-based voice helpers:

```bash
pip install -r requirements.txt
```

### 4. Create your environment file

Copy `.env.example` to `.env` and fill in the values you actually use.

Example:

```env
OPENAI_API_KEY=
DEEPGRAM_API_KEY=
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
TUYA_DEVICE_ID=
TUYA_DEVICE_KEY=
GOOGLE_APPLICATION_CREDENTIALS=
```

## Running The Project

Start the desktop shell:

```bash
npm start
```

Start only the backend:

```bash
npm run start:server
```

Start the static UI only:

```bash
npm run start:ui
```

On Windows you can also use:

```bat
start.bat
```

## Testing

```bash
npm test
```

## Packaging

```bash
npm run dist:win
```

## Notes

- This repository keeps the integration code, but removes real secrets and local runtime data.
- Some voice features depend on external credentials and local audio device setup.
- This is an unofficial experimental project and is not affiliated with OpenAI, Spotify, Google, Deepgram, or Tuya.

## License

MIT License. See `LICENSE` for details.

Copyright (c) 2026 Eray Dalbudak.
