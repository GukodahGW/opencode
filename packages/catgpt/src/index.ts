/**
 * @opencode-ai/catgpt — opencode provider for the CatGPT browser-backed gateway.
 *
 * CatGPT-Gateway exposes an OpenAI-compatible /v1/chat/completions endpoint
 * backed by a real ChatGPT browser session. Because CatGPT is a chat model
 * (not a strict tool caller), this adapter:
 *
 *  - Wraps `@ai-sdk/openai-compatible` so opencode gets a familiar
 *    `LanguageModelV3` for streaming + tool calls.
 *  - Rewrites non-image attachments coming through the AI SDK as
 *    `image_url` data URLs into CatGPT's `{type:"file", file:...}` content
 *    parts, which the gateway accepts directly.
 *  - Leaves tool-choice, fresh-thread-per-request, and strict-retry handling
 *    to the gateway server (CatGPT-Gateway already implements them) so this
 *    package stays a thin transport adapter.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { FetchFunction } from "@ai-sdk/provider-utils"

export interface CatgptProviderSettings {
  /** Base URL of the CatGPT gateway. Defaults to http://localhost:8000/v1. */
  baseURL?: string
  /** Bearer token sent as `Authorization`. Maps to gateway's API_TOKEN. */
  apiKey?: string
  /** Provider name used internally (defaults to "catgpt"). */
  name?: string
  /** Extra headers merged into every request. */
  headers?: Record<string, string>
  /** Custom fetch implementation. */
  fetch?: FetchFunction
}

export interface CatgptProvider {
  (modelId: string): LanguageModelV3
  chat(modelId: string): LanguageModelV3
  languageModel(modelId: string): LanguageModelV3
}

const DEFAULT_BASE_URL = "http://localhost:8000/v1"

function inferMimeFromDataUrl(url: string): string | undefined {
  const match = /^data:([^;,]+)/.exec(url)
  return match?.[1]
}

function isImageMime(mime: string | undefined): boolean {
  return !!mime && mime.startsWith("image/")
}

/**
 * Convert an AI-SDK content part array into a shape CatGPT-Gateway expects.
 *
 * The AI SDK's openai-compatible serializer maps file attachments to
 * `image_url` content parts with data URLs. CatGPT-Gateway treats those as
 * images, so for non-image MIME types (PDF, plain text, docx, …) we rewrite
 * them to the gateway's first-class file part:
 *
 *   { type: "file", file: { filename, url|data, mime_type } }
 */
function rewriteContentParts(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  return content.map((part) => {
    if (!part || typeof part !== "object") return part
    const p = part as Record<string, unknown>
    if (p.type !== "image_url") return part
    const imageUrl = p.image_url as { url?: string; filename?: string } | undefined
    const url = imageUrl?.url
    if (typeof url !== "string" || !url.startsWith("data:")) return part
    const mime = inferMimeFromDataUrl(url)
    if (isImageMime(mime)) return part
    return {
      type: "file",
      file: {
        filename: imageUrl?.filename ?? "attachment",
        url,
        mime_type: mime ?? "application/octet-stream",
      },
    }
  })
}

function transformBody(body: unknown): unknown {
  if (!body || typeof body !== "object") return body
  const b = body as { messages?: Array<{ content?: unknown }> }
  if (!Array.isArray(b.messages)) return body
  return {
    ...b,
    messages: b.messages.map((m) => ({
      ...m,
      content: rewriteContentParts(m.content),
    })),
  }
}

function makeFetch(inner?: FetchFunction): FetchFunction {
  const upstream = (inner ?? globalThis.fetch.bind(globalThis)) as FetchFunction
  return async (input, init) => {
    if (init?.body && typeof init.body === "string") {
      try {
        const parsed = JSON.parse(init.body)
        const transformed = transformBody(parsed)
        return upstream(input, { ...init, body: JSON.stringify(transformed) })
      } catch {
        // Non-JSON body — pass through unchanged.
      }
    }
    return upstream(input, init)
  }
}

/**
 * Create a CatGPT provider instance.
 *
 * @example
 *   const catgpt = createCatgpt({
 *     baseURL: "http://localhost:8000/v1",
 *     apiKey: process.env.CATGPT_API_TOKEN,
 *   })
 *   const model = catgpt.languageModel("catgpt-browser")
 */
export function createCatgpt(
  options: CatgptProviderSettings = {},
): CatgptProvider {
  const inner = createOpenAICompatible({
    name: options.name ?? "catgpt",
    baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: makeFetch(options.fetch),
  })

  // The openai-compatible factory exposes both `.chatModel` and
  // `.languageModel`. Normalize so opencode (which calls `.languageModel`)
  // and any callsite reaching for `.chat` both resolve to the chat path.
  const inn = inner as unknown as Record<string, (id: string) => LanguageModelV3>
  const chatModel = (id: string): LanguageModelV3 => {
    if (typeof inn.languageModel === "function") return inn.languageModel(id)
    if (typeof inn.chatModel === "function") return inn.chatModel(id)
    if (typeof inn.chat === "function") return inn.chat(id)
    throw new Error("openai-compatible provider exposes no language-model factory")
  }

  const provider: CatgptProvider = ((id: string) => chatModel(id)) as CatgptProvider
  provider.chat = chatModel
  provider.languageModel = chatModel
  return provider
}

export default createCatgpt
