import Anthropic from "@anthropic-ai/sdk";
import type { Strategy } from "@test-evals/llm";
import { setDefaultResultOrder } from "node:dns";
import { resolve } from "node:path";
import { runEval, type RunSummary } from "./runner.ts";

// IPv4 first: avoids hangs on networks that don't route IPv6.
setDefaultResultOrder("ipv4first");

type Args = {
  strategy: Strategy;
  model?: string;
  resume?: string;
  filter?: string;
  concurrency?: number;
  limit?: number;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (const a of argv) {
    if (a.startsWith("--strategy=")) out.strategy = a.slice("--strategy=".length) as Strategy;
    else if (a.startsWith("--model=")) out.model = a.slice("--model=".length);
    else if (a.startsWith("--resume=")) out.resume = a.slice("--resume=".length);
    else if (a.startsWith("--filter=")) out.filter = a.slice("--filter=".length);
    else if (a.startsWith("--concurrency=")) out.concurrency = Number(a.slice("--concurrency=".length));
    else if (a.startsWith("--limit=")) out.limit = Number(a.slice("--limit=".length));
  }
  if (!out.strategy) {
    console.error("Usage: bun run eval -- --strategy=<zero_shot|few_shot|cot> [--model=...] [--resume=<run_id>] [--filter=substring] [--concurrency=N] [--limit=N]");
    process.exit(2);
  }
  if (!["zero_shot", "few_shot", "cot"].includes(out.strategy)) {
    console.error(`Unknown strategy: ${out.strategy}`);
    process.exit(2);
  }
  return out as Args;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set. Add it to .env at the repo root.");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const dataDir = resolve(import.meta.dir, "../../../data");
  const resultsDir = resolve(import.meta.dir, "../../../results");

  const client = new Anthropic({ apiKey });

  let total = 0;
  const startWall = Date.now();
  const summary = await runEval({
    strategy: args.strategy,
    model: args.model,
    client,
    dataDir,
    resultsDir,
    runId: args.resume,
    resume: !!args.resume,
    concurrency: args.concurrency ?? 5,
    caseFilter: buildFilter(args.filter, args.limit),
    onCaseComplete: (cr) => {
      total++;
      const elapsed = ((Date.now() - startWall) / 1000).toFixed(1);
      const status = cr.score.schema_invalid ? "SCHEMA_FAIL" : `f1=${cr.score.overall.toFixed(3)}`;
      const halls = cr.score.hallucinations.length;
      console.log(
        `[${elapsed}s] ${cr.case_id}: ${status} attempts=${cr.extract.attempts.length} halls=${halls} cost=$${cr.extract.cost_usd.toFixed(5)}`,
      );
    },
  });

  printSummary(summary);
}

function buildFilter(filter?: string, limit?: number): ((id: string) => boolean) | undefined {
  if (!filter && !limit) return undefined;
  let count = 0;
  return (id) => {
    if (filter && !id.includes(filter)) return false;
    if (limit && count >= limit) return false;
    count++;
    return true;
  };
}

function printSummary(s: RunSummary) {
  const line = "─".repeat(72);
  console.log(`\n${line}`);
  console.log(`RUN ${s.run_id}`);
  console.log(`strategy=${s.strategy}  model=${s.model}  prompt=${s.prompt_hash}`);
  console.log(line);
  console.log(`Cases:                ${s.completed_cases}/${s.total_cases}`);
  console.log(`Overall F1 (avg):     ${s.overall_avg.toFixed(3)}`);
  console.log(`Schema failure rate:  ${(s.schema_failure_rate * 100).toFixed(1)}%`);
  console.log(`Hallucinations/case:  ${s.hallucination_rate.toFixed(2)}`);
  console.log(`Wall time:            ${(s.wall_time_ms / 1000).toFixed(1)}s`);
  console.log(`Total cost:           $${s.total_cost_usd.toFixed(4)}`);
  console.log(`Tokens (in/out):      ${s.total_tokens.input_tokens}/${s.total_tokens.output_tokens}`);
  console.log(`Cache (read/write):   ${s.total_tokens.cache_read_input_tokens}/${s.total_tokens.cache_creation_input_tokens}`);
  console.log(line);
  console.log("Per-field averages:");
  for (const [k, v] of Object.entries(s.per_field_avg)) {
    console.log(`  ${k.padEnd(18)} ${v.toFixed(3)}`);
  }
  console.log(line);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
