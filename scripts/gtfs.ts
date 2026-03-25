import { appEnv } from "@/lib/env";
import { probeGtfsSource } from "@/lib/gtfs";

async function main() {
  const source = process.argv[2] || appEnv.gtfsFeedUrl || appEnv.gtfsShapesPath;
  if (!source) {
    throw new Error(
      "No GTFS source configured. Pass a zip/directory path or set GTFS_FEED_URL / GTFS_SHAPES_PATH.",
    );
  }

  const result = await probeGtfsSource(source);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown GTFS probe error");
  process.exit(1);
});
