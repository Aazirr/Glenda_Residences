# Glenda BH Telegram Bot

Telegram bot for apartment management and utility billing at Glenda Residences.

## Overview

This service receives Telegram webhook updates, stores tenant and billing data in PostgreSQL (via Railway `DATABASE_URL`) or SQLite fallback for local development, generates PDF bills, and runs on Railway.

## Tech Stack

- Node.js (built-in `http` server)
- PostgreSQL (`pg`) for production persistence
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
- `DATABASE_URL` (required on Railway for persistent Postgres)

Example:

```env
PORT=3000
TELEGRAM_BOT_TOKEN=replace_me
TELEGRAM_WEBHOOK_SECRET=replace_me
OWNER_TELEGRAM_ID=6977978829
BOT_URL=https://glenda-residences-production.up.railway.app
DATABASE_URL=postgresql://user:password@host:port/database
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
  - Captures: tenant name, room number, contact number, move-in date, monthly room rate, electricity rate, current electricity reading, water rate, current water reading.
  - Room numbers are normalized to uppercase, so `4c` and `4C` are treated the same.
  - Water rate prefix is case-insensitive, so `Fixed:100`, `fixed:100`, and `PER:15` are all accepted.
  - Move-in date accepts common formats like `2026-04-09`, `April 9, 2026`, and `today`.
  - Monthly room rate and meter values accept commas and currency symbols, like `3,500` or `₱3,500`.
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
  - `total_cost = room_rate + electricity_cost + water_cost`

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
  - `DATABASE_URL` (from your Railway Postgres service)
4. Deploy.

Important:

- Railway filesystem is ephemeral, so SQLite files reset on deploy.
- Use `DATABASE_URL` to persist tenant and billing data in Railway Postgres.

## Set Telegram Webhook

After deploy, run (replace placeholders):

`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-railway-domain>/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>`

Optional verification:

`https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo`

## Database Schema Notes

- `rooms`
  - Room + tenant profile, monthly room rate, and current rate/baseline meter values.
- `readings`
  - Historical meter input snapshots.
- `bills`
  - Computed bill records per room and billing period.

Startup includes schema migration logic for both Postgres and SQLite, including `rooms.contact_number`, `rooms.move_in_date`, `rooms.room_rate`, and `bills.room_rate`.

## Security Notes

- Owner-only command access enforced via `OWNER_TELEGRAM_ID`.
- Webhook endpoint validates Telegram secret token when configured.
- Bill file endpoint sanitizes requested filename.

## Current Implementation Sprint

This is the active feature set being implemented next.

### Scope (In Progress)

- [x] Reading Sanity Checks
- [x] Auto Update Room Baseline Readings
- [ ] Monthly Room Rate Billing
- [ ] Payment Status Window
- [ ] Tenant Update Command
- [ ] Delete/Transfer Tenant Flow
- [ ] Edit Reading

### Planned Command Additions

- `/updatetenant`
  - Update tenant fields for an existing room (name, contact number, move-in date, rates).
- `/deletetenant`
  - Remove tenant assignment from a room (with confirmation step).
- `/transfertenant`
  - Move an existing tenant from one room to another safely.
- `/editreading`
  - Correct the latest reading/bill entry for a room.
- `/markpaid` and `/paymentstatus`
  - Mark bills paid and view bill payment state.

### Feature Notes

1. Reading Sanity Checks
  - Reject new readings lower than current room baselines.
  - Return clear error message with previous baseline values.

2. Case-Insensitive Inputs
  - Normalize room numbers on save and lookup.
  - Accept water-rate prefixes in any letter case.
  - Accept common date and number formats during tenant registration.

3. Auto Update Room Baseline Readings
  - After successful `/inputreading`, update `rooms.electricity_reading` and `rooms.water_reading`.
  - Prevent repeated billing from stale baseline values.

4. Monthly Room Rate Billing
  - Capture room monthly rate during `/registertenant`.
  - Add room rate into every generated bill total and PDF.

5. Payment Status Window
  - Add bill payment fields in `bills` table (status, paid_at, payment_notes).
  - Default new bills to `unpaid`.

6. Tenant Update Command
  - Allow editing tenant and pricing details without re-registering.
  - Keep room number uniqueness intact.

7. Delete/Transfer Tenant Flow
  - Delete flow should keep billing history but clear active tenant assignment.
  - Transfer flow should preserve history and update room ownership safely.

8. Edit Reading
  - Allow correction of most recent reading/bill per room.
  - Recompute bill totals after edit.

### Acceptance Criteria

- No negative consumption can be generated.
- `/inputreading` always updates room baseline values after successful bill generation.
- Bills visibly show payment status and can be marked paid.
- Monthly room rate is included in the computed bill total and PDF output.
- Room lookups and water-rate prefixes are case-insensitive.
- Tenant details can be updated without duplicate-room conflicts.
- Tenant delete/transfer flows do not erase historical bills.
- Reading edits are traceable and update computed totals correctly.

## Backlog (After Current Sprint)

1. Enforce standardized room format (trim + uppercase) on insert and lookup everywhere.
2. Add strict validators for date and numeric formats with clear user-facing examples.
3. Handle water-rate mode changes (fixed/per-unit) with explicit transition rules.
4. Add `/cancel` to safely abort any multi-step flow.
5. Add room list pagination for properties with many units.
6. Add automated SQLite backup/export strategy for production safety.
7. Add audit logging (`created_by`, `updated_by`, timestamps per action).
