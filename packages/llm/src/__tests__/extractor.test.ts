import { describe, expect, test } from "bun:test";
import { extract } from "../extractor.ts";
import { systemHashSource } from "../prompts.ts";
import type { Extraction } from "../types.ts";

const VALID_EXTRACTION: Extraction = {
  chief_complaint: "headache",
  vitals: { bp: null, hr: null, temp_f: null, spo2: null },
  medications: [],
  diagnoses: [],
  plan: [],
  follow_up: { interval_days: null, reason: null },
};

function makeClient(responses: Array<unknown>) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const r = responses[i++];
        if (!r) throw new Error("mock client: ran out of responses");
        return r;
      },
    },
  } as unknown as Parameters<typeof extract>[0]["client"];
}

describe("extractor", () => {
  test("succeeds in one attempt when tool input is schema-valid", async () => {
    const client = makeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "record_extraction",
            input: VALID_EXTRACTION,
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: 80,
          cache_read_input_tokens: 0,
        },
      },
    ]);
    const r = await extract({ transcript: "x", strategy: "zero_shot", client });
    expect(r.schema_valid).toBe(true);
    expect(r.attempts.length).toBe(1);
    expect(r.prediction).toEqual(VALID_EXTRACTION);
  });

  test("retry-with-feedback: invalid first response triggers second call", async () => {
    const client = makeClient([
      {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "record_extraction",
            input: { foo: "bar" },
          },
        ],
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 80,
          cache_read_input_tokens: 0,
        },
      },
      {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "record_extraction",
            input: VALID_EXTRACTION,
          },
        ],
        usage: {
          input_tokens: 200,
          output_tokens: 20,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 80,
        },
      },
    ]);
    const r = await extract({ transcript: "x", strategy: "zero_shot", client });
    expect(r.schema_valid).toBe(true);
    expect(r.attempts.length).toBe(2);
    expect(r.attempts[0]!.validation_errors.length).toBeGreaterThan(0);
    expect(r.total_tokens.cache_read_input_tokens).toBe(80);
  });

  test("caps at 3 attempts and returns null prediction when never valid", async () => {
    const bad = {
      content: [
        {
          type: "tool_use",
          id: "t",
          name: "record_extraction",
          input: { foo: "bar" },
        },
      ],
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    const client = makeClient([bad, bad, bad]);
    const r = await extract({ transcript: "x", strategy: "zero_shot", client });
    expect(r.schema_valid).toBe(false);
    expect(r.prediction).toBe(null);
    expect(r.attempts.length).toBe(3);
  });

  test("prompt hash is stable for the same strategy and differs across strategies", () => {
    expect(systemHashSource("zero_shot")).toBe(systemHashSource("zero_shot"));
    expect(systemHashSource("zero_shot")).not.toBe(systemHashSource("few_shot"));
    expect(systemHashSource("zero_shot")).not.toBe(systemHashSource("cot"));
  });
});
