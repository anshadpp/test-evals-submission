import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { addTokens, costUsd, emptyTokens } from "./cost.ts";
import { systemBlocksFor, systemHashSource } from "./prompts.ts";
import { toolInputSchema, validateExtraction } from "./schema.ts";
import type {
  ExtractAttempt,
  ExtractResult,
  Extraction,
  Strategy,
  TokenUsage,
} from "./types.ts";

const TOOL_NAME = "record_extraction";
const MAX_ATTEMPTS = 3;

export type ExtractOptions = {
  transcript: string;
  strategy: Strategy;
  client: Anthropic;
  model?: string;
  maxAttempts?: number;
};

export async function extract(opts: ExtractOptions): Promise<ExtractResult> {
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const system = systemBlocksFor(opts.strategy);
  const promptHash = hash(systemHashSource(opts.strategy));

  const tools: Anthropic.Tool[] = [
    {
      name: TOOL_NAME,
      description:
        "Record the structured clinical extraction. Call this exactly once with the JSON conforming to the schema.",
      input_schema: toolInputSchema() as Anthropic.Tool["input_schema"],
    },
  ];

  // Conversation history grows on each retry: the assistant's tool_use plus
  // a user tool_result reporting the validation errors.
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Transcript:\n\n${opts.transcript}` },
  ];

  const attempts: ExtractAttempt[] = [];
  let totalTokens: TokenUsage = emptyTokens();
  let prediction: Extraction | null = null;
  let schemaValid = false;
  const startedAt = Date.now();

  for (let i = 1; i <= maxAttempts; i++) {
    const t0 = Date.now();
    const response = await opts.client.messages.create({
      model,
      max_tokens: 2048,
      system,
      tools,
      tool_choice: { type: "tool", name: TOOL_NAME },
      messages,
    });

    const usage: TokenUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    };
    totalTokens = addTokens(totalTokens, usage);

    const toolUse = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (!toolUse) {
      attempts.push({
        attempt_number: i,
        raw_tool_input: null,
        validation_errors: ["model returned no tool_use block"],
        tokens: usage,
        duration_ms: Date.now() - t0,
      });
      // No tool call — append the response and ask to retry via a synthetic user nudge.
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content:
          "You did not call the record_extraction tool. Call it now with the structured JSON.",
      });
      continue;
    }

    const { valid, errors } = validateExtraction(toolUse.input);
    attempts.push({
      attempt_number: i,
      raw_tool_input: toolUse.input,
      validation_errors: valid ? [] : errors,
      tokens: usage,
      duration_ms: Date.now() - t0,
    });

    if (valid) {
      prediction = toolUse.input as Extraction;
      schemaValid = true;
      break;
    }

    // Feed validation errors back as a tool_result so the model self-corrects.
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUse.id,
          is_error: true,
          content: `Schema validation failed:\n${errors.map((e) => `- ${e}`).join("\n")}\n\nFix these issues and call record_extraction again.`,
        },
      ],
    });
  }

  return {
    prediction,
    schema_valid: schemaValid,
    attempts,
    total_tokens: totalTokens,
    total_duration_ms: Date.now() - startedAt,
    cost_usd: costUsd(model, totalTokens),
    prompt_hash: promptHash,
    strategy: opts.strategy,
    model,
  };
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
