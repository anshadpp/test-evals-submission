import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runEval } from "../runner.ts";
import type { Extraction } from "@test-evals/llm";

const VALID: Extraction = {
  chief_complaint: "test",
  vitals: { bp: null, hr: null, temp_f: null, spo2: null },
  medications: [],
  diagnoses: [],
  plan: [],
  follow_up: { interval_days: null, reason: null },
};

function makeFixture(numCases: number) {
  const root = mkdtempSync(resolve(tmpdir(), "eval-test-"));
  mkdirSync(resolve(root, "data/transcripts"), { recursive: true });
  mkdirSync(resolve(root, "data/gold"), { recursive: true });
  for (let i = 1; i <= numCases; i++) {
    const id = `case_${String(i).padStart(3, "0")}`;
    writeFileSync(resolve(root, "data/transcripts", `${id}.txt`), `transcript ${i}`);
    writeFileSync(resolve(root, "data/gold", `${id}.json`), JSON.stringify(VALID));
  }
  return root;
}

function makeMockClient(behaviour: { failureCount?: number } = {}) {
  let calls = 0;
  let failures = 0;
  return {
    callCount: () => calls,
    client: {
      messages: {
        create: async () => {
          calls++;
          if (
            behaviour.failureCount !== undefined &&
            failures < behaviour.failureCount
          ) {
            failures++;
            const err: Error & { status?: number } = new Error("rate limited");
            err.status = 429;
            throw err;
          }
          return {
            content: [
              {
                type: "tool_use",
                id: `t-${calls}`,
                name: "record_extraction",
                input: VALID,
              },
            ],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 80,
              cache_read_input_tokens: 0,
            },
          };
        },
      },
    },
  };
}

describe("runner", () => {
  test("idempotency: cached extract is reused, no new client calls", async () => {
    const root = makeFixture(3);
    const mock1 = makeMockClient();
    await runEval({
      strategy: "zero_shot",
      client: mock1.client as never,
      dataDir: resolve(root, "data"),
      resultsDir: resolve(root, "results"),
      concurrency: 1,
    });
    expect(mock1.callCount()).toBe(3);

    // Second run: should hit the cache for every case, zero new API calls.
    const mock2 = makeMockClient();
    await runEval({
      strategy: "zero_shot",
      client: mock2.client as never,
      dataDir: resolve(root, "data"),
      resultsDir: resolve(root, "results"),
      concurrency: 1,
    });
    expect(mock2.callCount()).toBe(0);
  });

  test("resume: skips already-completed cases from state.json", async () => {
    const root = makeFixture(5);
    const mock1 = makeMockClient();
    const summary = await runEval({
      strategy: "zero_shot",
      client: mock1.client as never,
      dataDir: resolve(root, "data"),
      resultsDir: resolve(root, "results"),
      concurrency: 1,
    });
    expect(mock1.callCount()).toBe(5);

    // Wipe the cache so re-run would have to call the API again,
    // but state.json marks all 5 done -> no API calls should happen.
    const cacheDir = resolve(root, "results/cache");
    const fs = await import("node:fs");
    for (const f of fs.readdirSync(cacheDir)) {
      fs.unlinkSync(resolve(cacheDir, f));
    }

    const mock2 = makeMockClient();
    await runEval({
      strategy: "zero_shot",
      client: mock2.client as never,
      dataDir: resolve(root, "data"),
      resultsDir: resolve(root, "results"),
      runId: summary.run_id,
      resume: true,
      concurrency: 1,
    });
    expect(mock2.callCount()).toBe(0);
  });

  test("rate-limit backoff: 429 is retried", async () => {
    const root = makeFixture(1);
    const mock = makeMockClient({ failureCount: 1 });
    await runEval({
      strategy: "zero_shot",
      client: mock.client as never,
      dataDir: resolve(root, "data"),
      resultsDir: resolve(root, "results"),
      concurrency: 1,
    });
    // 1 failure + 1 success = 2 calls total
    expect(mock.callCount()).toBe(2);
  });

  test("summary: per-field averages and totals are computed", async () => {
    const root = makeFixture(2);
    const mock = makeMockClient();
    const summary = await runEval({
      strategy: "zero_shot",
      client: mock.client as never,
      dataDir: resolve(root, "data"),
      resultsDir: resolve(root, "results"),
      concurrency: 2,
    });
    expect(summary.total_cases).toBe(2);
    expect(summary.completed_cases).toBe(2);
    expect(summary.overall_avg).toBeGreaterThanOrEqual(0);
    expect(summary.overall_avg).toBeLessThanOrEqual(1);
    expect(summary.total_cost_usd).toBeGreaterThan(0);
    expect(Object.keys(summary.per_field_avg)).toContain("medications");
  });

  test("summary file is written and contains run_id", async () => {
    const root = makeFixture(1);
    const mock = makeMockClient();
    const summary = await runEval({
      strategy: "zero_shot",
      client: mock.client as never,
      dataDir: resolve(root, "data"),
      resultsDir: resolve(root, "results"),
      concurrency: 1,
    });
    const summaryFile = resolve(root, "results/runs", summary.run_id, "summary.json");
    const content = JSON.parse(readFileSync(summaryFile, "utf-8"));
    expect(content.run_id).toBe(summary.run_id);
  });
});
