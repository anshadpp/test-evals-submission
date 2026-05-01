const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "with", "in", "on", "at",
  "is", "as", "by", "be", "are", "was", "were", "this", "that", "it", "its",
]);

const FREQUENCY_MAP: Record<string, string> = {
  "qd": "once daily",
  "od": "once daily",
  "once a day": "once daily",
  "once per day": "once daily",
  "every day": "once daily",
  "daily": "once daily",
  "bid": "twice daily",
  "twice a day": "twice daily",
  "twice per day": "twice daily",
  "every 12 hours": "twice daily",
  "tid": "three times daily",
  "thrice daily": "three times daily",
  "three times a day": "three times daily",
  "every 8 hours": "three times daily",
  "qid": "four times daily",
  "four times a day": "four times daily",
  "every 6 hours": "four times daily",
  "qhs": "at bedtime",
  "at night": "at bedtime",
  "nightly": "at bedtime",
  "prn": "as needed",
  "as required": "as needed",
};

const ROUTE_MAP: Record<string, string> = {
  "by mouth": "PO",
  "oral": "PO",
  "orally": "PO",
  "po": "PO",
  "intravenous": "IV",
  "iv": "IV",
  "intramuscular": "IM",
  "im": "IM",
  "topical": "topical",
  "inhaled": "inhaled",
  "inhalation": "inhaled",
  "sublingual": "SL",
  "sl": "SL",
  "rectal": "PR",
  "pr": "PR",
};

export function normalizeText(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/[^\w\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDose(dose: string | null | undefined): string {
  if (!dose) return "";
  return dose
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(\d+)mg/g, "$1mg")
    .replace(/(\d+)mcg/g, "$1mcg")
    .replace(/(\d+)ml/g, "$1ml")
    .trim();
}

export function normalizeFrequency(freq: string | null | undefined): string {
  if (!freq) return "";
  const v = normalizeText(freq);
  return FREQUENCY_MAP[v] ?? v;
}

export function normalizeRoute(route: string | null | undefined): string {
  if (!route) return "";
  const v = route.toLowerCase().trim();
  return ROUTE_MAP[v] ?? route.trim();
}

export function tokens(s: string): string[] {
  return normalizeText(s)
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/**
 * Token-set similarity: |intersection| / max(|a|, |b|).
 * Symmetric, in [0, 1]. Fast and good enough for clinical text.
 */
export function tokenSetSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  return intersect / Math.max(ta.size, tb.size);
}
