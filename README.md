# Ping

An AI assistant that lives in WhatsApp. This is the first slice: a bot you can chat
with naturally that remembers facts about you, and that can set reminders
("remind me to turn off the oven in 10 mins") which it actually sends back to you
on WhatsApp when they're due.

## How it works

- Twilio receives WhatsApp messages and posts them to `POST /webhooks/whatsapp`.
- Each message is handled by an agent (`src/agent.ts`) backed by Claude, which has
  three tools: `remember_fact`, `search_memory`, and `create_reminder`.
- Facts and reminders are stored in SQLite via Prisma (`prisma/schema.prisma`).
- A background scheduler (`src/scheduler.ts`) polls every 15s for due reminders
  and sends them back over WhatsApp.

## Setup

1. `cp .env.example .env` and fill in:
   - `ANTHROPIC_API_KEY`
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`
     (use the Twilio WhatsApp sandbox number while prototyping)
2. `npm install`
3. `npx prisma migrate dev`
4. `npm run dev`
5. Point your Twilio WhatsApp sandbox webhook at
   `https://<your-tunnel>/webhooks/whatsapp` (e.g. via `ngrok http 3000`).

## What's next

This covers 2 of the 5 MVP features from the product vision (memory + reminders).
Not yet built: Google Calendar integration, WhatsApp reminders to other people,
and the follow-up engine.
