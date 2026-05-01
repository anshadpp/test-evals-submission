import Anthropic from "@anthropic-ai/sdk";
import {
  addTokens,
  costUsd,
  emptyTokens,
  extract,
  systemHashSource,
  type ExtractResult,
  type Extraction,
  type Strategy,
  type TokenUsage,
} from "@test-evals/llm";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { scoreCase, type CaseScore } from "./metrics.ts";

export type CaseResult = {
  case_id: string;
  extract: ExtractResult;
  score: CaseScore;
};

export type RunSummary = {
  run_id: string;
  strategy: Strategy;
  model: string;
  prompt_hash: string;
  started_at: string;
  finished_at: string | null;
  total_cases: number;
  completed_cases: number;
  schema_failure_rate: number;
  hallucination_rate: number;
  per_field_avg: Record<string, number>;
  overall_avg: number;
  total_tokens: TokenUsage;
  total_cost_usd: number;
  wall_time_ms: number;
};

export type RunnerOptions = {
  strategy: Strategy;
  model?: string;
  client: Anthropic;
  dataDir: string;
  resultsDir: string;
  caseFilter?: (caseId: string) => boolean;
  concurrency?: number;
  runId?: string;
  resume?: boolean;
  onCaseComplete?: (r: CaseResult) => void;
};

export async function runEval(opts: RunnerOptions): Promise<RunSummary> {
  const model = opts.model ?? "claude-haiku-4-5-20251001";
  const concurrency = opts.concurrency ?? 5;
  const runId = opts.runId ?? newRunId(opts.strategy);
  const runDir = resolve(opts.resultsDir, "runs", runId);
  const cacheDir = resolve(opts.resultsDir, "cache");
  ensureDir(runDir);
  ensureDir(resolve(runDir, "cases"));
  ensureDir(cacheDir);

  const promptHash = hashStr(systemHashSource(opts.strategy));
  const allCases = listCases(opts.dataDir).filter(
    opts.caseFilter ?? (() => true),
  );

  const stateFile = resolve(runDir, "state.json");
  const state: RunState = opts.resume && existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf-8"))
    : {
        run_id: runId,
        strategy: opts.strategy,
        model,
        prompt_hash: promptHash,
        started_at: new Date().toISOString(),
        completed: [],
      };

  if (state.prompt_hash !== promptHash) {
    throw new Error(
      `prompt hash changed since last run (was ${state.prompt_hash}, now ${promptHash}). Start a new run instead of resuming.`,
    );
  }

  writeJson(stateFile, state);

  const pending = allCases.filter((c) => !state.completed.includes(c));
  const startedAt = Date.now();
  const results: CaseResult[] = [];

  // Load previously completed results so the summary covers everything.
  for (const cid of state.completed) {
    const path = resolve(runDir, "cases", `${cid}.json`);
    if (existsSync(path)) {
      results.push(JSON.parse(readFileSync(path, "utf-8")));
    }
  }

  await runWithSemaphore(pending, concurrency, async (caseId) => {
    const transcript = readFileSync(
      resolve(opts.dataDir, "transcripts", `${caseId}.txt`),
      "utf-8",
    );
    const gold = JSON.parse(
      readFileSync(resolve(opts.dataDir, "gold", `${caseId}.json`), "utf-8"),
    ) as Extraction;

    const cacheKey = idempotencyKey({
      strategy: opts.strategy,
      model,
      caseId,
      promptHash,
      transcript,
    });
    const cachePath = resolve(cacheDir, `${cacheKey}.json`);

    let extractResult: ExtractResult;
    if (existsSync(cachePath)) {
      extractResult = JSON.parse(readFileSync(cachePath, "utf-8"));
    } else {
      extractResult = await extractWithBackoff({
        transcript,
        strategy: opts.strategy,
        client: opts.client,
        model,
      });
      writeJson(cachePath, extractResult);
    }

    const score = scoreCase({
      case_id: caseId,
      prediction: extractResult.prediction,
      gold,
      transcript,
    });
    const cr: CaseResult = { case_id: caseId, extract: extractResult, score };
    writeJson(resolve(runDir, "cases", `${caseId}.json`), cr);

    state.completed.push(caseId);
    writeJson(stateFile, state);
    results.push(cr);
    opts.onCaseComplete?.(cr);
  });

  const summary = aggregate({
    runId,
    strategy: opts.strategy,
    model,
    promptHash,
    startedAt: state.started_at,
    wallTimeMs: Date.now() - startedAt,
    results,
  });
  writeJson(resolve(runDir, "summary.json"), summary);
  return summary;
}

type RunState = {
  run_id: string;
  strategy: Strategy;
  model: string;
  prompt_hash: string;
  started_at: string;
  completed: string[];
};

async function extractWithBackoff(
  args: Parameters<typeof extract>[0],
): Promise<ExtractResult> {
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await extract(args);
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      const isRateLimit = err.status === 429;
      const isOverloaded = err.status === 529 || err.status === 503;
      if ((isRateLimit || isOverloaded) && attempt < 4) {
        const wait = delay + Math.random() * delay;
        console.warn(
          `[runner] ${err.status} after attempt ${attempt + 1}, backing off ${Math.round(wait)}ms`,
        );
        await sleep(wait);
        delay *= 2;
        continue;
      }
      throw e;
    }
  }
  throw new Error("extract: unreachable");
}

async function runWithSemaphore<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(
      (async () => {
        while (true) {
          const item = queue.shift();
          if (item === undefined) return;
          await fn(item);
        }
      })(),
    );
  }
  await Promise.all(workers);
}

function listCases(dataDir: string): string[] {
  const tdir = resolve(dataDir, "transcripts");
  return readdirSync(tdir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => f.replace(/\.txt$/, ""))
    .sort();
}

function idempotencyKey(args: {
  strategy: Strategy;
  model: string;
  caseId: string;
  promptHash: string;
  transcript: string;
}): string {
  return hashStr(
    [
      args.strategy,
      args.model,
      args.caseId,
      args.promptHash,
      hashStr(args.transcript).slice(0, 8),
    ].join("|"),
  );
}

function hashStr(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function newRunId(strategy: Strategy): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `${ts}_${strategy}`;
}

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true });
}

function writeJson(path: string, value: unknown) {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function aggregate(args: {
  runId: string;
  strategy: Strategy;
  model: string;
  promptHash: string;
  startedAt: string;
  wallTimeMs: number;
  results: CaseResult[];
}): RunSummary {
  const totalCases = args.results.length;
  let schemaFails = 0;
  let totalHallucinations = 0;
  let tokens = emptyTokens();
  const fieldSums: Record<string, number> = {
    chief_complaint: 0,
    vitals: 0,
    medications: 0,
    diagnoses: 0,
    plan: 0,
    follow_up: 0,
  };
  let overallSum = 0;

  for (const r of args.results) {
    if (r.score.schema_invalid) schemaFails++;
    totalHallucinations += r.score.hallucinations.length;
    tokens = addTokens(tokens, r.extract.total_tokens);
    fieldSums.chief_complaint! += r.score.per_field.chief_complaint.score;
    fieldSums.vitals! += r.score.per_field.vitals.score;
    fieldSums.medications! += r.score.per_field.medications.score;
    fieldSums.diagnoses! += r.score.per_field.diagnoses.score;
    fieldSums.plan! += r.score.per_field.plan.score;
    fieldSums.follow_up! += r.score.per_field.follow_up.score;
    overallSum += r.score.overall;
  }

  const perFieldAvg: Record<string, number> = {};
  for (const [k, v] of Object.entries(fieldSums)) {
    perFieldAvg[k] = totalCases === 0 ? 0 : v / totalCases;
  }

  return {
    run_id: args.runId,
    strategy: args.strategy,
    model: args.model,
    prompt_hash: args.promptHash,
    started_at: args.startedAt,
    finished_at: new Date().toISOString(),
    total_cases: totalCases,
    completed_cases: totalCases,
    schema_failure_rate: totalCases === 0 ? 0 : schemaFails / totalCases,
    hallucination_rate:
      totalCases === 0 ? 0 : totalHallucinations / totalCases,
    per_field_avg: perFieldAvg,
    overall_avg: totalCases === 0 ? 0 : overallSum / totalCases,
    total_tokens: tokens,
    total_cost_usd: costUsd(args.model, tokens),
    wall_time_ms: args.wallTimeMs,
  };
}
