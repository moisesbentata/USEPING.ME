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
