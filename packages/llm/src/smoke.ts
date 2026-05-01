import Anthropic from "@anthropic-ai/sdk";
import { setDefaultResultOrder } from "node:dns";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extract } from "./extractor.ts";
import type { Strategy } from "./types.ts";

// Some Windows networks drop IPv6 silently; force IPv4 first to avoid
// "ConnectionRefused" stalls when DNS returns an AAAA record.
setDefaultResultOrder("ipv4first");

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set. Add it to .env at the repo root.");
    process.exit(1);
  }

  const strategy = (process.argv[2] ?? "zero_shot") as Strategy;
  const caseId = process.argv[3] ?? "case_001";

  const transcript = readFileSync(
    resolve(import.meta.dir, "../../../data/transcripts", `${caseId}.txt`),
    "utf-8",
  );

  const client = new Anthropic({ apiKey });

  console.log(`> running extract: strategy=${strategy} case=${caseId}\n`);

  // First call — should produce cache_creation_input_tokens > 0.
  const first = await extract({ transcript, strategy, client });
  printResult("call 1", first);

  // Second call on a different transcript - exercises the cached system prompt.
  const otherCase = caseId === "case_001" ? "case_002" : "case_001";
  const transcript2 = readFileSync(
    resolve(import.meta.dir, "../../../data/transcripts", `${otherCase}.txt`),
    "utf-8",
  );
  const second = await extract({ transcript: transcript2, strategy, client });
  printResult(`call 2 (${otherCase})`, second);

  if (second.total_tokens.cache_read_input_tokens === 0) {
    console.warn(
      "\n⚠ cache_read_input_tokens was 0 on call 2 — caching may not be hitting. Check that cache_control is set on system blocks.",
    );
  } else {
    console.log(
      `\n✓ caching verified: call 2 read ${second.total_tokens.cache_read_input_tokens} cached input tokens`,
    );
  }
}

function printResult(label: string, r: Awaited<ReturnType<typeof extract>>) {
  console.log(`--- ${label} ---`);
  console.log(`schema_valid: ${r.schema_valid}`);
  console.log(`attempts:     ${r.attempts.length}`);
  console.log(`tokens:       ${JSON.stringify(r.total_tokens)}`);
  console.log(`cost_usd:     $${r.cost_usd.toFixed(6)}`);
  console.log(`duration_ms:  ${r.total_duration_ms}`);
  console.log(`prompt_hash:  ${r.prompt_hash}`);
  if (r.prediction) {
    console.log("prediction:");
    console.log(JSON.stringify(r.prediction, null, 2));
  } else {
    console.log("prediction:   <none — all attempts failed>");
    console.log("attempt errors:");
    for (const a of r.attempts) {
      console.log(`  attempt ${a.attempt_number}: ${a.validation_errors.join("; ")}`);
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
