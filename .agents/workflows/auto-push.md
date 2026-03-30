---
description: 깃허브 자동 업로드 워크플로우
---

사용자의 깃허브 저장소(`https://github.com/skyclearLJH/weather`)로 최신 작업 내역을 자동 커밋 및 푸시하는 워크플로우입니다.

안티그래비티가 재시작되어도 이 파일을 읽어 깃허브 업로드를 진행할 수 있습니다.

// turbo-all
```powershell
git add .
git commit -m "Auto-update from Antigravity: UI Components and Logic"
git push origin main
```
