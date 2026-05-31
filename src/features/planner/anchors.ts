import { Prisma, type PrismaClient } from "@prisma/client";
import { ResourceNotFoundError } from "@/lib/errors";
import type {
  PlannerEngineInput,
  PlannerPlaceInput,
  PlannerStoredPlaceInput,
  TimeReliabilityMode,
} from "@/features/planner/types";

export type PlannerAnchor = {
  id: string;
  displayName: string;
  regionName: string;
  latitude: number;
  longitude: number;
  openingHoursRaw: string | null;
  openingHoursJson: Prisma.JsonValue | null;
  dwellMinutes: number;
  storedPlaceId: string | null;
  externalProvider: string | null;
  externalRef: string | null;
  externalCategoryLabel: string | null;
};

export function pickPlaceName(
  place: {
    baseDisplayName: string;
    locales: Array<{
      language: string;
      displayName: string;
    }>;
  },
  language: string,
) {
  return (
    place.locales.find((locale) => locale.language === language)?.displayName ??
    place.locales.find((locale) => locale.language === "ko")?.displayName ??
    place.baseDisplayName
  );
}

export function isStoredPlaceInput(
  place: PlannerPlaceInput,
): place is PlannerStoredPlaceInput {
  return place.mode === "stored";
}

export function buildPlaceDedupKey(place: PlannerPlaceInput) {
  if (isStoredPlaceInput(place)) {
    return `stored:${place.placeId}`;
  }

  if (place.externalId) {
    return `external:${place.provider}:${place.externalId}`;
  }

  return `external:${place.provider}:${place.displayName.toLowerCase()}:${place.latitude.toFixed(5)}:${place.longitude.toFixed(5)}`;
}

export function buildPlanQueryPlaceId(
  place: {
    placeId: string | null;
    sequence: number;
    externalProvider: string | null;
    externalRef: string | null;
  },
) {
  if (place.placeId) {
    return place.placeId;
  }

  return `${place.externalProvider ?? "external"}:${place.externalRef ?? place.sequence}`;
}

export async function resolvePlannerAnchors(
  prisma: PrismaClient,
  language: string,
  places: PlannerPlaceInput[],
) {
  const storedPlaceIds = places
    .filter(isStoredPlaceInput)
    .map((place) => place.placeId);

  const storedPlaces = storedPlaceIds.length
    ? await prisma.place.findMany({
        where: {
          AND: [
            {
              id: {
                in: storedPlaceIds,
              },
            },
            {
              sourceContentId: {
                not: null,
              },
            },
          ],
        },
        include: {
          locales: true,
        },
      })
    : [];

  const storedPlaceMap = new Map(storedPlaces.map((place) => [place.id, place]));

  if (storedPlaceMap.size !== new Set(storedPlaceIds).size) {
    throw new ResourceNotFoundError("일부 장소를 찾지 못했습니다.");
  }

  const anchors: PlannerAnchor[] = places.map((place, index) => {
    if (isStoredPlaceInput(place)) {
      const storedPlace = storedPlaceMap.get(place.placeId);
      if (!storedPlace) {
        throw new ResourceNotFoundError("일부 장소를 찾지 못했습니다.");
      }

      return {
        id: storedPlace.id,
        displayName: pickPlaceName(storedPlace, language),
        regionName: storedPlace.regionName,
        latitude: storedPlace.latitude,
        longitude: storedPlace.longitude,
        openingHoursRaw: storedPlace.openingHoursRaw,
        openingHoursJson: storedPlace.openingHoursJson,
        dwellMinutes: place.dwellMinutes,
        storedPlaceId: storedPlace.id,
        externalProvider: null,
        externalRef: null,
        externalCategoryLabel: null,
      };
    }

    return {
      id: `external:${index + 1}`,
      displayName: place.displayName,
      regionName: place.regionName,
      latitude: place.latitude,
      longitude: place.longitude,
      openingHoursRaw: null,
      openingHoursJson: null,
      dwellMinutes: place.dwellMinutes,
      storedPlaceId: null,
      externalProvider: place.provider,
      externalRef: place.externalId ?? null,
      externalCategoryLabel: place.categoryLabel,
    };
  });

  return {
    anchors,
    buildEngineInput(
      startAt: string,
      timeReliabilityMode: TimeReliabilityMode,
      includeGeneratedTimes: boolean,
    ) {
      return {
        startAt,
        includeGeneratedTimes,
        timeReliabilityMode,
        places: anchors.map((anchor) => ({
          placeId: anchor.id,
          dwellMinutes: anchor.dwellMinutes,
        })),
      } satisfies PlannerEngineInput;
    },
  };
}
