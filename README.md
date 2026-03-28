# Glenda BH Telegram Bot

Telegram bot for apartment management and utility billing at Glenda Residences.

## Overview

This service receives Telegram webhook updates, stores tenant and billing data in SQLite, generates PDF bills, and runs on Railway.

## Tech Stack

- Node.js (built-in `http` server)
- SQLite (`sqlite3`)
- PDF generation (`pdfkit`)
- Railway (hosting)

## Environment Variables

Create a `.env` file from `.env.example` and set:

- `PORT` (optional locally, Railway provides this automatically)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `OWNER_TELEGRAM_ID` (Telegram ID allowed to use admin commands)
- `BOT_URL` (optional but recommended, public base URL used in PDF links)

Example:

```env
PORT=3000
TELEGRAM_BOT_TOKEN=replace_me
TELEGRAM_WEBHOOK_SECRET=replace_me
OWNER_TELEGRAM_ID=6977978829
BOT_URL=https://glenda-residences-production.up.railway.app
```

## Endpoints

- `GET /`
  - Basic service status.
- `GET /health`
  - Health check endpoint.
- `POST /telegram/webhook`
  - Receives Telegram updates.
- `GET /bills/:filename`
  - Serves generated PDF bills.

## Commands

- `/start`
  - Shows bot status and available commands.
- `/registertenant`
  - Multi-step tenant registration flow.
  - Captures: tenant name, room number, contact number, move-in date, electricity rate, current electricity reading, water rate, current water reading.
- `/inputreading`
  - Multi-step meter input flow.
  - Captures: room number, new electricity reading, new water reading.
  - Computes costs and total bill.
  - Sends bill summary plus clickable PDF link.
- `/viewbill`
  - Lists available rooms first.
  - After room selection, shows latest bill summary plus clickable PDF link.

## Billing Rules

- Electricity cost:
  - `electricity_consumption = new_electricity_reading - previous_electricity_reading`
  - `electricity_cost = electricity_consumption * electricity_rate`
- Water cost:
  - Fixed: `water_cost = fixed_amount`
  - Per-unit: `water_consumption = new_water_reading - previous_water_reading`, then `water_cost = water_consumption * water_rate`
- Total:
  - `total_cost = electricity_cost + water_cost`

## PDF Bill + Logo

- Generated PDF files are stored under `public/` and served via `/bills/:filename`.
- Place your logo image at:
  - `public/logo.jpg`
- If `public/logo.jpg` exists, it is rendered at the top of generated bills.

## Local Run

1. Install dependencies:
   - `npm install`
2. Start the server:
   - `npm start`

Default local URL:

- `http://localhost:3000`

## Railway Deployment

1. Push repository to GitHub.
2. Connect repository in Railway.
3. Add variables in Railway:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `OWNER_TELEGRAM_ID`
   - `BOT_URL` (set this to your Railway app URL)
4. Deploy.

## Set Telegram Webhook

After deploy, run (replace placeholders):

`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-railway-domain>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`

Optional verification:

`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo`

## Database Schema Notes

- `rooms`
  - Room + tenant profile and current rate/baseline meter values.
- `readings`
  - Historical meter input snapshots.
- `bills`
  - Computed bill records per room and billing period.

Startup includes schema migration logic for existing SQLite files, including `rooms.contact_number` and `rooms.move_in_date`.

## Security Notes

- Owner-only command access enforced via `OWNER_TELEGRAM_ID`.
- Webhook endpoint validates Telegram secret token when configured.
- Bill file endpoint sanitizes requested filename.

## Improvement Backlog

Prioritized next improvements:

1. Prevent negative consumption by rejecting readings lower than current baselines.
2. Update room baseline readings after each successful `/inputreading` billing cycle.
3. Block duplicate room registration and add explicit tenant transfer/update flows.
4. Enforce standardized room format (trim + uppercase) on insert and lookup everywhere.
5. Add strict validators for date and numeric formats with clear user-facing examples.
6. Handle water-rate mode changes (fixed/per-unit) with explicit transition rules.
7. Add payment tracking fields and commands (unpaid/paid, paid date, notes).
8. Add tenant edit commands (contact number, move-in date, rates).
9. Add `/cancel` to safely abort any multi-step flow.
10. Add room list pagination for properties with many units.
11. Add automated SQLite backup/export strategy for production safety.
12. Add audit logging (`created_by`, `updated_by`, timestamps per action).
