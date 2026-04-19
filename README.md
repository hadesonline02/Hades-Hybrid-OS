⚠️ KRİTİK GÜVENLİK VE HUKUKİ UYARI (LEGAL NOTICE)
[!IMPORTANT]
TR: Bu proje MIT Lisansı ile korunmaktadır. Ancak bu lisans, yazılımın kullanımı sırasında üçüncü taraf hizmet sağlayıcılarının (OpenAI, Spotify, Google vb.) kullanım koşullarını (ToS) ihlal etmeniz durumunda doğacak sorumlulukları kapsamaz. HADES Shell kullanımı nedeniyle oluşabilecek hesap askıya alınması, kalıcı banlanma veya veri kaybı gibi durumların tüm riski ve sorumluluğu tamamen kullanıcıya aittir. Geliştirici (Eray Dalbudak) hiçbir sorumluluk kabul etmez. Yazılım tamamen eğitim ve Proof-of-Concept (PoC) amaçlıdır.

EN: This project is protected by the MIT License. This software is intended for educational and research purposes only. The user acknowledges that using this tool may violate the Terms of Service of third-party platforms (e.g., OpenAI). The author is not responsible for any account suspensions, data loss, or legal consequences arising from the use of this software. Copyright (c) 2026 Eray Dalbudak.

🧐 Overview
HADES is an experimental local desktop shell that extends a browser-based AI session with a local orchestration layer. The project keeps decision-making and conversation in the web session, while wake word handling, reminders, alarms, and voice pipeline management run locally to ensure reliability and low latency.

This repository is prepared as a public-safe source snapshot. It intentionally excludes secrets, runtime user profiles, cached tokens, and bundled browser binaries.

🏗️ Architecture
HADES combines three distinct layers:

HADES Launcher: Starts an isolated desktop session and prepares a clean runtime extension copy for each run.

Key files: app/dev-electron-launcher.js, app/chatgpt-shell-config.js

HADES Bridge (Extension): Injects the HADES panel, manages wake-word flow, observes the page DOM, and forwards tool requests to the local backend.

Key files: content-script.js, service-worker.js, wake-bridge.js, theme-start.js

HADES Core (Backend): Handles local scheduling, provider adapters (Spotify, Tuya), and runtime endpoints.

Key file: server.js

✨ Features
Smart Wake Word: Low-cost browser speech detection + Deepgram high-accuracy command transcription.

Local Intent Engine: Intercepts commands like "Set alarm" or "Turn off lights" locally to minimize OpenAI traffic and latency.

Independent Scheduler: Alarms and reminders run on the local HADES engine, independent of ChatGPT's internal task system.

Desktop HUD: Custom HADES branding, UI shell, and session panel overlay.

IoT & Media: Native integration for Spotify and Tuya (Smart Home) devices.

🛡️ Compliance and Risk Notice
This project is unofficial and experimental. It is not affiliated with, endorsed by, or sponsored by OpenAI, Spotify, Deepgram, Google, or any third-party provider.

Users are solely responsible for reviewing:

OpenAI Terms of Use

Spotify Developer Policy

Deepgram Documentation

🛠️ Installation & Setup
Requirements
Windows (Primary Target)

Node.js 20+

Optional: Deepgram API Key (Required for voice commands), Spotify Dev Credentials, Tuya Device Keys.

Steps
Clone & Install:

Bash
git clone <YOUR_REPO_URL>
cd Hades-Hybrid-OS
npm install
Environment Setup:
Create a .env file from .env.example and fill in your keys:

Kod snippet'i
DEEPGRAM_API_KEY=your_key_here
# Optional
SPOTIFY_CLIENT_ID=...
TUYA_DEVICE_IP=...
Launch:

Bash
npm run start
📜 License
This project is licensed under the MIT License. See the LICENSE file for details.

Copyright (c) 2026 Eray Dalbudak.

Generated for the HADES Project - Research & Development Layer.
