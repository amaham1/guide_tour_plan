import { db } from "@/lib/db";
import { assertPlannerCatalogReady } from "@/features/planner/catalog";
import { searchKakaoPlaces } from "@/features/planner/place-search";
import { searchRequestSchema, type SearchResultDto } from "@/features/planner/types";

export async function searchCatalog(rawInput: unknown) {
  const input = searchRequestSchema.parse(rawInput);
  await assertPlannerCatalogReady(db);

  if (input.kind === "place") {
    return searchKakaoPlaces(input.q, input.limit);
  }

  const stops = await db.stop.findMany({
    where: {
      AND: [
        input.includeGeneratedStops
          ? {
              OR: [
                {
                  stopTimes: {
                    some: {
                      isEstimated: false,
                      trip: {
                        routePattern: {
                          isActive: true,
                          route: {
                            isActive: true,
                          },
                        },
                        scheduleSource: {
                          is: {
                            isActive: true,
                          },
                        },
                      },
                    },
                  },
                },
                {
                  derivedStopTimes: {
                    some: {
                      trip: {
                        routePattern: {
                          isActive: true,
                          route: {
                            isActive: true,
                          },
                        },
                        scheduleSource: {
                          is: {
                            isActive: true,
                          },
                        },
                      },
                    },
                  },
                },
              ],
            }
          : {
              stopTimes: {
                some: {
                  isEstimated: false,
                  trip: {
                    routePattern: {
                      isActive: true,
                      route: {
                        isActive: true,
                      },
                    },
                    scheduleSource: {
                      is: {
                        isActive: true,
                      },
                    },
                  },
                },
              },
            },
        {
          OR: [
            { displayName: { contains: input.q } },
            { translations: { some: { displayName: { contains: input.q } } } },
          ],
        },
      ],
    },
    include: {
      translations: true,
      stopTimes: {
        where: {
          isEstimated: false,
          trip: {
            routePattern: {
              isActive: true,
              route: {
                isActive: true,
              },
            },
            scheduleSource: {
              is: {
                isActive: true,
              },
            },
          },
        },
        take: 1,
      },
      derivedStopTimes: {
        where: {
          trip: {
            routePattern: {
              isActive: true,
              route: {
                isActive: true,
              },
            },
            scheduleSource: {
              is: {
                isActive: true,
              },
            },
          },
        },
        take: 1,
      },
    },
    orderBy: {
      displayName: "asc",
    },
    take: input.limit,
  });

  return stops.map<SearchResultDto>((stop) => {
    const hasOfficial = stop.stopTimes.length > 0;
    const hasGenerated = stop.derivedStopTimes.length > 0;

    return {
      id: stop.id,
      kind: "stop",
      displayName: stop.displayName,
      categoryLabel: "정류장",
      regionName: stop.regionName,
      latitude: stop.latitude,
      longitude: stop.longitude,
      meta: {
        stopId: stop.id,
        translations: stop.translations.length,
        coverage: hasOfficial
          ? hasGenerated
            ? "mixed"
            : "official"
          : "generated_only",
      },
    };
  });
}
