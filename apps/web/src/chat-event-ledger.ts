export function finitePositiveSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function sequenceFromOpaqueId(value: string | undefined, prefix: "event" | "run"): number | undefined {
  if (value === undefined || !value.startsWith(`${prefix}-`)) return undefined;
  const suffix = value.slice(value.lastIndexOf("-") + 1);
  if (!/^\d+$/.test(suffix)) return undefined;
  return finitePositiveSequence(Number(suffix));
}

export function advanceSequence(current: number | undefined, observed: number | undefined): number | undefined {
  if (observed === undefined) return current;
  return current === undefined ? observed : Math.max(current, observed);
}
