import type { PrismaClient, SourceKind } from "@prisma/client";

export type SourceCatalogSeed = {
  key: string;
  name: string;
  description: string;
  sourceKind: SourceKind;
  officialUrl: string;
  guideUrl?: string;
  scheduleLabel: string;
  isActive?: boolean;
};

export const GNSS_DERIVED_DISABLED_JOB_KEYS = [
  "segment-profiles",
  "osrm-bus-customize",
] as const;

export const sourceCatalog: SourceCatalogSeed[] = [
  {
    key: "stops",
    name: "Jeju Station2 stops",
    description: "Authoritative stop and multilingual stop-name snapshot from Jeju BIS OpenAPI.",
    sourceKind: "OPEN_API",
    officialUrl: "http://busopen.jeju.go.kr",
    guideUrl: "http://busopen.jeju.go.kr",
    scheduleLabel: "Daily snapshot",
  },
  {
    key: "stop-translations",
    name: "Stop translation overrides",
    description: "Optional local translation overlay applied on top of Station2 data.",
    sourceKind: "FILE_DATA",
    officialUrl: "http://busopen.jeju.go.kr",
    guideUrl: "http://busopen.jeju.go.kr",
    scheduleLabel: "On demand",
  },
  {
    key: "visit-jeju-places",
    name: "VISIT JEJU POI",
    description: "Tourism place ingest used by planner content jobs.",
    sourceKind: "JSON_FEED",
    officialUrl: "https://api.visitjeju.net",
    guideUrl: "https://api.visitjeju.net",
    scheduleLabel: "Daily",
  },
  {
    key: "routes-openapi",
    name: "Jeju route catalog",
    description: "User-facing route master data from Jeju BIS Bus OpenAPI.",
    sourceKind: "OPEN_API",
    officialUrl: "http://busopen.jeju.go.kr",
    guideUrl: "http://busopen.jeju.go.kr",
    scheduleLabel: "Daily snapshot",
  },
  {
    key: "route-patterns-openapi",
    name: "Jeju route patterns",
    description: "Authoritative route-pattern stop sequences from Jeju BIS StationRoute OpenAPI.",
    sourceKind: "OPEN_API",
    officialUrl: "http://busopen.jeju.go.kr",
    guideUrl: "http://busopen.jeju.go.kr",
    scheduleLabel: "Daily snapshot",
  },
  {
    key: "routes-html",
    name: "Schedule source matching",
    description: "Matches bus.jeju schedule HTML entries onto authoritative OpenAPI route patterns.",
    sourceKind: "HTML_PAGE",
    officialUrl: "https://bus.jeju.go.kr",
    guideUrl: "https://bus.jeju.go.kr/mobile/schedule/listSchedule",
    scheduleLabel: "Daily",
  },
  {
    key: "route-geometries",
    name: "Route geometries",
    description: "Builds canonical route geometries and stop projections from Jeju BIS link geometry, with GTFS and OSRM fallbacks.",
    sourceKind: "FILE_DATA",
    officialUrl: "https://gtfs.org",
    guideUrl: "https://gtfs.org/documentation/schedule/reference/#shapestxt",
    scheduleLabel: "Daily",
  },
  {
    key: "timetables-xlsx",
    name: "Timetable expansion",
    description:
      "Builds sparse official trips from schedule tables and stores anchor-bounded generated stop times separately.",
    sourceKind: "FILE_DATA",
    officialUrl: "https://bus.jeju.go.kr",
    guideUrl: "https://bus.jeju.go.kr/mobile/schedule/listSchedule",
    scheduleLabel: "Daily",
  },
  {
    key: "vehicle-device-map",
    name: "Vehicle Device Map",
    description: "Maps realtime vehicle devices onto planner route patterns from an override source or Jeju BIS live positions.",
    sourceKind: "OPEN_API",
    officialUrl: "https://www.data.go.kr",
    guideUrl: "https://www.data.go.kr",
    scheduleLabel: "Realtime",
  },
  {
    key: "gnss-history",
    name: "GNSS raw history",
    description: "Captures raw GNSS snapshots for future analysis and validation.",
    sourceKind: "OPEN_API",
    officialUrl: "https://www.data.go.kr",
    guideUrl: "https://www.data.go.kr",
    scheduleLabel: "Every minute",
  },
  {
    key: "segment-profiles",
    name: "Segment travel profiles",
    description: "Aggregates GNSS traces into route-pattern segment speed and duration profiles.",
    sourceKind: "INTERNAL_JOB",
    officialUrl: "https://project-osrm.org",
    guideUrl: "https://project-osrm.org/docs",
    scheduleLabel: "Disabled",
    isActive: false,
  },
  {
    key: "osrm-bus-customize",
    name: "OSRM bus customize",
    description: "Materializes segment-speed and turn-penalty CSV updates for the bus ETA graph.",
    sourceKind: "INTERNAL_JOB",
    officialUrl: "https://project-osrm.org",
    guideUrl: "https://project-osrm.org/docs",
    scheduleLabel: "Disabled",
    isActive: false,
  },
  {
    key: "walk-links",
    name: "Walk links",
    description: "Precomputed place-stop and stop-stop walking graph via OSRM.",
    sourceKind: "INTERNAL_JOB",
    officialUrl: "https://project-osrm.org",
    guideUrl: "https://project-osrm.org/docs",
    scheduleLabel: "Daily overnight",
  },
  {
    key: "transit-audit",
    name: "Transit audit",
    description: "Coverage audit comparing OpenAPI route-stop coverage against local planner tables.",
    sourceKind: "INTERNAL_JOB",
    officialUrl: "http://busopen.jeju.go.kr",
    guideUrl: "http://busopen.jeju.go.kr",
    scheduleLabel: "On demand",
  },
];

export async function syncSourceCatalog(prisma: PrismaClient) {
  for (const source of sourceCatalog) {
    const dataSource = await prisma.dataSource.upsert({
      where: { key: source.key },
      update: {
        name: source.name,
        description: source.description,
        sourceKind: source.sourceKind,
        officialUrl: source.officialUrl,
        guideUrl: source.guideUrl,
        isActive: source.isActive ?? true,
      },
      create: {
        key: source.key,
        name: source.name,
        description: source.description,
        sourceKind: source.sourceKind,
        officialUrl: source.officialUrl,
        guideUrl: source.guideUrl,
        isActive: source.isActive ?? true,
      },
    });

    await prisma.ingestJob.upsert({
      where: { key: source.key },
      update: {
        name: source.name,
        scheduleLabel: source.scheduleLabel,
        sourceId: dataSource.id,
        isActive: source.isActive ?? true,
      },
      create: {
        key: source.key,
        name: source.name,
        scheduleLabel: source.scheduleLabel,
        sourceId: dataSource.id,
        isActive: source.isActive ?? true,
      },
    });
  }
}
