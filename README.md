# Ping

An AI assistant that lives in WhatsApp. This is the first slice: a bot you can chat
with naturally that remembers facts about you (with real semantic search), keeps
short-term conversation context, and can set reminders ("remind me to turn off the
oven in 10 mins") which it actually sends back to you on WhatsApp when they're due.

## How it works

- Twilio receives WhatsApp messages and posts them to `POST /webhooks/whatsapp`.
- Each message is handled by an agent (`src/agent.ts`) backed by Claude, which has
  three tools: `remember_fact`, `search_memory`, and `create_reminder`.
- Users, reminders, and recent conversation history are stored in Postgres via
  Prisma (`prisma/schema.prisma`).
- Long-term facts are stored with a vector embedding (via Voyage AI, `src/embeddings.ts`)
  in a Postgres `vector` column (pgvector extension), so `search_memory` finds
  facts by meaning, not just exact keyword matches.
- A background scheduler (`src/scheduler.ts`) polls every 15s for due reminders
  and sends them back over WhatsApp.

## Setup

1. `cp .env.example .env` and fill in:
   - `DATABASE_URL` — a Postgres connection string with the `vector` extension
     available (e.g. a Supabase project's connection string)
   - `ANTHROPIC_API_KEY`
   - `VOYAGE_API_KEY` — for turning memory text into embeddings
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`
2. `npm install`
3. `npx prisma migrate deploy` (applies the schema, including enabling `pgvector`)
4. `npm run dev`
5. Point your Twilio WhatsApp webhook at
   `https://<your-tunnel>/webhooks/whatsapp` (e.g. via `ngrok http 3000`).

## What's next

This covers 2 of the 5 MVP features from the product vision (memory + reminders).
Not yet built: Google Calendar integration, WhatsApp reminders to other people,
and the follow-up engine.
