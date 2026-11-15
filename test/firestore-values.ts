/**
 * Firestore's REST values, made from plain ones: for the fake Firestore in
 * `helpers.ts`, and for `bench/cpu.ts`, which runs in plain Node and so can't
 * import anything that loads `cloudflare:workers`. Keep it free of Worker
 * imports.
 */

/** A JavaScript value as a Firestore REST value, as the SDK would store it. */
export function encodeValue(value: unknown): Record<string, unknown> {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeValue) } };
  }
  return {
    mapValue: { fields: encodeFields(value as Record<string, unknown>) },
  };
}

export function encodeFields(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [key, encodeValue(value)]),
  );
}
