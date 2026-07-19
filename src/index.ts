import "dotenv/config";
import express from "express";
import { prisma, getOrCreateUser, findContactsByPhone } from "./db";
import { handleIncomingMessage } from "./agent";
import { sendWhatsAppMessage } from "./whatsapp";
import { startReminderScheduler } from "./scheduler";
import { transcribeAudio } from "./transcription";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

async function downloadTwilioMedia(url: string): Promise<Buffer> {
  const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) throw new Error(`Failed to download media: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const RESEARCH_HINTS = [
  "latest",
  "news",
  "today",
  "this week",
  "recent",
  "current",
  "what's happening",
  "whats happening",
  "score",
  "price of",
  "weather",
  "search",
  "look up",
  "look into",
  "research",
];

function looksLikeResearchQuery(text: string): boolean {
  const lower = text.toLowerCase();
  return RESEARCH_HINTS.some((hint) => lower.includes(hint));
}

async function resolveMessageText(reqBody: any): Promise<string | null> {
  const numMedia = Number(reqBody.NumMedia ?? "0");
  if (numMedia > 0) {
    const contentType = reqBody.MediaContentType0 as string | undefined;
    const mediaUrl = reqBody.MediaUrl0 as string | undefined;
    if (mediaUrl && contentType?.startsWith("audio/")) {
      const audio = await downloadTwilioMedia(mediaUrl);
      return transcribeAudio(audio, contentType);
    }
  }
  const body = reqBody.Body as string | undefined;
  return body && body.trim().length > 0 ? body : null;
}

app.post("/webhooks/whatsapp", async (req, res) => {
  const from = req.body.From as string | undefined;

  res.status(200).send();

  if (!from) return;

  try {
    const phone = from.replace("whatsapp:", "");
    let body: string;
    try {
      const resolved = await resolveMessageText(req.body);
      if (!resolved) return;
      body = resolved;
    } catch (err) {
      console.error("Failed to transcribe voice note:", err);
      await sendWhatsAppMessage(phone, "Sorry, I couldn't understand that voice note — mind trying again or texting instead?");
      return;
    }

    const existingUser = await prisma.user.findUnique({ where: { phone } });
    if (!existingUser) {
      const contactMatches = await findContactsByPhone(phone);
      if (contactMatches.length > 0) {
        for (const contact of contactMatches) {
          await sendWhatsAppMessage(contact.owner.phone, `${contact.name} replied: "${body}"`);
        }
        await sendWhatsAppMessage(phone, "Got it, I'll pass that along! 🙂");
        return;
      }
    }

    if (looksLikeResearchQuery(body)) {
      await sendWhatsAppMessage(phone, "Sure! Give me a sec to look into that 🔍");
    }

    const user = existingUser ?? (await getOrCreateUser(phone));
    const reply = await handleIncomingMessage(user.id, body);
    await sendWhatsAppMessage(phone, reply);
  } catch (err) {
    console.error("Error handling incoming message:", err);
  }
});

app.get("/health", (_req, res) => res.send("ok"));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`Ping listening on port ${PORT}`);
  startReminderScheduler();
});
