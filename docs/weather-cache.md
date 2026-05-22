# Weather Cache Precompute

배포 환경에서 기상청 API 응답 지연이 생길 때를 줄이기 위해, 기온/강수 랭킹과 특보 이미지 URL을 Cloudflare KV에 미리 저장하는 구조를 추가했다.

## 구조

- `workers/weather-precompute.js`: Cron Trigger로 실행되는 Worker다. 기상청 API를 호출해 랭킹과 특보 이미지 URL을 미리 계산하고 KV에 저장한다.
- `functions/api/rankings.js`: Pages Function이다. `WEATHER_CACHE` KV에 신선한 데이터가 있으면 먼저 반환하고, 없거나 오래됐으면 기존 실시간 계산으로 fallback한다.
- `functions/api/weather-warning.js`: 특보 이미지 URL도 같은 방식으로 KV 우선, 실시간 조회 fallback을 사용한다.
- `wrangler.weather-cache.example.toml`: Worker 배포용 예시 설정이다. 실제 KV namespace ID를 넣어 사용한다.

## KV 저장 키

- `rankings:temperature-current`
- `rankings:temperature-today`
- `rankings:precipitation-current`
- `rankings:precipitation-since-yesterday`
- `warning-images`

각 값은 아래 형태로 저장된다.

```json
{
  "generatedAt": "2026-05-22T00:00:00.000Z",
  "payload": {}
}
```

## Cloudflare 설정

1. KV namespace를 만든다.
2. Pages 프로젝트에 KV binding을 추가한다.
   - Binding name: `WEATHER_CACHE`
   - 같은 KV namespace를 연결한다.
3. Worker에도 같은 KV namespace를 `WEATHER_CACHE`로 연결한다.
4. Worker secret/env를 설정한다.
   - `KMA_AUTH_KEY`: 기상청 API Hub 인증키
   - `CACHE_REFRESH_TOKEN`: 수동 갱신 API 보호용 임의 문자열
5. `wrangler.weather-cache.example.toml`을 복사해 `wrangler.toml`로 만들고 KV namespace ID를 채운다.
6. Worker를 배포한다.

```powershell
Copy-Item wrangler.weather-cache.example.toml wrangler.toml
wrangler kv namespace create WEATHER_CACHE
wrangler kv namespace create WEATHER_CACHE --preview
wrangler secret put KMA_AUTH_KEY
wrangler secret put CACHE_REFRESH_TOKEN
wrangler deploy
```

## 확인 방법

Worker 상태:

```text
https://<worker-domain>/status
```

수동 갱신:

```powershell
Invoke-WebRequest `
  -Headers @{ Authorization = "Bearer <CACHE_REFRESH_TOKEN>" } `
  https://<worker-domain>/refresh
```

웹앱 API 응답 헤더에서 데이터 출처를 확인할 수 있다.

- `X-Weather-Data-Source: kv`: KV의 신선한 사전 계산 데이터 사용
- `X-Weather-Data-Source: live`: 기존 방식으로 실시간 계산
- `X-Weather-Data-Source: stale-kv`: 실시간 계산 실패 시 오래된 KV 데이터 사용

## 복구 방법

문제가 생기면 우선 코드 롤백 없이 Pages 환경변수에 아래 값을 추가한다.

```text
DISABLE_PRECOMPUTED_WEATHER=1
```

이 값을 켜면 Pages Functions가 KV를 읽지 않고 기존 실시간 계산 방식으로 동작한다. Worker는 배포되어 있어도 웹앱 응답에는 영향을 주지 않는다.

완전히 이전 코드로 되돌려야 하면 이번 작업 전 기준 커밋은 아래다.

```text
f0347d5 Run Pages function APIs in local Vite dev
```

필요 시 해당 커밋으로 새 브랜치를 만들거나 revert 커밋을 만들면 된다. 운영 중에는 `git reset --hard`보다 revert 커밋을 권장한다.
