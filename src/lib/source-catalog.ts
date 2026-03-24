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
    name: "버스 정류소 기본 정보",
    description: "정류소 좌표와 기본 명칭을 적재합니다.",
    sourceKind: "OPEN_API",
    officialUrl: "https://www.data.go.kr",
    guideUrl: "https://www.data.go.kr",
    scheduleLabel: "수동 또는 일 1회",
  },
  {
    key: "stop-translations",
    name: "정류소 다국어 번역",
    description: "정류소 영문 등 번역명을 실데이터 XLSX 또는 bus.jeju 정류소 정보에서 적재합니다.",
    sourceKind: "FILE_DATA",
    officialUrl: "https://www.data.go.kr",
    guideUrl: "https://www.data.go.kr",
    scheduleLabel: "주 1회",
  },
  {
    key: "visit-jeju-places",
    name: "VISIT JEJU POI",
    description: "관광지, 식당, 숙소와 운영시간 원문을 적재합니다.",
    sourceKind: "JSON_FEED",
    officialUrl: "https://api.visitjeju.net",
    guideUrl: "https://api.visitjeju.net",
    scheduleLabel: "일 1회",
  },
  {
    key: "routes-html",
    name: "노선 HTML 메타",
    description: "bus.jeju.go.kr 모바일 시간표 HTML에서 노선 메타를 적재합니다.",
    sourceKind: "HTML_PAGE",
    officialUrl: "https://bus.jeju.go.kr",
    guideUrl: "https://bus.jeju.go.kr/mobile/schedule/listSchedule",
    scheduleLabel: "수동 또는 일 1회",
  },
  {
    key: "timetables-xlsx",
    name: "시간표 적재",
    description: "XLSX 또는 bus.jeju schedule JSON에서 Trip/StopTime을 적재합니다.",
    sourceKind: "FILE_DATA",
    officialUrl: "https://bus.jeju.go.kr",
    guideUrl: "https://bus.jeju.go.kr/mobile/schedule/listSchedule",
    scheduleLabel: "수동 또는 일 1회",
  },
  {
    key: "vehicle-device-map",
    name: "Vehicle Device Map",
    description: "실시간 GNSS와 노선 패턴을 연결하는 디바이스 맵을 적재합니다.",
    sourceKind: "OPEN_API",
    officialUrl: "https://www.data.go.kr",
    guideUrl: "https://www.data.go.kr",
    scheduleLabel: "매시간",
  },
  {
    key: "walk-links",
    name: "보행 링크",
    description: "POI↔정류소, 정류소↔정류소 보행 링크를 사전 계산합니다.",
    sourceKind: "INTERNAL_JOB",
    officialUrl: "https://project-osrm.org",
    guideUrl: "https://project-osrm.org/docs",
    scheduleLabel: "매일 야간",
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
