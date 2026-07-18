import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";
import { embedText, toVectorLiteral } from "./embeddings";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const tools: Anthropic.Tool[] = [
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
    description: "Schedule a reminder that will be sent back to the user via WhatsApp at a specific future time.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to remind the user about." },
        dueAt: {
          type: "string",
          description: "ISO 8601 timestamp of when to send the reminder, computed from the current time given in context.",
        },
      },
      required: ["message", "dueAt"],
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
];

async function runTool(userId: string, name: string, input: any): Promise<string> {
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
      await prisma.reminder.create({ data: { userId, message: input.message, dueAt } });
      return `Reminder scheduled for ${dueAt.toISOString()}.`;
    }
    case "set_timezone": {
      await prisma.user.update({ where: { id: userId }, data: { timezone: input.ianaTimezone } });
      return `Timezone set to ${input.ianaTimezone}.`;
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

  const systemPrompt = `You are Ping, the user's personal assistant, texting them on WhatsApp. You remember things about them and set reminders for them.

Current UTC date/time (ISO): ${now.toISOString()}
${timezoneContext}

Known facts about this user:
${recentMemories.length ? recentMemories.map((m) => `- ${m.content}`).join("\n") : "(none yet)"}

Guidelines:
- If the user shares a durable fact about themselves (relationships, preferences, important info), call remember_fact.
- If the user asks about something you might know, call search_memory first.
- If the user mentions where they are, are traveling to, or moving to, call set_timezone with the correct IANA timezone for that place.
- If the user asks to be reminded of something using a relative time ("in 10 mins", "in an hour"), that doesn't depend on timezone — just compute it from the current UTC time above and call create_reminder.
- If the user asks to be reminded at a specific clock time ("6pm", "at 9 tomorrow", "13:20") and you do NOT know their timezone yet, don't guess — ask them where they're based first (e.g. "Quick one — what city/timezone are you in? Then I'll set that for good."). Once they answer, call set_timezone, then create_reminder.
- Once you know the user's timezone, convert clock times they give you into the correct UTC dueAt using that timezone before calling create_reminder.
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
      max_tokens: 1024,
      system: systemPrompt,
      tools,
      messages,
    });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      const reply = textBlock?.text ?? "Done.";
      await prisma.message.create({ data: { userId, role: "assistant", content: reply } });
      return reply;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const result = await runTool(userId, toolUse.name, toolUse.input);
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }
    messages.push({ role: "user", content: toolResults });
  }

  const fallback = "Sorry, I got a bit stuck on that one — could you rephrase?";
  await prisma.message.create({ data: { userId, role: "assistant", content: fallback } });
  return fallback;
}
