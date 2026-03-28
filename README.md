# Glenda BH Telegram Bot

Telegram bot for apartment management at Glenda Residences.

## Overview

This service receives Telegram webhook updates and runs on Railway.

## Tech Stack

- Node.js (built-in `http` server)
- Railway (hosting)

## Environment Variables

Create a `.env` file from `.env.example` and set:

- `PORT` (optional locally, Railway provides this automatically)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OWNER_TELEGRAM_ID`

## Endpoints

- `GET /`
  - Basic service status.

- `GET /health`
  - Health check endpoint.

- `POST /telegram/webhook`
  - Receives Telegram updates.

## Local Run

1. Start the server:
   - `npm start`

Default local URL:

- `http://localhost:3000`

## Railway Deployment

1. Push this repository to GitHub.
2. Connect the repository in Railway.
3. Add environment variables in Railway:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
4. Deploy.

## Set Telegram Webhook

After deploy, run this in a browser or terminal (replace placeholders):

`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-railway-domain>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`

Optional verification:

`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo`

## Current Bot Behavior

- `/start` replies with online status
- `/ping` replies with `pong`
- Other text messages are echoed back
