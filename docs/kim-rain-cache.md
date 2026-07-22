# KIM Rain Precompute Cache

KIM hourly rainfall frames are stored in Cloudflare KV so that viewers do not
re-download and process the KMA source grid for every edge location.

## Runtime flow

1. `weathernow-kim-precompute` runs every 5 minutes.
2. It checks the latest complete KIM local-model cycle.
3. It creates one missing future frame per run and writes it to KV.
4. The Pages Function reads KV first.
5. If a frame is not ready, the existing live calculation remains as a fallback
   and the result is also written to KV.
6. The newest three model cycles are retained.

The browser eagerly downloads all precomputed frames and only the nearest three
frames that are not ready. This prevents a new cycle from causing one viewer to
trigger the entire forecast range at once.

## Cloudflare resources

- KV namespace: `KIM_RAIN_CACHE`
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

The Pages Function will immediately bypass KV and use the previous edge-cache
and live KMA calculation path. The KV data and scheduled Worker can remain in
place without affecting responses.
