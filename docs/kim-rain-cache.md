# KIM Rain Precompute Cache

KIM hourly rainfall frames are stored in Cloudflare R2 so that viewers do not
re-download and process the KMA source grid for every edge location.

## Runtime flow

1. `weathernow-kim-precompute` runs every 10 minutes.
2. It checks the latest complete KIM local-model cycle.
3. It creates up to six missing future frames per run and writes them to R2.
4. The Pages Function reads R2 first.
5. If a frame is not ready, the existing live calculation remains as a fallback
   and the result is also written to R2.
6. The newest three model cycles are retained.

The browser eagerly downloads all R2-ready frames and only the nearest three
frames that are not ready. This prevents a new cycle from causing one viewer to
trigger the entire forecast range at once.

## Cloudflare resources

- R2 bucket: `weathernow-kim-rain`
- Pages binding: `KIM_RAIN_CACHE`
- Worker: `weathernow-kim-precompute`
- Worker config: `wrangler.kim-cache.toml`
- Worker secret: `KMA_BROADCAST_AUTH_KEY`
- Optional Worker secret: `CACHE_REFRESH_TOKEN`

Deploy the Worker with:

```powershell
npm run cf:kim:deploy
```

The Worker status endpoint is:

```text
https://weathernow-kim-precompute.<account-subdomain>.workers.dev/status
```

## Rollback

Set the following Pages environment variable and redeploy:

```text
DISABLE_PRECOMPUTED_KIM=1
```

The Pages Function will immediately bypass R2 and use the previous edge-cache
and live KMA calculation path. The R2 objects and scheduled Worker can remain in
place without affecting responses.
