import { RRule } from "rrule";
import { prisma } from "./db";
import { sendWhatsAppMessage, sendContactReminder } from "./whatsapp";

const CHECK_INTERVAL_MS = 15_000;

export function startReminderScheduler() {
  setInterval(checkDueReminders, CHECK_INTERVAL_MS);
  checkDueReminders();
}

export function nextOccurrence(recurrenceRule: string, dtstart: Date, after: Date): Date | null {
  const options = RRule.parseString(recurrenceRule);
  options.dtstart = dtstart;
  const rule = new RRule(options);
  return rule.after(after, false);
}

async function checkDueReminders() {
  const due = await prisma.reminder.findMany({
    where: { status: "pending", dueAt: { lte: new Date() } },
    include: { user: true, contact: true },
  });

  for (const reminder of due) {
    try {
      // Claim the reminder atomically before sending anything, so a concurrent
      // cancel or overlapping poll can never result in a duplicate/runaway send.
      let nextDueAt: Date | null = null;
      if (reminder.recurrenceRule && reminder.recurrenceDtstart) {
        try {
          nextDueAt = nextOccurrence(reminder.recurrenceRule, reminder.recurrenceDtstart, reminder.dueAt);
        } catch (err) {
          console.error(`Invalid recurrenceRule on reminder ${reminder.id}, treating as one-off:`, err);
          nextDueAt = null;
        }
      }

      const claim = await prisma.reminder.updateMany({
        where: { id: reminder.id, status: "pending" },
        data: nextDueAt ? { dueAt: nextDueAt } : { status: "sent" },
      });
      if (claim.count === 0) continue; // already cancelled or claimed elsewhere

      if (reminder.contact) {
        const ownerName = reminder.user.name ?? "Someone";
        try {
          await sendContactReminder(reminder.contact.phone, reminder.contact.name, ownerName, reminder.message);
          await sendWhatsAppMessage(reminder.user.phone, `Reminded ${reminder.contact.name} to ${reminder.message} ✅`);
        } catch (sendErr) {
          console.error(`Failed to reach contact for reminder ${reminder.id}:`, sendErr);
          await sendWhatsAppMessage(
            reminder.user.phone,
            `Couldn't reach ${reminder.contact.name} about "${reminder.message}" — the message failed to deliver.`
          );
        }
      } else {
        await sendWhatsAppMessage(reminder.user.phone, `⏰ Reminder: ${reminder.message}`);
      }
    } catch (err) {
      console.error(`Failed to send reminder ${reminder.id}:`, err);
    }
  }
}
