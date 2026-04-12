# Glenda BH Admin Webapp

Phone-first React admin dashboard with Express API and PostgreSQL integration.

## Features

- JWT admin authentication
- Dashboard summary and room ledger
- Register tenant
- Input readings and generate bills
- Mark bill as paid
- Mark paid bill back to unpaid (undo)
- Send SMS reminder per bill
- Send bulk reminders to all unpaid bills
- Uses same shared PostgreSQL database as Telegram bot

## Environment Variables

Copy `.env.example` and set:

- `PORT` (default: `8787`)
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD` or `ADMIN_PASSWORD_HASH`
- `HTTPSMS_API_KEY`
- `HTTPSMS_FROM_NUMBER`
- `BOT_URL` (used to append bill PDF link in SMS reminders)

## Local Development

```bash
npm install
npm run dev
```

For API + static app production mode:

```bash
npm run build
npm start
```

## Railway Deployment

Create a new Railway service from the `admin-webapp` folder.

- Build command: `npm install && npm run build`
- Start command: `npm start`

Set all environment variables listed above.
