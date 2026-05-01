import type { TokenUsage } from "./types.ts";

type ModelPricing = {
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
};

const PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5-20251001": {
    input_per_mtok: 1.0,
    output_per_mtok: 5.0,
    cache_write_per_mtok: 1.25,
    cache_read_per_mtok: 0.1,
  },
};

export function costUsd(model: string, t: TokenUsage): number {
  const p = PRICING[model];
  if (!p) return 0;
  const m = 1_000_000;
  return (
    (t.input_tokens * p.input_per_mtok) / m +
    (t.output_tokens * p.output_per_mtok) / m +
    (t.cache_creation_input_tokens * p.cache_write_per_mtok) / m +
    (t.cache_read_input_tokens * p.cache_read_per_mtok) / m
  );
}

export function emptyTokens(): TokenUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
}
