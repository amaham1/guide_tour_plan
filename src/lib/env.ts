function env(name: string, fallback = "") {
  return process.env[name] ?? fallback;
}

function envFlag(name: string, fallback = false) {
  const value = env(name);
  if (!value) {
    return fallback;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function envList(name: string, fallback: string[] = []) {
  const value = env(name);
  if (!value.trim()) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const appEnv = {
  dataGoKrServiceKey: env("DATA_GO_KR_SERVICE_KEY"),
  jejuOpenApiBaseUrl: env(
    "JEJU_OPEN_API_BASE_URL",
    "http://busopen.jeju.go.kr/OpenAPI/service/jibusopenapi",
  ),
  jejuOpenApiServiceKey: env("JEJU_OPEN_API_SERVICE_KEY") || env("DATA_GO_KR_SERVICE_KEY"),
  osrmBaseUrl: env("OSRM_BASE_URL", "http://localhost:5000"),
  enableInternalAdmin: envFlag("ENABLE_INTERNAL_ADMIN", false),
  busJejuBaseUrl: env("BUS_JEJU_BASE_URL", "https://bus.jeju.go.kr"),
  kakaoRestApiKey: env("KAKAO_REST_API_KEY"),
  visitJejuBaseUrl: env("VISIT_JEJU_BASE_URL"),
  busStopsSourceUrl: env("BUS_STOPS_SOURCE_URL"),
  stopTranslationsXlsxPath: env("STOP_TRANSLATIONS_XLSX_PATH"),
  routeTimetableBaseUrl: env("ROUTE_TIMETABLE_BASE_URL"),
  vehicleMapSourceUrl: env("VEHICLE_MAP_SOURCE_URL"),
  routeSearchTerms: envList("ROUTE_SEARCH_TERMS"),
};
