import fetch from "node-fetch";
import type { Claim, Cluster } from "../decision/types.js";
import { FEATURE_CLUSTERS } from "../decision/snapshot.js";
import type { AgentContext } from "./types.js";

/**
 * Shared prompt + response-parsing for every LLM-backed agent (docs/01 §4.1
 * "agent testimony with citations", docs/05 agent contracts). The model is
 * asked to cite only featureIds present in the snapshot and copy their exact
 * value — it is told explicitly that an invented number gets the claim
 * discarded. This is what makes citation verification (claims.ts
 * verifyClaim) meaningful once a real model is in the loop, instead of the
 * rules engine checking its own arithmetic.
 */

function buildPrompt(ctx: AgentContext): string {
  const { snapshot, headlines } = ctx;
  const features = Object.entries(snapshot.values)
    .map(([k, v]) => `${k} = ${v.toFixed(4)}`)
    .join("\n");
  const headlineBlock = headlines.length
    ? headlines.slice(0, 8).map((h) => `- "${h.title}" (${h.source})`).join("\n")
    : "(no recent relevant headlines)";

  return `You are a trading research agent for a paper-trading crypto swing system. You are testimony, not a decision-maker: you may only cite numbers that appear in the FEATURES block below, exactly as given. Inventing a number or citing a feature not listed will cause your claim to be discarded and debits your reliability score.

SETUP
asset: ${snapshot.meta.asset}
archetype: ${snapshot.meta.archetype}
direction: ${snapshot.meta.direction}
regime: ${snapshot.meta.regime}
entry: ${snapshot.meta.entryPrice}
stop: ${snapshot.meta.stopPrice}

FEATURES (the only numbers you may cite)
${features}

RECENT HEADLINES (context only — cite via news_sentiment_score/hours_to_next_tier1_event, not the headline text itself)
${headlineBlock}

Return ONLY a JSON array (no prose, no markdown fences) of at most 4 claims, each:
{"text": "one sentence", "stance": "BULLISH"|"BEARISH"|"NEUTRAL", "strength": number from -1 to 1, "featureIds": ["..."], "observedValues": {"featureId": number}}

Every id in featureIds must be a key from FEATURES, and observedValues must copy that exact value. strength's sign must match stance's directional lean toward ${snapshot.meta.direction}.`;
}

function parseClaims(text: string, agentName: string): Claim[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let raw: unknown[];
  try {
    raw = JSON.parse(match[0]);
  } catch {
    return [];
  }
  const claims: Claim[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const featureIds = Array.isArray(o.featureIds) ? (o.featureIds.filter((f) => typeof f === "string") as string[]) : [];
    const observedValues = typeof o.observedValues === "object" && o.observedValues !== null ? (o.observedValues as Record<string, number>) : {};
    const stance = o.stance === "BULLISH" || o.stance === "BEARISH" || o.stance === "NEUTRAL" ? o.stance : "NEUTRAL";
    const strength = typeof o.strength === "number" ? Math.max(-1, Math.min(1, o.strength)) : 0;
    const text2 = typeof o.text === "string" ? o.text : "(no rationale given)";
    if (featureIds.length === 0) continue;
    const cluster: Cluster = FEATURE_CLUSTERS[featureIds[0]] ?? "NEWS";
    claims.push({
      text: text2,
      stance,
      strength,
      featureIds,
      observedValues,
      agent: agentName,
      cluster,
      verified: false, // set true only after evidence.ts's citation check passes
    });
  }
  return claims.slice(0, 4);
}

export async function callAnthropic(apiKey: string, model: string, ctx: AgentContext, agentName: string): Promise<Claim[]> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [{ role: "user", content: buildPrompt(ctx) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = data.content.find((c) => c.type === "text")?.text ?? "";
  return parseClaims(text, agentName);
}

/** OpenAI and Groq both speak the same chat-completions shape. */
export async function callChatCompletions(
  baseUrl: string,
  apiKey: string,
  model: string,
  ctx: AgentContext,
  agentName: string
): Promise<Claim[]> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      temperature: 0.2,
      messages: [{ role: "user", content: buildPrompt(ctx) }],
    }),
  });
  if (!res.ok) throw new Error(`${baseUrl} API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  const text = data.choices[0]?.message?.content ?? "";
  return parseClaims(text, agentName);
}

export async function callGemini(apiKey: string, model: string, ctx: AgentContext, agentName: string): Promise<Claim[]> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(ctx) }] }],
      generationConfig: {
        maxOutputTokens: 600,
        temperature: 0.2,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return parseClaims(text, agentName);
}
