import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import { embedText, toVectorLiteral } from "./embeddings";
import { nextOccurrence } from "./scheduler";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools: Anthropic.ToolUnion[] = [
  {
    name: "remember_fact",
    description:
      "Save a durable fact about the user for long-term recall (e.g. relationships, preferences, important dates). Do not use this for small talk.",
    input_schema: {
      type: "object",
      properties: {
        fact: { type: "string", description: "The fact to remember, written as a standalone statement." },
      },
      required: ["fact"],
    },
  },
  {
    name: "search_memory",
    description:
      "Search the user's remembered facts by meaning before answering a question about their life. Works even if the wording doesn't match exactly.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for, e.g. 'user's pet' or 'startup investors they've met'." },
      },
      required: ["query"],
    },
  },
  {
    name: "create_reminder",
    description:
      "Schedule a single reminder that will be sent back to the user via WhatsApp at a specific future time. For a repeating reminder, include recurrenceRule. For a significant date-driven event that deserves multiple spaced-out check-ins (not a trivial one-off task), use create_reminder_series instead.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to remind the user about." },
        dueAt: {
          type: "string",
          description: "ISO 8601 timestamp of when to send the reminder, computed from the current time given in context.",
        },
        recurrenceRule: {
          type: "string",
          description:
            "Optional. RFC5545 RRULE part (no DTSTART) for a repeating reminder, e.g. 'FREQ=WEEKLY;BYDAY=TU' for every Tuesday, or 'FREQ=WEEKLY;BYDAY=TU;UNTIL=20260819T000000Z' if the user gave an end point. Omit for a one-off reminder.",
        },
      },
      required: ["message", "dueAt"],
    },
  },
  {
    name: "create_reminder_series",
    description:
      "Schedule a group of related lead-up reminders for one significant, date-driven event (e.g. an exam, a big deadline, a trip) — multiple well-spaced check-ins working backward from the event, each with its own phrasing. Only use this when a single reminder genuinely wouldn't be enough lead time to matter; never use it for trivial or momentary tasks (those should just use create_reminder once).",
    input_schema: {
      type: "object",
      properties: {
        reminders: {
          type: "array",
          description: "The individual check-ins in the sequence, ordered by time.",
          items: {
            type: "object",
            properties: {
              message: { type: "string", description: "What this specific check-in should say." },
              dueAt: { type: "string", description: "ISO 8601 timestamp for this check-in." },
            },
            required: ["message", "dueAt"],
          },
        },
      },
      required: ["reminders"],
    },
  },
  {
    name: "list_reminders",
    description: "Look up the user's actual pending (not-yet-sent) reminders. Always call this instead of guessing from conversation history when asked what reminders exist, or before cancelling one.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "cancel_reminder",
    description:
      "Cancel a specific pending reminder by its id (obtained from list_reminders). If it's part of a lead-up series, this cancels the whole series.",
    input_schema: {
      type: "object",
      properties: {
        reminderId: { type: "string", description: "The exact id of the reminder to cancel, from list_reminders." },
      },
      required: ["reminderId"],
    },
  },
  {
    name: "set_own_name",
    description: "Save the user's own first name, so Ping can introduce them by name when texting one of their contacts on their behalf. Call this once, the first time it's needed and not already known.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The user's first name." },
      },
      required: ["name"],
    },
  },
  {
    name: "save_contact",
    description: "Save a phone number for someone the user wants to remind, so it only needs to be asked once.",
    input_schema: {
      type: "object",
      properties: {
        contactName: { type: "string", description: "The contact's first name, as the user refers to them." },
        phone: { type: "string", description: "Phone number in international format, e.g. +14155551234." },
      },
      required: ["contactName", "phone"],
    },
  },
  {
    name: "remind_contact",
    description:
      "Schedule a reminder to be sent to one of the user's contacts (not the user themselves) at a future time, on the user's behalf. The contact must already be saved via save_contact — if not found, this will say so; ask the user for the number and call save_contact first, then retry.",
    input_schema: {
      type: "object",
      properties: {
        contactName: { type: "string", description: "The contact's name, matching what was used in save_contact." },
        task: { type: "string", description: "What to remind them about, phrased as the task itself, e.g. 'send over the contract'." },
        dueAt: { type: "string", description: "ISO 8601 timestamp of when to send it." },
      },
      required: ["contactName", "task", "dueAt"],
    },
  },
  {
    name: "set_timezone",
    description:
      "Save the user's timezone so clock-time reminders (e.g. '6pm', 'at 9 tomorrow') resolve correctly. Call this whenever the user tells you where they are or that they've moved/traveled, or in response to asking them where they're based.",
    input_schema: {
      type: "object",
      properties: {
        ianaTimezone: {
          type: "string",
          description: "IANA timezone identifier inferred from the user's stated city/country, e.g. 'Europe/London', 'America/New_York'.",
        },
      },
      required: ["ianaTimezone"],
    },
  },
  {
    type: "web_search_20260318",
    name: "web_search",
    max_uses: 3,
    allowed_callers: ["direct"],
  },
];

async function runTool(userId: string, name: string, input: any, timezone: string | null): Promise<string> {
  switch (name) {
    case "remember_fact": {
      const embedding = await embedText(input.fact, "document");
      const vectorLiteral = toVectorLiteral(embedding);
      await prisma.$executeRaw`
        INSERT INTO "Memory" (id, "userId", content, embedding, "createdAt")
        VALUES (${randomUUID()}, ${userId}, ${input.fact}, ${vectorLiteral}::vector, now())
      `;
      return `Saved: ${input.fact}`;
    }
    case "search_memory": {
      const embedding = await embedText(input.query, "query");
      const vectorLiteral = toVectorLiteral(embedding);
      const memories = await prisma.$queryRaw<{ content: string }[]>`
        SELECT content FROM "Memory"
        WHERE "userId" = ${userId}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT 5
      `;
      if (memories.length === 0) return "No matching memories found.";
      return memories.map((m) => `- ${m.content}`).join("\n");
    }
    case "create_reminder": {
      const dueAt = new Date(input.dueAt);
      if (input.recurrenceRule) {
        try {
          nextOccurrence(input.recurrenceRule, dueAt, dueAt);
        } catch (err) {
          return `Invalid recurrenceRule "${input.recurrenceRule}": ${err instanceof Error ? err.message : err}. Fix it and call create_reminder again.`;
        }
      }
      await prisma.reminder.create({
        data: {
          userId,
          message: input.message,
          dueAt,
          recurrenceRule: input.recurrenceRule ?? null,
          recurrenceDtstart: input.recurrenceRule ? dueAt : null,
        },
      });
      return `Reminder scheduled for ${dueAt.toISOString()}${input.recurrenceRule ? ` (recurring: ${input.recurrenceRule})` : ""}.`;
    }
    case "create_reminder_series": {
      const groupId = randomUUID();
      const items = input.reminders as { message: string; dueAt: string }[];
      await prisma.reminder.createMany({
        data: items.map((r) => ({ userId, message: r.message, dueAt: new Date(r.dueAt), groupId })),
      });
      return `Scheduled ${items.length} check-ins: ${items.map((r) => new Date(r.dueAt).toISOString()).join(", ")}.`;
    }
    case "set_timezone": {
      await prisma.user.update({ where: { id: userId }, data: { timezone: input.ianaTimezone } });
      return `Timezone set to ${input.ianaTimezone}.`;
    }
    case "set_own_name": {
      await prisma.user.update({ where: { id: userId }, data: { name: input.name } });
      return `Name set to ${input.name}.`;
    }
    case "save_contact": {
      await prisma.contact.upsert({
        where: { ownerId_phone: { ownerId: userId, phone: input.phone } },
        update: { name: input.contactName },
        create: { ownerId: userId, name: input.contactName, phone: input.phone },
      });
      return `Saved contact ${input.contactName} (${input.phone}).`;
    }
    case "remind_contact": {
      const contact = await prisma.contact.findFirst({
        where: { ownerId: userId, name: { equals: input.contactName, mode: "insensitive" } },
        orderBy: { createdAt: "desc" },
      });
      if (!contact) {
        return `No saved contact named "${input.contactName}". Ask the user for their phone number, call save_contact, then retry remind_contact.`;
      }
      const dueAt = new Date(input.dueAt);
      await prisma.reminder.create({
        data: { userId, contactId: contact.id, message: input.task, dueAt },
      });
      return `Reminder to ${contact.name} scheduled for ${dueAt.toISOString()}.`;
    }
    case "list_reminders": {
      const reminders = await prisma.reminder.findMany({
        where: { userId, status: "pending" },
        orderBy: { dueAt: "asc" },
        include: { contact: true },
      });
      if (reminders.length === 0) return "No pending reminders.";
      return reminders
        .map((r) => {
          const when = timezone ? r.dueAt.toLocaleString("en-US", { timeZone: timezone }) : r.dueAt.toISOString();
          const recurring = r.recurrenceRule ? " [recurring]" : "";
          const grouped = r.groupId ? " [part of a series]" : "";
          const target = r.contact ? ` [to ${r.contact.name}, not the user]` : "";
          return `- id=${r.id}: ${r.message} (${when})${recurring}${grouped}${target}`;
        })
        .join("\n");
    }
    case "cancel_reminder": {
      const reminder = await prisma.reminder.findUnique({ where: { id: input.reminderId } });
      if (!reminder || reminder.userId !== userId || reminder.status !== "pending") {
        return "Couldn't find a matching pending reminder — call list_reminders again to get current ids.";
      }
      if (reminder.groupId) {
        const { count } = await prisma.reminder.updateMany({
          where: { userId, groupId: reminder.groupId, status: "pending" },
          data: { status: "cancelled" },
        });
        return `Cancelled the whole series (${count} check-ins).`;
      }
      await prisma.reminder.update({ where: { id: reminder.id }, data: { status: "cancelled" } });
      return `Cancelled: ${reminder.message}.`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

const HISTORY_LIMIT = 20;

export async function handleIncomingMessage(userId: string, userText: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const recentMemories = await prisma.memory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  const recentHistory = await prisma.message.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  recentHistory.reverse();

  const now = new Date();
  const timezoneContext = user.timezone
    ? `The user's timezone is ${user.timezone}. Their current local time is ${now.toLocaleString("en-US", { timeZone: user.timezone })}.`
    : `The user's timezone is NOT known yet. You only have UTC: ${now.toISOString()}.`;

  const systemPrompt = `You are Ping — a personal AI assistant that lives entirely in WhatsApp. You're not a customer support bot and not a generic chatbot; you're closer to a sharp, capable executive assistant who happens to text like a real person. The vision behind you: an assistant for every part of someone's life — remembering who they are, keeping their word for them, coordinating with the people in their life, and quietly handling the small stuff so they don't have to think about it.

Personality: warm but not sappy, direct but not curt, quietly confident. A little dry wit is fine when it fits, never forced. You take initiative rather than asking permission for obvious next steps, but you never fake having done something. You treat the user like a smart friend who also happens to be paying you to keep their life organized — familiar, not formal, never corporate.

What you can actually do right now: remember durable facts about the user and recall them by meaning (not just keyword), set one-off and recurring reminders, plan spaced-out check-ins for significant events, cancel reminders, text reminders to other people on the user's behalf, understand voice notes as well as text, and search the live web for current information.

What's on the roadmap but NOT built yet — be honest about this rather than pretending: managing their Google Calendar, drafting emails, and open-ended task execution (booking things on their behalf, etc.). If asked to do one of these, don't fake it or silently ignore it — say plainly that it's not wired up yet but it's coming, in one short sentence, without over-apologizing.

Current UTC date/time (ISO): ${now.toISOString()}
${timezoneContext}

Known facts about this user:
${recentMemories.length ? recentMemories.map((m) => `- ${m.content}`).join("\n") : "(none yet)"}

Guidelines:
- If the user shares a durable fact about themselves (relationships, preferences, important info) — even a short fragment like "my dog" that only makes sense combined with earlier turns — you MUST call remember_fact before replying, in that same turn. Compose the fact as a complete, self-contained statement using the full conversation so far (e.g. if they earlier said "Jackson" and now say "my dog", save "Jackson is the user's dog", not just "my dog"). Never reply with something that sounds like confirmation ("Got it", "Done", "I'll remember that", "noted") unless you actually called remember_fact first in that same turn — a text-only reply ends your turn, so a promise to remember something without calling the tool means it is NOT saved and never will be.
- If the user asks about something you might know, call search_memory first.
- Use web_search for anything current, time-sensitive, or outside your own knowledge — news, "what's happening today", prices, scores, current events, facts about specific real-world things you're not certain of. Don't use it for things you already know confidently or that don't need to be current.
- For a "what's the latest / what's new in X" style question, search for news from the past day or two and reply using exactly this shape: one short friendly opener (e.g. "Sure! Here's what's been happening in pharma:"), then 3-5 dash bullets, each one real sentence summarizing a distinct, genuinely important story in your own words (never a bare headline, a link, or just a dash with nothing after it), then one short closing line inviting them to ask for more on any of it (e.g. "Want me to dig deeper into any of these?"). For a narrower factual question with one clear answer, skip this shape entirely — just answer directly in a sentence or two.
- If the user mentions where they are, are traveling to, or moving to, call set_timezone with the correct IANA timezone for that place.
- If the user asks what reminders they have, or to check/list/cancel one, call list_reminders first — never guess or recall reminders from the conversation history, since that can be stale or wrong.
- If the user asks to be reminded of something using a relative time ("in 10 mins", "in an hour"), that doesn't depend on timezone — just compute it from the current UTC time above and call create_reminder.
- If the user asks to be reminded at a specific clock time ("6pm", "at 9 tomorrow", "13:20") and you do NOT know their timezone yet, don't guess — ask them where they're based first (e.g. "Quick one — what city/timezone are you in? Then I'll set that for good."). Once they answer, call set_timezone, then create_reminder.
- Once you know the user's timezone, convert clock times they give you into the correct UTC dueAt using that timezone before calling create_reminder.
- If the user wants a repeating reminder ("every Tuesday", "every day"), pass recurrenceRule to create_reminder as an RFC5545 RRULE. If they gave no end point, leave it open-ended (repeats until cancelled). If they gave one ("for the next month"), set UNTIL accordingly.
- For a genuinely significant, date-driven event far enough out that one reminder at zero-hour wouldn't be useful (an exam, a big deadline, a trip) — not a trivial task like taking out the trash — use create_reminder_series to schedule a handful of well-spaced check-ins working backward from the date, each with fitting phrasing (e.g. "start revising" well before, "good luck!" on the day). Always tell the user in your reply exactly what check-ins you're planning, so they can adjust. If the user specifies their own cadence ("just remind me the morning of"), respect that exactly instead of building a series.
- To cancel/remove/stop a reminder: call list_reminders, match it against what the user described. If exactly one clearly matches, cancel it directly. If more than one could match, describe the options in plain language and ask which one before cancelling — never guess. Never show raw reminder ids to the user; those are for your internal use only. If a cancelled reminder was part of a series, mention that the whole series was cancelled.
- If the user asks you to remind someone else (e.g. "remind John tomorrow to send me the contract"), that's a different flow from a normal reminder: call remind_contact. If it comes back saying the contact isn't saved, ask the user for that person's phone number, call save_contact, then call remind_contact again. If you don't yet know the user's own first name and are about to remind a contact for the first time, ask for it and call set_own_name first (it's used to introduce the user by name when texting the contact).
- Write like a real person texting, not a customer support bot. Short sentences. No bullet points, no bold/markdown headers, no numbered lists, unless the user is explicitly asking for a structured list of items — even then keep it minimal (plain dashes, no headers, no bold).
- Don't over-explain or pad the reply with extra offers to help unless it's genuinely useful. One or two sentences is often enough.
- Don't narrate tool use ("I'll save that") — just reply the way a person would after already knowing the answer.
- Use at most one emoji, only if it fits naturally, never as decoration on every message.`;

  const messages: Anthropic.MessageParam[] = [
    ...recentHistory.map((m): Anthropic.MessageParam => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
    { role: "user", content: userText },
  ];

  await prisma.message.create({ data: { userId, role: "user", content: userText } });

  for (let turn = 0; turn < 5; turn++) {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      // With server-side tools like web_search, a single response can split its
      // reply across multiple separate text blocks interleaved with search calls.
      // The full answer is all of them concatenated in order, not just one.
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
      const reply = textBlocks.map((b) => b.text).join("\n\n").trim() || "Done.";
      await prisma.message.create({ data: { userId, role: "assistant", content: reply } });
      return reply;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await runTool(userId, toolUse.name, toolUse.input, user.timezone);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const fallback = "Sorry, I got a bit stuck on that one — could you rephrase?";
  await prisma.message.create({ data: { userId, role: "assistant", content: fallback } });
  return fallback;
}
