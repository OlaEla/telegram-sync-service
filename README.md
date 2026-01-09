# Telegram Sync Service

Production-ready Node.js service for synchronizing Telegram channel posts into a MySQL database with media upload via SFTP.

This service is designed as a **standalone microservice** and is part of a larger content platform.  
It runs on a schedule (cron) or can be triggered manually via API.

---

## Features

- Sync posts from a Telegram channel using **Telegram Bot API**
- Save posts to **MySQL**
- Upload images and video thumbnails via **SFTP**
- Configurable **cron-based synchronization**
- Manual sync endpoint with token protection
- Forwarded posts filtering (configurable via `.env`)
- Idempotent updates using `update_id`
- Production-safe architecture (no serverless dependencies)

---

## 🧱 Architecture

```
telegram-sync-service/
├── src/
│ ├── index.ts # Express server & cron scheduler
│ └── sync.ts # Telegram sync logic
├── dist/ # Compiled JS (after build)
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

---

## Tech Stack

- Node.js 20+
- TypeScript
- Express
- MySQL (mysql2)
- node-cron
- Telegram Bot API
- SFTP (ssh2-sftp-client)

---

## ⚙️ Environment Variables

All configuration is done via environment variables.  
`.env` **must not** be committed to Git.

### Core

```env
PORT=3000
SECRET_TOKEN=your-secure-random-token
SYNC_INTERVAL=0 12,23 * * *
```

### Telegram

```env
TELEGRAM_BOT_TOKEN=xxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=-100xxxxxxxxxx
TELEGRAM_CHANNEL=
TELEGRAM_CHANNEL_AVATAR=
TELEGRAM_SKIP_HASHTAG=
```

### Database

```env
DB_HOST=localhost
DB_USER=user
DB_PASSWORD=password
DB_NAME=database_name
```

### SFTP (media upload)

```env
SFTP_HOST=example.com
SFTP_PORT=22
SFTP_USER=username
SFTP_PASSWORD=password
PUBLIC_IMAGE_BASE_URL=https://example.com/uploads/telegram/images
```

### Forwarded posts control

```env
ALLOW_FORWARDED_POSTS=true
ALLOWED_FORWARD_CHANNEL_IDS=
```

## Running Locally

Install dependencies:

```
npm install
```

Run in development mode:

```
npm run dev
```

Build for production:

```
npm run build
```

Run production build:

```
npm start
```

## 🔁 Synchronization Logic

- The service uses getUpdates with offset tracking

- last_update_id is stored in the database

- Posts are processed exactly once

- Forwarded posts can be:

  - completely disabled

  - or allowed only from specific channels

## Manual Sync Endpoint

Protected endpoint for manual sync trigger:

```bash
POST /sync
```

```json
{
  "token": "SECRET_TOKEN"
}
```

Returns:

```json
{
  "success": true,
  "synced": 2
}
```

## 🩺 Health Check

```bash
GET /
```

Response:

```json
{
  "service": "Telegram Sync Service",
  "status": "running"
}
```

## ☁️ Deployment

The service is designed to run as a long-lived process.

Tested deployment target:

- Render (Web Service)

Build command:

```
npm install && npm run build
```

Start command:

```
npm start
```

## Notes

- No secrets are stored in the repository

- No Telegram user data is collected

- The service is intentionally decoupled from frontend logic

- Designed for maintainability and observability
