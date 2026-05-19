export const defaultJobIntervalMs: Record<string, number> = {
  "vehicle-device-map": 10 * 60 * 1000,
  "gnss-history": 60 * 1000,
  "segment-profiles": 60 * 60 * 1000,
  "observed-timetables": 60 * 60 * 1000,
};

export function getDefaultJobIntervalMs(jobKey: string) {
  return defaultJobIntervalMs[jobKey] ?? 60 * 60 * 1000;
}
