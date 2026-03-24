# 제주 버스 여행 플래너 MVP

플랜 문서를 기준으로 빈 워크스페이스에 새로 세운 Next.js + Prisma 기반 구현입니다.

## 시작하기

```bash
npm install
copy .env.example .env
npm run prisma:push
npm run prisma:seed
npm run dev
```

## 포함 범위

- `GET /api/search`
- `POST /api/planner/plan`
- `POST /api/planner/session`
- `GET /api/planner/session/[id]`
- `/planner`
- `/planner/results/[planId]`
- `/planner/execute/[sessionId]`
- Prisma 스키마, 샘플 시드, worker 스켈레톤
