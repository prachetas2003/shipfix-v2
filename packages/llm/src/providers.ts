import { redact } from "@shipfix/secrets";
import type { LLMGateway, LLMRequest, LLMResult } from "./types";

interface ProviderConfig {
  apiKey: string;
  model: string;
}

async function failBody(res: Response): Promise<never> {
  const body = await res.text().catch(() => "");
  // Redact in case a provider echoes a key back in an error payload.
  throw new Error(`LLM provider HTTP ${res.status}: ${redact(body).slice(0, 500)}`);
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI Chat Completions REST API (no SDK dependency). */
export function createOpenAIGateway({ apiKey, model }: ProviderConfig): LLMGateway {
  return {
    model,
    async complete(req: LLMRequest): Promise<LLMResult> {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: req.temperature ?? 0,
          max_tokens: req.maxOutputTokens ?? 4096,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      });
      if (!res.ok) await failBody(res);
      const json = (await res.json()) as OpenAIResponse;
      return {
        text: json.choices?.[0]?.message?.content ?? "",
        model,
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
        },
      };
    },
  };
}

/** Anthropic Claude via the Messages REST API (no SDK dependency). */
export function createAnthropicGateway({ apiKey, model }: ProviderConfig): LLMGateway {
  return {
    model,
    async complete(req: LLMRequest): Promise<LLMResult> {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: req.maxOutputTokens ?? 4096,
          temperature: req.temperature ?? 0,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        }),
      });
      if (!res.ok) await failBody(res);
      const json = (await res.json()) as AnthropicResponse;
      const text = (json.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      return {
        text,
        model,
        usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
      };
    },
  };
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Google Gemini via the generateContent REST API (JSON response mode). */
export function createGeminiGateway({ apiKey, model }: ProviderConfig): LLMGateway {
  return {
    model,
    async complete(req: LLMRequest): Promise<LLMResult> {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.user }] }],
          generationConfig: {
            temperature: req.temperature ?? 0,
            maxOutputTokens: req.maxOutputTokens ?? 4096,
            responseMimeType: "application/json",
          },
        }),
      });
      if (!res.ok) await failBody(res);
      const json = (await res.json()) as GeminiResponse;
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      return {
        text,
        model,
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount,
          outputTokens: json.usageMetadata?.candidatesTokenCount,
        },
      };
    },
  };
}
