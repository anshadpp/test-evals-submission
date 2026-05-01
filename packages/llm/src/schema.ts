import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, "../../../data/schema.json");

export const rawSchema = JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<
  string,
  unknown
>;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validateFn = ajv.compile(rawSchema);

export function validateExtraction(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const valid = validateFn(value);
  const errors = (validateFn.errors ?? []).map(
    (e) => `${e.instancePath || "(root)"} ${e.message ?? "invalid"}`,
  );
  return { valid: !!valid, errors };
}

export function toolInputSchema(): Record<string, unknown> {
  const { $schema, $id, title, description, ...rest } = rawSchema as Record<
    string,
    unknown
  >;
  void $schema;
  void $id;
  void title;
  void description;
  return rest;
}
