const excludedRouteKeywords = [
  "\uC784\uC2DC",
  "\uC6B0\uB3C4",
  "\uC635\uC11C\uBC84\uC2A4",
  "\uAD00\uAD11\uC9C0\uC21C\uD658",
] as const;

export function isExcludedTransitRouteLabel(value: string | null | undefined) {
  if (!value) {
    return false;
  }

  const compact = value.normalize("NFC").replace(/\s+/g, "");
  return (
    excludedRouteKeywords.some((keyword) => compact.includes(keyword)) ||
    compact.includes("\uB9C8\uC744\uBC84\uC2A4") ||
    /(?:^|[|(])\uB9C8\uC744(?:\uBC84\uC2A4)?(?:\)|$)/.test(compact)
  );
}

export function isExcludedTransitRoute(values: Array<string | null | undefined>) {
  return values.some((value) => isExcludedTransitRouteLabel(value));
}
