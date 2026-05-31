export function getMetaRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function getMetaArray(
  meta: Record<string, unknown> | null,
  key: string,
) {
  const value = meta?.[key];
  return Array.isArray(value) ? value : [];
}
