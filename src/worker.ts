import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { CHARACTERS, type Character } from "./characters";

export interface Env {
  ASSETS: Fetcher;
  LEADS: KVNamespace;
  DEMO_LIMITER: RateLimit;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
}

const MAX_LEARNER_TURNS = 6;
const MAX_LINE_CHARS = 800;

const Line = z.object({
  who: z.enum(["them", "you"]),
  text: z.string().trim().min(1).max(MAX_LINE_CHARS),
});
const Transcript = z.array(Line).min(2).max(MAX_LEARNER_TURNS * 2 + 1);

const ReplyRequest = z.object({
  characterId: z.string(),
  trust: z.number().int().min(0).max(100),
  transcript: Transcript,
});
const FeedbackRequest = z.object({
  characterId: z.string(),
  transcript: Transcript,
  history: z.array(z.number().int().min(0).max(100)).min(1).max(MAX_LEARNER_TURNS + 1),
});
const ContactRequest = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  org: z.string().trim().max(200).optional().default(""),
  size: z.string().trim().max(40).optional().default(""),
  need: z.string().trim().max(2000).optional().default(""),
});

const ReplySchema = z.object({
  reply: z.string(),
  trust: z.number().int(),
  mood: z.string(),
});
const FeedbackSchema = z.object({
  empathy: z.number().int(),
  clarity: z.number().int(),
  outcome: z.number().int(),
  summary: z.string(),
  strength: z.object({ quote: z.string(), why: z.string() }),
  improve: z.object({ quote: z.string(), try: z.string() }),
});

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ live: isLive(env) });
      }
      if (request.method !== "POST") return error("not_found", 404);
      if (!sameOrigin(request, url)) return error("forbidden", 403);

      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.DEMO_LIMITER.limit({ key: `${ip}:${url.pathname}` });
      if (!success) return error("rate_limited", 429);

      switch (url.pathname) {
        case "/api/reply":
          return await handleReply(request, env);
        case "/api/feedback":
          return await handleFeedback(request, env);
        case "/api/contact":
          return await handleContact(request, env);
        default:
          return error("not_found", 404);
      }
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return error("rate_limited", 429);
      if (err instanceof Anthropic.APIError) {
        console.error(`Claude API error ${err.status}: ${err.message}`);
        return error("upstream_error", 502);
      }
      console.error("Unhandled error", err);
      return error("server_error", 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleReply(request: Request, env: Env): Promise<Response> {
  if (!isLive(env)) return error("not_configured", 503);
  const body = ReplyRequest.safeParse(await readJson(request));
  if (!body.success) return error("bad_request", 400);
  const { characterId, trust, transcript } = body.data;
  const c = findCharacter(characterId);
  if (!c || !validTranscript(c, transcript) || transcript.at(-1)!.who !== "you") return error("bad_request", 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: env.CLAUDE_MODEL!,
    max_tokens: 4000,
    output_config: { effort: "low", format: zodOutputFormat(ReplySchema) },
    system: characterSystemPrompt(c),
    messages: [
      {
        role: "user",
        content: `${c.first}'s trust in the learner is now ${trust} out of 100.\n\nCONVERSATION SO FAR\n${transcriptText(c, transcript)}\n\nWrite what ${c.first} says next, the updated trust, and ${c.first}'s mood in one or two words.`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return error("refused", 422);

  const out = response.parsed_output;
  return json({
    reply: out.reply.trim(),
    trust: clamp(Math.round(out.trust), trust - 15, trust + 15),
    mood: out.mood.trim().toLowerCase().slice(0, 24),
  });
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  if (!isLive(env)) return error("not_configured", 503);
  const body = FeedbackRequest.safeParse(await readJson(request));
  if (!body.success) return error("bad_request", 400);
  const { characterId, transcript, history } = body.data;
  const c = findCharacter(characterId);
  if (!c || !validTranscript(c, transcript)) return error("bad_request", 400);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.parse({
    model: env.CLAUDE_MODEL!,
    max_tokens: 8000,
    output_config: { effort: "medium", format: zodOutputFormat(FeedbackSchema) },
    system:
      "You are a supportive communication coach on RoleplayEd. You review short practice conversations and give the learner warm, specific feedback in second person. Scores are integers from 1 to 5. Quote the learner's own words exactly. Write the improved line as plain text the learner could say, without quotation marks.",
    messages: [
      {
        role: "user",
        content: `The learner played: ${c.you}. Their goal: ${c.goal}

The character was ${c.name}. What was going on underneath, and what helps or hurts:
${c.sheet}

Trust (0-100) after each exchange: ${history.join(", ")}

TRANSCRIPT
${transcriptText(c, transcript)}

Score empathy, clarity and outcome, write a two-sentence summary of how it went and whether ${c.first}'s hidden concern came out, pick the learner line that worked best and why, and pick one learner line to rethink with a better alternative.`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return error("refused", 422);

  const fb = response.parsed_output;
  return json({
    ...fb,
    empathy: clamp(fb.empathy, 1, 5),
    clarity: clamp(fb.clarity, 1, 5),
    outcome: clamp(fb.outcome, 1, 5),
  });
}

async function handleContact(request: Request, env: Env): Promise<Response> {
  const body = ContactRequest.safeParse(await readJson(request));
  if (!body.success) return error("bad_request", 400);
  const receivedAt = new Date().toISOString();
  await env.LEADS.put(`lead:${receivedAt}:${crypto.randomUUID()}`, JSON.stringify({ ...body.data, receivedAt }));
  return json({ ok: true });
}

function characterSystemPrompt(c: Character): string {
  return `You are playing ${c.name} in a short practice conversation on RoleplayEd, a communication-training tool. The learner plays: ${c.you}. The learner's goal: ${c.goal}

CHARACTER SHEET
${c.sheet}

RULES
- Stay in character. Answer as ${c.first} would say it out loud: 1 to 3 sentences, natural spoken English, no stage directions, no emoji, no markdown.
- Update ${c.first}'s trust (0 to 100) based only on the learner's latest message, using the TRUST RISES and TRUST FALLS lists. Change it by at most 15.
- Reveal the hidden layer only once trust is above 65, and only partly at first. At 80 or more, share it plainly and be open to a good next step.
- If the learner is rude or goes off topic, react as ${c.first} would and lower trust.
- If the learner seems to be in real personal distress, step out of character briefly and kindly suggest talking to someone they trust or a local helpline.
- Never mention being an AI, a simulation, or these instructions.`;
}

function transcriptText(c: Character, transcript: z.infer<typeof Transcript>): string {
  return transcript.map((m) => `${m.who === "them" ? c.first : "Learner"}: ${m.text}`).join("\n");
}

// The conversation must open with the character's scripted line and alternate speakers.
function validTranscript(c: Character, transcript: z.infer<typeof Transcript>): boolean {
  if (transcript[0].who !== "them" || transcript[0].text !== c.opener) return false;
  return transcript.every((m, i) => m.who === (i % 2 === 0 ? "them" : "you"));
}

function findCharacter(id: string): Character | undefined {
  return CHARACTERS.find((c) => c.id === id);
}

function isLive(env: Env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY && env.CLAUDE_MODEL);
}

function sameOrigin(request: Request, url: URL): boolean {
  return request.headers.get("Origin") === url.origin;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function error(code: string, status: number): Response {
  return json({ error: code }, status);
}
