import "dotenv/config";
import express from "express";
import { getOrCreateUser } from "./db";
import { handleIncomingMessage } from "./agent";
import { sendWhatsAppMessage } from "./whatsapp";
import { startReminderScheduler } from "./scheduler";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/webhooks/whatsapp", async (req, res) => {
  const from = req.body.From as string | undefined;
  const body = req.body.Body as string | undefined;

  res.status(200).send();

  if (!from || !body) return;

  try {
    const phone = from.replace("whatsapp:", "");
    const user = await getOrCreateUser(phone);
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
