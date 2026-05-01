import type {
  Diagnosis,
  Extraction,
  Medication,
  Vitals,
} from "@test-evals/llm";
import {
  normalizeDose,
  normalizeFrequency,
  normalizeRoute,
  normalizeText,
  tokenSetSimilarity,
} from "./normalize.ts";

export type ScoreDetail = Record<string, unknown>;

export type FieldScore = {
  score: number;
  detail: ScoreDetail;
};

const FUZZY_THRESHOLD = 0.6;

export function scoreChiefComplaint(pred: string, gold: string): FieldScore {
  const sim = tokenSetSimilarity(pred, gold);
  return { score: sim, detail: { token_set_sim: sim } };
}

export function scoreVitals(pred: Vitals, gold: Vitals): FieldScore {
  const subs: Record<string, number> = {};

  subs.bp = pred.bp === gold.bp ? 1 : 0;
  subs.hr = pred.hr === gold.hr ? 1 : 0;
  subs.spo2 = pred.spo2 === gold.spo2 ? 1 : 0;

  if (pred.temp_f === null && gold.temp_f === null) subs.temp_f = 1;
  else if (pred.temp_f === null || gold.temp_f === null) subs.temp_f = 0;
  else subs.temp_f = Math.abs(pred.temp_f - gold.temp_f) <= 0.2 ? 1 : 0;

  const score =
    (subs.bp! + subs.hr! + subs.spo2! + subs.temp_f!) / 4;
  return { score, detail: { sub_field: subs } };
}

type SetMatchResult = {
  precision: number;
  recall: number;
  f1: number;
  matches: { pred_idx: number; gold_idx: number; sim: number }[];
  unmatched_pred: number[];
  unmatched_gold: number[];
};

function setF1<P, G>(
  preds: P[],
  golds: G[],
  similarity: (p: P, g: G) => number,
  threshold = FUZZY_THRESHOLD,
): SetMatchResult {
  if (preds.length === 0 && golds.length === 0) {
    return {
      precision: 1,
      recall: 1,
      f1: 1,
      matches: [],
      unmatched_pred: [],
      unmatched_gold: [],
    };
  }

  // Greedy best-match pairing. For our small lists (<=10 items) this is fine
  // and avoids the complexity of Hungarian assignment.
  type Pair = { pred_idx: number; gold_idx: number; sim: number };
  const allPairs: Pair[] = [];
  for (let i = 0; i < preds.length; i++) {
    for (let j = 0; j < golds.length; j++) {
      const sim = similarity(preds[i]!, golds[j]!);
      if (sim >= threshold) allPairs.push({ pred_idx: i, gold_idx: j, sim });
    }
  }
  allPairs.sort((a, b) => b.sim - a.sim);

  const usedPred = new Set<number>();
  const usedGold = new Set<number>();
  const matches: Pair[] = [];
  for (const p of allPairs) {
    if (!usedPred.has(p.pred_idx) && !usedGold.has(p.gold_idx)) {
      usedPred.add(p.pred_idx);
      usedGold.add(p.gold_idx);
      matches.push(p);
    }
  }

  const tp = matches.length;
  const precision = preds.length === 0 ? 1 : tp / preds.length;
  const recall = golds.length === 0 ? 1 : tp / golds.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const unmatched_pred = [...preds.keys()].filter((i) => !usedPred.has(i));
  const unmatched_gold = [...golds.keys()].filter((i) => !usedGold.has(i));

  return { precision, recall, f1, matches, unmatched_pred, unmatched_gold };
}

function medicationSimilarity(p: Medication, g: Medication): number {
  const nameSim = tokenSetSimilarity(p.name, g.name);
  if (nameSim < FUZZY_THRESHOLD) return 0;
  const doseMatch = normalizeDose(p.dose) === normalizeDose(g.dose);
  const freqMatch = normalizeFrequency(p.frequency) === normalizeFrequency(g.frequency);
  // Heavy penalty if dose or frequency disagrees, since drug-mismatch is the
  // safety-relevant failure mode.
  const detailMatch = (doseMatch ? 1 : 0) + (freqMatch ? 1 : 0);
  if (detailMatch === 0) return nameSim * 0.4;
  if (detailMatch === 1) return nameSim * 0.7;
  return nameSim;
}

export function scoreMedications(
  preds: Medication[],
  golds: Medication[],
): FieldScore {
  const r = setF1(preds, golds, medicationSimilarity);
  return {
    score: r.f1,
    detail: {
      precision: r.precision,
      recall: r.recall,
      matches: r.matches.length,
      unmatched_pred: r.unmatched_pred,
      unmatched_gold: r.unmatched_gold,
    },
  };
}

function diagnosisSimilarity(p: Diagnosis, g: Diagnosis): number {
  const sim = tokenSetSimilarity(p.description, g.description);
  if (sim < FUZZY_THRESHOLD) return 0;
  // Bonus for matching ICD-10 — small, since description is the primary signal.
  if (p.icd10 && g.icd10 && p.icd10 === g.icd10) {
    return Math.min(1, sim + 0.05);
  }
  return sim;
}

export function scoreDiagnoses(
  preds: Diagnosis[],
  golds: Diagnosis[],
): FieldScore {
  const r = setF1(preds, golds, diagnosisSimilarity);
  // Track ICD-10 agreement separately for reporting.
  let icd10_correct = 0;
  let icd10_attempts = 0;
  for (const m of r.matches) {
    const p = preds[m.pred_idx]!;
    const g = golds[m.gold_idx]!;
    if (p.icd10) {
      icd10_attempts++;
      if (g.icd10 && p.icd10 === g.icd10) icd10_correct++;
    }
  }
  return {
    score: r.f1,
    detail: {
      precision: r.precision,
      recall: r.recall,
      matches: r.matches.length,
      icd10_correct,
      icd10_attempts,
    },
  };
}

export function scorePlan(preds: string[], golds: string[]): FieldScore {
  const r = setF1(preds, golds, (p, g) => tokenSetSimilarity(p, g));
  return {
    score: r.f1,
    detail: {
      precision: r.precision,
      recall: r.recall,
      matches: r.matches.length,
    },
  };
}

export function scoreFollowUp(
  pred: { interval_days: number | null; reason: string | null },
  gold: { interval_days: number | null; reason: string | null },
): FieldScore {
  const intervalMatch = pred.interval_days === gold.interval_days ? 1 : 0;
  const pr = pred.reason ?? "";
  const gr = gold.reason ?? "";
  const reasonScore =
    pr === "" && gr === "" ? 1 : pr === "" || gr === "" ? 0 : tokenSetSimilarity(pr, gr);
  const score = (intervalMatch + reasonScore) / 2;
  return {
    score,
    detail: { interval_match: intervalMatch === 1, reason_sim: reasonScore },
  };
}

export type CaseScore = {
  case_id: string;
  per_field: {
    chief_complaint: FieldScore;
    vitals: FieldScore;
    medications: FieldScore;
    diagnoses: FieldScore;
    plan: FieldScore;
    follow_up: FieldScore;
  };
  overall: number;
  schema_invalid: boolean;
  hallucinations: string[];
};

export function scoreCase(opts: {
  case_id: string;
  prediction: Extraction | null;
  gold: Extraction;
  transcript: string;
}): CaseScore {
  const ZERO: FieldScore = { score: 0, detail: { reason: "no prediction" } };
  if (!opts.prediction) {
    return {
      case_id: opts.case_id,
      per_field: {
        chief_complaint: ZERO,
        vitals: ZERO,
        medications: ZERO,
        diagnoses: ZERO,
        plan: ZERO,
        follow_up: ZERO,
      },
      overall: 0,
      schema_invalid: true,
      hallucinations: [],
    };
  }

  const per_field = {
    chief_complaint: scoreChiefComplaint(
      opts.prediction.chief_complaint,
      opts.gold.chief_complaint,
    ),
    vitals: scoreVitals(opts.prediction.vitals, opts.gold.vitals),
    medications: scoreMedications(
      opts.prediction.medications,
      opts.gold.medications,
    ),
    diagnoses: scoreDiagnoses(opts.prediction.diagnoses, opts.gold.diagnoses),
    plan: scorePlan(opts.prediction.plan, opts.gold.plan),
    follow_up: scoreFollowUp(opts.prediction.follow_up, opts.gold.follow_up),
  };

  const overall =
    (per_field.chief_complaint.score +
      per_field.vitals.score +
      per_field.medications.score +
      per_field.diagnoses.score +
      per_field.plan.score +
      per_field.follow_up.score) /
    6;

  return {
    case_id: opts.case_id,
    per_field,
    overall,
    schema_invalid: false,
    hallucinations: detectHallucinations(opts.prediction, opts.transcript),
  };
}

/**
 * Simple grounding check: every leaf string/number in the prediction should
 * appear (literally for numbers, fuzzily for text) in the transcript.
 *
 * Limitations: a prediction like "viral upper respiratory infection" may be
 * inferred from "looks like a virus" — we treat token-set sim >= 0.5 against
 * any sentence in the transcript as "grounded". False positives possible.
 */
function detectHallucinations(pred: Extraction, transcript: string): string[] {
  const norm = normalizeText(transcript);
  const sentences = transcript.split(/[.\n]/).map(normalizeText).filter(Boolean);
  const flagged: string[] = [];

  function groundedNumber(n: number | null, label: string): boolean {
    if (n === null) return true;
    return norm.includes(String(n));
  }

  function groundedText(value: string, label: string): boolean {
    const t = normalizeText(value);
    if (!t) return true;
    if (norm.includes(t)) return true;
    // Fall back to fuzzy: sentence-level token-set similarity.
    return sentences.some((s) => tokenSetSimilarity(t, s) >= 0.5);
  }

  if (pred.vitals.bp && !norm.includes(pred.vitals.bp)) {
    flagged.push(`vitals.bp "${pred.vitals.bp}" not found in transcript`);
  }
  if (!groundedNumber(pred.vitals.hr, "hr")) {
    flagged.push(`vitals.hr ${pred.vitals.hr} not found in transcript`);
  }
  if (pred.vitals.temp_f !== null && !norm.includes(String(pred.vitals.temp_f))) {
    flagged.push(`vitals.temp_f ${pred.vitals.temp_f} not found in transcript`);
  }
  if (!groundedNumber(pred.vitals.spo2, "spo2")) {
    flagged.push(`vitals.spo2 ${pred.vitals.spo2} not found in transcript`);
  }

  for (const med of pred.medications) {
    if (!groundedText(med.name, "medications.name")) {
      flagged.push(`medications: "${med.name}" not grounded in transcript`);
    }
  }

  for (const dx of pred.diagnoses) {
    if (!groundedText(dx.description, "diagnoses.description")) {
      flagged.push(`diagnoses: "${dx.description}" not grounded in transcript`);
    }
  }

  return flagged;
}
