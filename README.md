# weathernow

KBS 재난미디어센터용 기상 정보 포털입니다. React, Vite, Tailwind CSS 기반으로 작성되어 있으며 KMA 프록시와 Cloudflare Pages Functions 구성을 포함합니다.

## Local Development

1. `.env`에 KMA 인증키를 설정합니다.
2. `npm install`
3. `npm run dev`

## Build Checks

- `npm run build`
- `npm run lint`

## Auto Push

이 저장소는 `.githooks/post-commit` 훅을 사용합니다.

- 커밋이 성공하면 현재 브랜치를 자동으로 `origin`에 푸시합니다.
- 업스트림이 없는 브랜치라면 처음 한 번 `origin/<branch>`로 연결한 뒤 푸시합니다.
- 로그는 `.git/.codex-hooks/post-commit.log`에 남습니다.

주의:

- 자동 업로드는 `커밋 이후`에 동작합니다. 파일 저장만으로는 푸시되지 않습니다.
- 원격 인증이 풀려 있으면 자동 푸시는 실패할 수 있습니다.
