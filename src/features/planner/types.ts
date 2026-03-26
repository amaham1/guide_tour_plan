import { PlanPreference, SessionStatus } from "@prisma/client";
import { z } from "zod";

export const searchKindSchema = z.enum(["place", "stop"]);

export const searchRequestSchema = z.object({
  kind: searchKindSchema,
  q: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(20).default(8),
  includeGeneratedStops: z.coerce.boolean().default(false),
});

const dwellMinutesSchema = z.coerce.number().int().min(10).max(240);

const storedPlanPlaceInputSchema = z.object({
  mode: z.literal("stored"),
  placeId: z.string().trim().min(1),
  dwellMinutes: dwellMinutesSchema,
});

const externalPlanPlaceInputSchema = z.object({
  mode: z.literal("external"),
  displayName: z.string().trim().min(1),
  latitude: z.coerce.number().min(32).max(35),
  longitude: z.coerce.number().min(124).max(130),
  regionName: z.string().trim().min(1).default("제주"),
  categoryLabel: z.string().trim().min(1).default("장소"),
  provider: z.string().trim().min(1).default("external"),
  externalId: z.string().trim().min(1).optional(),
  dwellMinutes: dwellMinutesSchema,
});

export const planPlaceInputSchema = z.discriminatedUnion("mode", [
  storedPlanPlaceInputSchema,
  externalPlanPlaceInputSchema,
]);

export const timeReliabilityModeSchema = z.enum([
  "OFFICIAL_ONLY",
  "INCLUDE_ESTIMATED",
  "ALLOW_ROUGH",
]);

export const candidateTimeReliabilitySchema = z.enum([
  "OFFICIAL",
  "ESTIMATED",
  "ROUGH",
]);

export const planRequestSchema = z
  .object({
    language: z.string().trim().default("ko"),
    startAt: z
      .string()
      .trim()
      .refine((value) => !Number.isNaN(Date.parse(value)), "유효한 날짜여야 합니다."),
    includeGeneratedTimes: z.coerce.boolean().optional(),
    timeReliabilityMode: timeReliabilityModeSchema.optional(),
    preference: z.nativeEnum(PlanPreference).optional(),
    places: z.array(planPlaceInputSchema).min(2).max(5),
  })
  .transform((input) => {
    const timeReliabilityMode =
      input.timeReliabilityMode ??
      (input.includeGeneratedTimes ? "INCLUDE_ESTIMATED" : "OFFICIAL_ONLY");

    return {
      ...input,
      includeGeneratedTimes:
        input.includeGeneratedTimes ?? timeReliabilityMode !== "OFFICIAL_ONLY",
      timeReliabilityMode,
    };
  });

export const createSessionSchema = z.object({
  planCandidateId: z.string().trim().min(1),
});

export type PlannerInput = z.infer<typeof planRequestSchema>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export type PlannerPlaceInput = z.infer<typeof planPlaceInputSchema>;
export type PlannerStoredPlaceInput = z.infer<typeof storedPlanPlaceInputSchema>;
export type PlannerExternalPlaceInput = z.infer<typeof externalPlanPlaceInputSchema>;
export type TimeReliabilityMode = z.infer<typeof timeReliabilityModeSchema>;
export type CandidateTimeReliability = z.infer<typeof candidateTimeReliabilitySchema>;

export type PlannerEngineInput = {
  startAt: string;
  includeGeneratedTimes: boolean;
  timeReliabilityMode: TimeReliabilityMode;
  places: Array<{
    placeId: string;
    dwellMinutes: number;
  }>;
};

export type CandidateLegKind = "visit" | "walk" | "wait" | "ride";

export type CandidateWarningCode =
  | "OPENING_HOURS_CONFLICT"
  | "ESTIMATED_STOP_TIMES"
  | "ROUGH_STOP_TIMES"
  | "REALTIME_UNAVAILABLE"
  | "TRANSFER_REQUIRED";

export type CandidateWarning = {
  code: CandidateWarningCode;
  message: string;
};

export type CandidateLeg = {
  id: string;
  kind: CandidateLegKind;
  title: string;
  subtitle?: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  fromLabel?: string;
  toLabel?: string;
  routeShortName?: string;
  routePatternId?: string;
  tripId?: string;
  placeId?: string;
  fromStopId?: string;
  toStopId?: string;
  timeReliability: CandidateTimeReliability;
  startWindowAt?: string | null;
  endWindowAt?: string | null;
};

export type CandidateSummary = {
  planId: string;
  title: string;
  narrative: string;
  totalDurationMinutes: number;
  totalWalkMinutes: number;
  transfers: number;
  finalArrivalAt: string;
  realtimeEligible: boolean;
  worstTimeReliability: CandidateTimeReliability;
  finalArrivalWindowStartAt?: string | null;
  finalArrivalWindowEndAt?: string | null;
  safetyBufferCost: number;
};

export type PlannerCandidateDto = {
  id: string;
  kind: PlanPreference;
  score: number;
  summary: CandidateSummary;
  legs: CandidateLeg[];
  warnings: CandidateWarning[];
};

export type PlannerResultDto = {
  planId: string;
  startAt: string;
  includeGeneratedTimes: boolean;
  timeReliabilityMode: TimeReliabilityMode;
  nextSuggestedTimeReliabilityMode?: TimeReliabilityMode;
  preference?: PlanPreference;
  places: Array<{
    placeId: string;
    displayName: string;
    dwellMinutes: number;
  }>;
  candidates: PlannerCandidateDto[];
  fallbackMessage?: string;
};

export type SearchResultDto = {
  id: string;
  kind: "place" | "stop";
  displayName: string;
  categoryLabel: string;
  regionName: string;
  latitude: number;
  longitude: number;
  meta: Record<string, unknown>;
};

export type ExecutionStatusDto = {
  sessionId: string;
  status: SessionStatus;
  realtimeApplied: boolean;
  delayMinutes: number;
  nextActionAt: string | null;
  replacementSuggested: boolean;
  notice: string;
  realtimeReason?: string | null;
  currentLegIndex: number;
  currentLeg: CandidateLeg | null;
  nextLeg: CandidateLeg | null;
  summary: CandidateSummary;
  legs: CandidateLeg[];
};

export type CandidateMetrics = {
  totalDurationMinutes: number;
  totalWalkMinutes: number;
  transfers: number;
  finalArrivalMinutes: number;
  worstTimeReliability: CandidateTimeReliability;
  finalArrivalWindowStartMinutes: number | null;
  finalArrivalWindowEndMinutes: number | null;
  roughWindowMinutes: number;
  safetyBufferCost: number;
  realtimeEligible: boolean;
};
