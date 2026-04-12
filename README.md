# Glenda BH

Apartment management and utility billing system for Glenda Residences.

## Overview

The primary product surface is the webapp in [admin-webapp/](admin-webapp/), which provides the main operator workflow for tenant management, meter readings, billing, and reminders. The Telegram bot in this repository serves as a secondary support channel for operational tasks and webhook-driven automation.

Both services share the same tenant, reading, billing, and reminder data model. In production, the system uses PostgreSQL through `DATABASE_URL`. For local development, SQLite remains available as a fallback where supported by the service.

## Services

### Primary Service: Admin Webapp

- React admin dashboard with an Express API
- Tenant registration and updates
- Meter reading entry and bill generation
- Payment tracking and reminder workflows
- SMS reminders through httpSMS

### Secondary Service: Telegram Bot

- Receives Telegram webhook updates
- Supports command-based billing and tenant operations
- Generates and serves PDF bills
- Provides a backup interface for on-demand administration

## Repository Layout

- `admin-webapp/` - main React + Express service
- `src/` - Telegram bot service and shared data access layer
- `data/` - local database artifacts and seeded data, if used
- `docs/` - design and product notes

## Tech Stack

- Node.js
- React
- Express
- PostgreSQL via `pg`
- SQLite via `sqlite3`
- PDF generation via `pdfkit`
- Railway for deployment

## Environment Variables

Create a `.env` file from the relevant service example file and set the variables below.

### Shared / Database

- `DATABASE_URL` - production PostgreSQL connection string

### Telegram Bot

- `PORT` - optional locally; Railway sets this automatically
- `TELEGRAM_BOT_TOKEN` - Telegram bot token
- `TELEGRAM_WEBHOOK_SECRET` - secret token used to validate webhook requests
- `OWNER_TELEGRAM_ID` - Telegram ID allowed to use admin commands
- `BOT_URL` - public base URL used in bill links and reminders
- `HTTPSMS_API_KEY` - httpSMS API key for reminder delivery
- `HTTPSMS_FROM_NUMBER` - verified sender number for SMS reminders

### Admin Webapp

- `PORT` - service port, defaulting to `8787` in the webapp
- `JWT_SECRET` - admin session signing secret
- `ADMIN_EMAIL` - admin login email
- `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH` - admin credential source
- `HTTPSMS_API_KEY` - SMS reminder integration
- `HTTPSMS_FROM_NUMBER` - sender number for SMS reminders
- `BOT_URL` - used to build bill links in reminder messages

## Local Development

Install dependencies for the service you want to run, then start it from that service directory.

### Telegram Bot

```bash
npm install
npm start
```

### Admin Webapp

```bash
cd admin-webapp
npm install
npm run dev
```

For a production-style local run of the webapp:

```bash
cd admin-webapp
npm run build
npm start
```

## Deployment

### Webapp

Deploy `admin-webapp/` as the primary Railway service. Point it at the shared `DATABASE_URL` and configure the webapp environment variables listed above.

### Telegram Bot

Deploy the root service as a secondary Railway service. Configure the Telegram and SMS environment variables listed above.

### Telegram Webhook

After deployment, set the webhook to the bot service URL:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-domain>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

To verify the configured webhook:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo
```

## Data Model

- `rooms` - tenant profile, room rate, and current meter baselines
- `readings` - historical meter snapshots
- `bills` - generated billing records and payment state
- `sms_logs` - SMS reminder delivery history and provider responses

Schema migrations run on startup for both PostgreSQL and SQLite. They include support for room contact details, move-in dates, room rates, and bill payment tracking.

## Billing Rules

- Electricity cost is based on usage since the previous baseline reading.
- Water cost is either fixed or usage-based, depending on the configured room rate mode.
- Total bill amount includes room rent, electricity cost, and water cost.

## PDF Output

Generated PDF bills are stored under `public/` and served through the bot service. If `public/logo.jpg` exists, it is rendered at the top of each bill.

## Security

- Owner-only Telegram commands are gated by `OWNER_TELEGRAM_ID`.
- The webhook validates the Telegram secret token when configured.
- Bill file requests are sanitized before files are served.

## Additional Notes

- Railway filesystem storage is ephemeral, so SQLite data will not survive redeploys.
- Production should use `DATABASE_URL` for persistent storage.
- Service-specific setup details are documented in [admin-webapp/README.md](admin-webapp/README.md).
