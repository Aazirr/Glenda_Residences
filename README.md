# Glenda BH Messenger Bot

Messenger bot for apartment management at Glenda Residences.

## Overview

This service receives Meta webhook events for a Facebook Page and is deployed on Railway.

## Tech Stack

- Node.js (built-in `http` server)
- Railway (hosting)

## Environment Variables

Create a `.env` file from `.env.example` and set:

- `PORT` (optional for local use, Railway provides this automatically)
- `VERIFY_TOKEN`
- `PAGE_ACCESS_TOKEN`
- `APP_SECRET`
- `OWNER_PSID`

## Available Endpoints

- `GET /health`
	- Returns service status JSON.

- `GET /webhook`
	- Handles Meta webhook verification.
	- Requires `hub.mode`, `hub.verify_token`, and `hub.challenge` query parameters.

- `POST /webhook`
	- Receives webhook event payloads.
	- Responds with `EVENT_RECEIVED`.

## Local Run

1. Install dependencies (if any are added later):
	 - `npm install`
2. Start server:
	 - `npm start`

Default local URL:

- `http://localhost:3000`

## Deployment

The project is deployed on Railway from GitHub.

Callback URL format for Meta Webhooks:

- `https://<your-railway-domain>/webhook`

## Current Development Focus

- Webhook connectivity and event handling
- Owner-only command flow (next)
- Tenant data capture and billing workflow (next phases)
