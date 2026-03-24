import type { PrismaClient, SourceKind } from "@prisma/client";

export type SourceCatalogSeed = {
  key: string;
  name: string;
  description: string;
  sourceKind: SourceKind;
  officialUrl: string;
  guideUrl?: string;
  scheduleLabel: string;
};

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
    key: "timetables-xlsx",
    name: "Timetable expansion",
    description: "Builds trips and stop times from schedule tables on top of authoritative patterns.",
    sourceKind: "FILE_DATA",
    officialUrl: "https://bus.jeju.go.kr",
    guideUrl: "https://bus.jeju.go.kr/mobile/schedule/listSchedule",
    scheduleLabel: "Daily",
  },
  {
    key: "vehicle-device-map",
    name: "Vehicle Device Map",
    description: "Maps realtime vehicle devices onto planner route patterns.",
    sourceKind: "OPEN_API",
    officialUrl: "https://www.data.go.kr",
    guideUrl: "https://www.data.go.kr",
    scheduleLabel: "Realtime",
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
        isActive: true,
      },
      create: {
        key: source.key,
        name: source.name,
        description: source.description,
        sourceKind: source.sourceKind,
        officialUrl: source.officialUrl,
        guideUrl: source.guideUrl,
        isActive: true,
      },
    });

    await prisma.ingestJob.upsert({
      where: { key: source.key },
      update: {
        name: source.name,
        scheduleLabel: source.scheduleLabel,
        sourceId: dataSource.id,
        isActive: true,
      },
      create: {
        key: source.key,
        name: source.name,
        scheduleLabel: source.scheduleLabel,
        sourceId: dataSource.id,
        isActive: true,
      },
    });
  }
}
