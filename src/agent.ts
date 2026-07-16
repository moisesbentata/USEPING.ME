import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "./db";

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
    description: "Search the user's remembered facts by keyword before answering a question about their life.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keyword or phrase to search for." },
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
];

async function runTool(userId: string, name: string, input: any): Promise<string> {
  switch (name) {
    case "remember_fact": {
      await prisma.memory.create({ data: { userId, content: input.fact } });
      return `Saved: ${input.fact}`;
    }
    case "search_memory": {
      const memories = await prisma.memory.findMany({
        where: { userId, content: { contains: input.query } },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
      if (memories.length === 0) return "No matching memories found.";
      return memories.map((m) => `- ${m.content}`).join("\n");
    }
    case "create_reminder": {
      const dueAt = new Date(input.dueAt);
      await prisma.reminder.create({ data: { userId, message: input.message, dueAt } });
      return `Reminder scheduled for ${dueAt.toISOString()}.`;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

const HISTORY_LIMIT = 20;

export async function handleIncomingMessage(userId: string, userText: string): Promise<string> {
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
  const systemPrompt = `You are Ping, a warm and efficient personal WhatsApp assistant. You remember things about the user and set reminders for them.

Current date/time (ISO, use this to resolve relative times like "in 10 mins" or "tomorrow"): ${now.toISOString()}

Known facts about this user:
${recentMemories.length ? recentMemories.map((m) => `- ${m.content}`).join("\n") : "(none yet)"}

Guidelines:
- If the user shares a durable fact about themselves (relationships, preferences, important info), call remember_fact.
- If the user asks about something you might know, call search_memory first.
- If the user asks to be reminded of something, call create_reminder with an absolute ISO dueAt computed from the current time above.
- Keep replies short, natural, and conversational, like a text from a helpful human assistant. Don't narrate tool use ("I'll save that") — just confirm naturally ("Got it, noted!").`;

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
