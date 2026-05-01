# NOTES — HEALOSBENCH submission

## TL;DR

I built a CLI-first eval harness for the clinical-extraction task with all three prompt strategies (zero-shot, few-shot, CoT), tool-use-forced structured output, prompt caching, retry-with-feedback, a per-field metric suite, hallucination detection, semaphore-based concurrency, resumability, and idempotency. The web dashboard and Postgres persistence were de-scoped; rationale below.

## What runs from a clean clone

```
bun install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env
bun run eval -- --strategy=zero_shot
bun run eval -- --strategy=few_shot
bun run eval -- --strategy=cot
bun test
```

Each `eval` command writes per-case JSON to `results/runs/<run_id>/cases/`, a `summary.json`, and a `state.json` checkpoint. Re-running with `--resume=<run_id>` continues from where the previous run was killed; re-running without `--resume` reuses the per-case cache (idempotency) so you do not re-spend API tokens on cases already done.

## Architecture

```
packages/llm   — Anthropic SDK wrapper, prompt strategies, tool-use schema, retry-with-feedback, prompt caching
packages/eval  — per-field metrics, hallucination detector, runner (concurrency + checkpoints + cache), CLI
data/          — 50 transcripts, 50 gold extractions, schema.json (provided, unmodified)
results/       — runs/<run_id>/{summary,state,cases/*}; cache/ keyed by content hash
```

Existing monorepo packages (`apps/server`, `apps/web`, `packages/{db,auth,env,ui}`) are untouched. They are still installable and the workspace resolves cleanly; they're simply not on the eval path.

## Hard-requirement coverage

| # | Requirement | Where |
| --- | --- | --- |
| 1 | Tool use, no `JSON.parse` of free text | `packages/llm/src/extractor.ts` — `tool_choice: { type: "tool", name: "record_extraction" }` |
| 2 | Retry with validation feedback, capped at 3, all attempts logged | `extractor.ts` — `attempts[]` array; failures pushed back as `tool_result` with `is_error: true` |
| 3 | Prompt caching with verified `cache_read_input_tokens` | `prompts.ts` — `cache_control: { type: "ephemeral" }` on system blocks; surfaced in `summary.json.total_tokens` |
| 4 | Concurrency control, no naïve `Promise.all`, 429 handling | `runner.ts` — `runWithSemaphore` worker pool (default 5); `extractWithBackoff` exponential backoff on 429/529/503 |
| 5 | Resumable runs (with a test) | `runner.ts` — `state.json` is rewritten after each case; `--resume=<run_id>` skips completed; tested |
| 6 | Per-field metrics matched to field type | `metrics.ts` — fuzzy (chief_complaint), exact-with-tolerance (vitals), set-F1 with synonym normalization (medications, diagnoses, plan), mixed (follow_up) |
| 7 | Hallucination detection | `metrics.ts` — `detectHallucinations`; literal substring for numbers, sentence-level token-set similarity ≥ 0.5 for free text |
| 8 | Compare view that surfaces real signal | **CUT** — see "Cuts" below |
| 9 | ≥ 8 tests covering the listed scenarios | `packages/{llm,eval}/src/__tests__/*.test.ts` — 17 tests |
| 10 | API key not leaked to the browser | We don't have a browser. Key is loaded from `.env` only inside the CLI process |

## Methodology

### Extractor

Single function `extract({ transcript, strategy, client })` returns an `ExtractResult` with `prediction`, `attempts[]`, `total_tokens`, `cost_usd`, `prompt_hash`, `schema_valid`. The prompt is split into `system` blocks (cached via `cache_control`) and a single user message containing the transcript. Structured output is enforced by registering a `record_extraction` tool whose `input_schema` is the project schema (with `$schema/$id` stripped). `tool_choice` is forced to that tool. We never `JSON.parse` model text.

When `ajv` validation fails, the validation errors are sent back as a `tool_result` content block with `is_error: true`. The model self-corrects on attempt 2 in the typical case; we cap at 3 attempts.

The three strategies share the same base instructions:
- **zero_shot**: base instructions only.
- **cot**: base + a structured 6-bullet "first analyze, then call the tool" instruction. We rely on Claude emitting text content blocks before the forced tool_use, which it does.
- **few_shot**: base + two synthetic worked examples in a separate cached system block (so they don't count toward per-call cost after the first). Examples are deliberately *not* drawn from the test set to avoid overfitting.

Prompt content is content-hashed (sha256 of joined system blocks, first 16 chars) and stored on each result. A prompt edit produces a new hash, which the resume path enforces (you cannot resume a run after editing the prompt).

### Evaluator

Six metrics, one per field:

| Field | Metric |
| --- | --- |
| `chief_complaint` | Token-set similarity (Jaccard over content words after normalization) |
| `vitals` | Per-sub-field 0/1 with `temp_f` tolerance ±0.2°F; averaged |
| `medications` | Set-F1 via greedy best-match pairing on `name` token-set sim ≥ 0.6, with dose/frequency normalization (BID ↔ twice daily, "10 mg" ↔ "10mg"); penalty applied if dose or frequency disagrees, since drug-detail mismatch is the safety-relevant failure mode |
| `diagnoses` | Set-F1 by description fuzzy match; small bonus when ICD-10 also matches; ICD-10 attempt/correct rates tracked separately |
| `plan` | Set-F1 with token-set sim ≥ 0.6 |
| `follow_up` | `interval_days` exact match + token-set sim on `reason`; averaged |

Greedy pairing rather than Hungarian assignment: lists in this dataset are short (≤ ~6 items) and greedy is fine in practice.

### Hallucination detection

For each leaf value in the prediction, check it appears in the transcript:
- Vitals (numeric/string): literal substring match.
- Medication names and diagnosis descriptions: literal substring **or** sentence-level token-set similarity ≥ 0.5.

This is intentionally permissive (we'd rather under-flag than over-flag), and it explicitly does NOT validate that the *full* sentence in the transcript supports the prediction — only that some textual evidence exists. False negatives are possible (e.g. a clinically inferred diagnosis whose words don't appear in the transcript). We report `hallucination_rate` as count-per-case, not as a hard pass/fail.

### Runner

- `runWithSemaphore` is a fixed-size worker pool (default 5) reading from a shared queue. Not `Promise.all([...50])` — that would spike concurrency to whatever Anthropic's rate limit allows in one tick and look bursty.
- On 429 / 529 / 503, `extractWithBackoff` does exponential backoff with jitter, capped at 5 attempts. We do **not** rely on the SDK's built-in retries because we want visibility — the warning prints on every backoff.
- After each completed case, `state.json` is rewritten with the case ID appended to `completed[]`. Crashes or `Ctrl-C` lose at most the in-flight cases (≤ concurrency). On `--resume`, those in-flight cases re-run.
- The idempotency cache is keyed by `sha256(strategy | model | case_id | prompt_hash | sha256(transcript))`. Re-running with the same prompt hits the cache for every case and does zero network work.

## Results

Run on Haiku 4.5 (`claude-haiku-4-5-20251001`), 50 cases per strategy, concurrency 5, on 2026-05-01.

| Strategy | Overall F1 | Schema-fail | Hallucinations/case | Cost | Cache-read | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| **zero_shot** | **0.743** | 0% | 0.82 | $0.168 | 228,100 | 71.6s |
| few_shot | 0.739 | 0% | **0.66** | $0.173 | 260,860 | 293.6s |
| cot | 0.722 | 0% | **0.66** | $0.196 | 210,240 | 65.7s |

Total spend across all three strategies: **$0.54**, well under the $1 budget cap. Schema-failure rate was 0% on all three — every case extracted on attempt 1.

Per-field comparison (per-case averages):

| Field | zero_shot | few_shot | cot | Winner |
| --- | --- | --- | --- | --- |
| chief_complaint | 0.605 | **0.611** | 0.606 | few_shot (marginal) |
| vitals | **1.000** | **1.000** | **1.000** | tie (all perfect) |
| medications | **0.860** | 0.837 | 0.852 | zero_shot |
| diagnoses | 0.553 | **0.557** | 0.510 | few_shot (marginal) |
| plan | **0.752** | **0.752** | 0.710 | zero_shot / few_shot tie |
| follow_up | **0.687** | 0.675 | 0.653 | zero_shot |

## What surprised me

1. **Chain-of-thought scored worst overall.** I expected CoT to improve on `diagnoses` and `plan` (the multi-step reasoning fields). Instead it dropped F1 on both (`plan` 0.752 → 0.710, `diagnoses` 0.553 → 0.510). My read: forcing Haiku to write structured text before the tool call introduces *variance* — it commits to a phrasing in prose that then constrains the tool input. On structured extraction over short transcripts, that's net negative. CoT is not a default upgrade; it's a prompt strategy that rewards specific task shapes (multi-hop reasoning, math, ambiguous inputs), and clinical extraction here is not one of them.

2. **Few-shot didn't move overall F1 but cut hallucinations 20%** (0.82 → 0.66 per case) — same effect as CoT but with a much bigger latency cost. The mechanism is the same: the extra context teaches Haiku to be *conservative* about inferring ICD codes and medication routes. If hallucination is your safety-critical metric (it usually is in clinical settings), the small F1 difference matters less than the 20% drop in unsupported values. Few-shot wins for production.

3. **Few-shot is ~4× slower than zero-shot or CoT** (293s vs 71s/65s) despite the caching working perfectly. Cause: the larger cached prefix inflates per-call token counts even when read from cache (still counts toward tokens-per-minute), so we hit Anthropic's TPM ceiling sooner and backoff kicks in. Cache *cost* is essentially free; cache *throughput* is not.

4. **Vitals are perfect on every strategy.** All three scored 1.000. Haiku reads `[Vitals: BP 122/78, HR 88, ...]` blocks reliably; this field is essentially solved. In a real production prompt I would *shrink* my instructions for vitals (the model doesn't need the help) and reallocate tokens to harder fields.

5. **Diagnoses is the hardest field across all strategies (~0.55).** Two failure modes mixed together: (a) my fuzzy threshold (0.6) is strict for descriptions like "viral URI" vs "viral upper respiratory infection" where token-set similarity is genuinely below 0.6 despite clinical equivalence, and (b) Haiku occasionally guesses an ICD-10 code when the gold has none (or vice versa). A smarter description matcher (synonyms, abbreviations) would lift this number more than any prompt strategy did.

6. **Schema-failure rate was 0% on all three strategies, all 50 cases each.** Tool use plus a JSON-Schema-shaped `input_schema` is enough — the retry-with-feedback loop never had to fire on this dataset. I believe it would on harder transcripts; the test suite verifies the path works on synthetic invalid responses.

## Bottom line

For this task I would ship **few_shot** to production despite zero_shot's nominal F1 lead. The 20% reduction in hallucinations is the clinically-meaningful difference; F1 0.739 vs 0.743 is noise on N=50. The 4× latency cost is real but addressable — it's a rate-limit problem, not a per-call cost problem, and a Tier-2 account on Anthropic dissolves it.

## What I'd build next, in priority order

1. **Web dashboard** — Postgres-backed runs list, run detail with field-level diff, compare view with per-field winner highlighting. The data model is already shaped for it (every run writes `summary.json` + per-case JSONs).
2. **Active-learning hint** — surface the top-5 highest-disagreement cases between any two strategies. This is cheap once the compare view exists and would tell us which cases are worth re-annotating.
3. **Cost guardrail** — pre-flight token estimate vs a configurable cap before the run starts.
4. **Second model** (Sonnet 4.6) for cross-model comparison.
5. **Better hallucination detector** — run the prediction values through a separate Claude pass that asks "is this supported by the transcript? quote the supporting span." This would replace the current substring/Jaccard heuristic with something that surfaces the *grounding* itself.

## Cuts and why

- **Postgres persistence (`packages/db`).** The schema is already wired and would take ~30 minutes to map onto. I left it out because (a) the dashboard depends on it and the dashboard is itself cut, (b) file-based storage is sufficient for the CLI flow that the assignment scores on, and (c) it removes a dependency for the reviewer (no `bun run db:push` step). The cost is the absence of the compare view UI.
- **Web dashboard (`apps/web`).** This is the largest cut. The compare view is called out as the most important screen in the README, so I want to be transparent about the tradeoff. Given the time budget, I prioritized harness depth (every metric, every retry path, every concurrency edge) over a UI that consumes results. The CLI summary table prints per-field averages and the JSON outputs are dashboard-ready. With another four hours I would build the dashboard against the existing `summary.json` files; no schema migration needed.
- **Hono server / SSE streaming.** Same reasoning. The CLI doesn't need a long-running server, and resumability is provided by the file-based checkpoint without the complexity of HTTP.
- **better-auth.** Explicitly listed as optional in the README.

## Honest limitations

- Hallucination detection is heuristic. A clinically-inferred diagnosis ("anxiety" from "patient reports racing heart and worry") will be flagged if the words don't appear. The detector trades false-positives for simplicity.
- Set-F1 uses greedy pairing rather than Hungarian assignment. With longer lists this would mis-pair; for this dataset's list sizes it does not.
- The few-shot examples are synthetic. They are designed to be representative but they are not validated against the gold distribution; a real production setup would draw few-shot examples from a held-out slice of the gold set.
- I did not verify cache-write costs against the dashboard's reported numbers — the cost calculation uses the published Haiku 4.5 rates and the SDK's reported cache-creation tokens, but I have not cross-checked the resulting USD against a billing line.
