# GK2A Satellite Cache

The broadcast satellite view stores processed GK2A IR105 frames in Cloudflare
KV. The NOAA NetCDF source is downloaded and converted only once per timestamp.

## Data flow

1. `weathernow-satellite-precompute` checks for a new source frame every minute.
2. It checks the latest NOAA GK2A timestamp and the previous 12-hour timeline.
3. Up to two missing timestamps are requested from the Pages Function.
4. The Pages Function creates both the detailed `ko` and background `fd`
   outputs from one source file, combines them, compresses the pair, and writes
   it to KV.
5. The browser requests three timestamps as one 30-minute bundle. A missing
   timestamp falls back to the existing live conversion path and is then stored
   for subsequent viewers.

Processed pairs expire after 20 hours. The browser-visible 12-hour timeline is
therefore retained with enough margin for source publication delays.

## Cloudflare resources

The existing `KIM_RAIN_CACHE` namespace is reused so no new Pages binding is
required. Satellite keys are isolated under `satellite/gk2a-ir/v1/`.

- Pages binding: `KIM_RAIN_CACHE`
- Scheduled Worker binding alias: `SATELLITE_CACHE`
- Worker: `weathernow-satellite-precompute`
- Worker config: `wrangler.satellite-cache.toml`

Deploy the scheduled Worker with:

```powershell
npx wrangler deploy --config wrangler.satellite-cache.toml
```

Status endpoint:

```text
https://weathernow-satellite-precompute.skyclear.workers.dev/status
```

## Rollback

Set the following Pages environment variable and redeploy:

```text
DISABLE_PRECOMPUTED_SATELLITE=1
```

The Pages Function then bypasses KV and uses the previous NOAA live conversion
and edge-cache path. The scheduled Worker can remain deployed or be disabled
independently.
