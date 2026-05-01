import { describe, expect, test } from "bun:test";
import {
  normalizeDose,
  normalizeFrequency,
  normalizeRoute,
  tokenSetSimilarity,
} from "../normalize.ts";
import {
  scoreCase,
  scoreDiagnoses,
  scoreMedications,
  scoreVitals,
} from "../metrics.ts";

describe("normalize", () => {
  test("frequency synonyms collapse to canonical form", () => {
    expect(normalizeFrequency("BID")).toBe(normalizeFrequency("twice daily"));
    expect(normalizeFrequency("twice a day")).toBe(normalizeFrequency("BID"));
    expect(normalizeFrequency("every 6 hours")).toBe(
      normalizeFrequency("QID"),
    );
  });

  test("dose normalization removes spaces", () => {
    expect(normalizeDose("10 mg")).toBe(normalizeDose("10mg"));
    expect(normalizeDose("400 MG")).toBe(normalizeDose("400mg"));
  });

  test("route normalization maps synonyms", () => {
    expect(normalizeRoute("by mouth")).toBe("PO");
    expect(normalizeRoute("oral")).toBe("PO");
    expect(normalizeRoute("PO")).toBe("PO");
  });

  test("tokenSetSimilarity is symmetric and bounded", () => {
    expect(tokenSetSimilarity("sore throat", "sore throat")).toBe(1);
    expect(tokenSetSimilarity("hello", "world")).toBe(0);
    const a = tokenSetSimilarity("viral upper respiratory infection", "upper respiratory virus");
    const b = tokenSetSimilarity("upper respiratory virus", "viral upper respiratory infection");
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0.4);
  });
});

describe("metrics", () => {
  test("vitals: temp_f within ±0.2 scores 1", () => {
    const r = scoreVitals(
      { bp: "120/80", hr: 70, temp_f: 100.5, spo2: 98 },
      { bp: "120/80", hr: 70, temp_f: 100.4, spo2: 98 },
    );
    expect(r.score).toBe(1);
  });

  test("vitals: temp_f beyond tolerance fails the temp sub-field", () => {
    const r = scoreVitals(
      { bp: "120/80", hr: 70, temp_f: 100.8, spo2: 98 },
      { bp: "120/80", hr: 70, temp_f: 100.4, spo2: 98 },
    );
    expect(r.score).toBe(0.75);
  });

  test("medications: F1 = 1 when synonyms match across pred and gold", () => {
    const pred = [
      {
        name: "ibuprofen",
        dose: "400 mg",
        frequency: "every 6 hours",
        route: "PO",
      },
      {
        name: "acetaminophen",
        dose: "500mg",
        frequency: "BID",
        route: "PO",
      },
    ];
    const gold = [
      {
        name: "ibuprofen",
        dose: "400mg",
        frequency: "QID",
        route: "PO",
      },
      {
        name: "acetaminophen",
        dose: "500 mg",
        frequency: "twice daily",
        route: "PO",
      },
    ];
    const r = scoreMedications(pred, gold);
    expect(r.score).toBe(1);
  });

  test("medications: missing item lowers recall, extra item lowers precision", () => {
    const pred = [
      {
        name: "ibuprofen",
        dose: "400 mg",
        frequency: "BID",
        route: "PO",
      },
      {
        name: "lisinopril",
        dose: "10 mg",
        frequency: "daily",
        route: "PO",
      },
    ];
    const gold = [
      {
        name: "ibuprofen",
        dose: "400 mg",
        frequency: "BID",
        route: "PO",
      },
    ];
    const r = scoreMedications(pred, gold);
    expect(r.score).toBeLessThan(1);
    expect(r.score).toBeGreaterThan(0);
  });

  test("diagnoses: ICD-10 attempts and correct counts are tracked", () => {
    const r = scoreDiagnoses(
      [{ description: "essential hypertension", icd10: "I10" }],
      [{ description: "hypertension essential", icd10: "I10" }],
    );
    expect(r.score).toBeGreaterThan(0);
    expect(r.detail).toMatchObject({ icd10_correct: 1, icd10_attempts: 1 });
  });

  test("diagnoses: F1 drops to 0 when descriptions don't overlap", () => {
    const r = scoreDiagnoses(
      [{ description: "viral URI" }],
      [{ description: "acute pharyngitis" }],
    );
    expect(r.score).toBe(0);
  });

  test("scoreCase: hallucinated medication is flagged", () => {
    const transcript = "Patient has a cough. Recommend rest and fluids.";
    const gold = {
      chief_complaint: "cough",
      vitals: { bp: null, hr: null, temp_f: null, spo2: null },
      medications: [],
      diagnoses: [{ description: "viral cough" }],
      plan: ["rest", "fluids"],
      follow_up: { interval_days: null, reason: null },
    };
    const prediction = {
      ...gold,
      medications: [
        {
          name: "azithromycin",
          dose: "500 mg",
          frequency: "daily",
          route: "PO",
        },
      ],
    };
    const r = scoreCase({
      case_id: "test",
      prediction,
      gold,
      transcript,
    });
    expect(r.hallucinations.length).toBeGreaterThan(0);
    expect(r.hallucinations.some((h) => h.includes("azithromycin"))).toBe(true);
  });

  test("scoreCase: grounded prediction has no hallucinations", () => {
    const transcript =
      "Patient has fever. Prescribed ibuprofen 400 mg every 6 hours.";
    const gold = {
      chief_complaint: "fever",
      vitals: { bp: null, hr: null, temp_f: null, spo2: null },
      medications: [
        {
          name: "ibuprofen",
          dose: "400 mg",
          frequency: "every 6 hours",
          route: "PO",
        },
      ],
      diagnoses: [{ description: "fever" }],
      plan: ["ibuprofen"],
      follow_up: { interval_days: null, reason: null },
    };
    const r = scoreCase({
      case_id: "test",
      prediction: gold,
      gold,
      transcript,
    });
    expect(r.hallucinations.length).toBe(0);
  });

  test("scoreCase: schema_invalid when prediction is null", () => {
    const r = scoreCase({
      case_id: "test",
      prediction: null,
      gold: {
        chief_complaint: "x",
        vitals: { bp: null, hr: null, temp_f: null, spo2: null },
        medications: [],
        diagnoses: [],
        plan: [],
        follow_up: { interval_days: null, reason: null },
      },
      transcript: "",
    });
    expect(r.schema_invalid).toBe(true);
    expect(r.overall).toBe(0);
  });
});
