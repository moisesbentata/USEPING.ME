import { RRule } from "rrule";
import { prisma } from "./db";
import { sendWhatsAppMessage } from "./whatsapp";

const CHECK_INTERVAL_MS = 15_000;

export function startReminderScheduler() {
  setInterval(checkDueReminders, CHECK_INTERVAL_MS);
  checkDueReminders();
}

function nextOccurrence(recurrenceRule: string, dtstart: Date, after: Date): Date | null {
  const options = RRule.parseString(recurrenceRule);
  options.dtstart = dtstart;
  const rule = new RRule(options);
  return rule.after(after, false);
}

async function checkDueReminders() {
  const due = await prisma.reminder.findMany({
    where: { status: "pending", dueAt: { lte: new Date() } },
    include: { user: true },
  });

  for (const reminder of due) {
    try {
      await sendWhatsAppMessage(reminder.user.phone, `⏰ Reminder: ${reminder.message}`);

      if (reminder.recurrenceRule && reminder.recurrenceDtstart) {
        const next = nextOccurrence(reminder.recurrenceRule, reminder.recurrenceDtstart, reminder.dueAt);
        if (next) {
          await prisma.reminder.update({ where: { id: reminder.id }, data: { dueAt: next } });
          continue;
        }
      }

      await prisma.reminder.update({ where: { id: reminder.id }, data: { status: "sent" } });
    } catch (err) {
      console.error(`Failed to send reminder ${reminder.id}:`, err);
    }
  }
}
