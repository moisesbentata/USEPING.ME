import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM = process.env.TWILIO_WHATSAPP_NUMBER as string;

function toWhatsAppAddress(phone: string): string {
  return phone.startsWith("whatsapp:") ? phone : `whatsapp:${phone}`;
}

export async function sendWhatsAppMessage(toPhone: string, body: string) {
  await client.messages.create({
    from: FROM,
    to: toWhatsAppAddress(toPhone),
    body,
  });
}

const REMIND_CONTACT_TEMPLATE_SID = process.env.TWILIO_REMIND_CONTACT_CONTENT_SID;

export async function sendContactReminder(toPhone: string, contactName: string, ownerName: string, task: string) {
  if (!REMIND_CONTACT_TEMPLATE_SID) {
    throw new Error("TWILIO_REMIND_CONTACT_CONTENT_SID is not set — the approved WhatsApp template is required to message someone who hasn't texted Ping first.");
  }
  await client.messages.create({
    from: FROM,
    to: toWhatsAppAddress(toPhone),
    contentSid: REMIND_CONTACT_TEMPLATE_SID,
    contentVariables: JSON.stringify({ "1": contactName, "2": ownerName, "3": task }),
  });
}
