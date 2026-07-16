import { prisma } from "./db";
import { sendWhatsAppMessage } from "./whatsapp";

const CHECK_INTERVAL_MS = 15_000;

export function startReminderScheduler() {
  setInterval(checkDueReminders, CHECK_INTERVAL_MS);
  checkDueReminders();
}

async function checkDueReminders() {
  const due = await prisma.reminder.findMany({
    where: { status: "pending", dueAt: { lte: new Date() } },
    include: { user: true },
  });

  for (const reminder of due) {
    try {
      await sendWhatsAppMessage(reminder.user.phone, `⏰ Reminder: ${reminder.message}`);
      await prisma.reminder.update({ where: { id: reminder.id }, data: { status: "sent" } });
    } catch (err) {
      console.error(`Failed to send reminder ${reminder.id}:`, err);
    }
  }
}
