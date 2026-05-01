export type Strategy = "zero_shot" | "few_shot" | "cot";

export type Vitals = {
  bp: string | null;
  hr: number | null;
  temp_f: number | null;
  spo2: number | null;
};

export type Medication = {
  name: string;
  dose: string | null;
  frequency: string | null;
  route: string | null;
};

export type Diagnosis = {
  description: string;
  icd10?: string;
};

export type FollowUp = {
  interval_days: number | null;
  reason: string | null;
};

export type Extraction = {
  chief_complaint: string;
  vitals: Vitals;
  medications: Medication[];
  diagnoses: Diagnosis[];
  plan: string[];
  follow_up: FollowUp;
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type ExtractAttempt = {
  attempt_number: number;
  raw_tool_input: unknown;
  validation_errors: string[];
  tokens: TokenUsage;
  duration_ms: number;
};

export type ExtractResult = {
  prediction: Extraction | null;
  schema_valid: boolean;
  attempts: ExtractAttempt[];
  total_tokens: TokenUsage;
  total_duration_ms: number;
  cost_usd: number;
  prompt_hash: string;
  strategy: Strategy;
  model: string;
};
