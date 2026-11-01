// REQ-AI-001 — OpenAI-compatible chat client for the local LLM (vLLM or llama.cpp server). No SDK:
// one fetch with a timeout, strict response parsing.
import { z } from 'zod';
import { ASSISTANT } from '@openmap/constants';
import type { Env } from '@openmap/config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).optional(),
});

export interface LlmClient {
  complete(messages: ChatMessage[]): Promise<{ text: string; promptTokens: number; completionTokens: number }>;
}

export function createLlmClient(env: Pick<Env, 'LLM_BASE_URL' | 'LLM_MODEL' | 'LLM_API_KEY' | 'LLM_TIMEOUT_MS'>, fetchImpl: typeof fetch = fetch): LlmClient {
  const endpoint = new URL('chat/completions', env.LLM_BASE_URL.endsWith('/') ? env.LLM_BASE_URL : env.LLM_BASE_URL + '/').toString();
  return {
    async complete(messages) {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, env.LLM_TIMEOUT_MS);
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LLM_API_KEY },
          body: JSON.stringify({ model: env.LLM_MODEL, messages, temperature: ASSISTANT.temperature, stream: false }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('LLM request failed with status ' + String(res.status));
        const parsed = responseSchema.parse(await res.json());
        const text = parsed.choices[0]?.message.content ?? '';
        return { text, promptTokens: parsed.usage?.prompt_tokens ?? 0, completionTokens: parsed.usage?.completion_tokens ?? 0 };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
