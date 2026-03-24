`npm run dev` now bootstraps this folder automatically.

What it does:
- downloads the Jeju `.osm.pbf` extract when missing
- runs `osrm-extract`
- runs `osrm-partition`
- runs `osrm-customize`
- starts the `osrm` container on port `5000`

Generated dataset basename:
- `jeju-non-military.osrm`

You can still manage it manually with:
- `npm run dev:osrm`
- `npm run dev:osrm:stop`
