# Jeju Bus Guide Tour Plan

제주 버스 기반 관광 동선 추천과 실행 세션 추적을 제공하는 Next.js 애플리케이션입니다.

사용자가 2~5개의 장소와 각 장소의 체류 시간을 입력하면, 현재 적재된 정류장/노선/시간표/도보 링크를 기반으로 다음 3개의 후보 동선을 계산합니다.

- `FASTEST`
- `LEAST_WALK`
- `LEAST_TRANSFER`

결과는 `/planner/results/[planId]`에서 비교하고, 선택한 동선은 `/planner/execute/[sessionId]`에서 실행 세션으로 확인합니다.

이 문서는 `2026-03-27` 기준 코드와 로컬 `dev.db` 상태를 함께 반영합니다.

## 2026-03-27 업데이트

- 플래너 시간 신뢰도 모델이 `공식 / 추정 / 대략` 3단계로 확장되었습니다.
- 입력 계약은 `includeGeneratedTimes:boolean` 중심에서 `timeReliabilityMode` 중심으로 이동했습니다.
- `ALLOW_ROUGH`는 항상 `fallback-only`입니다.
  - 먼저 `INCLUDE_ESTIMATED`로 계산합니다.
  - 후보가 1개라도 있으면 그 결과를 그대로 반환합니다.
  - 후보가 0개일 때만 rough graph를 사용해 한 번 더 계산합니다.
- `ROUGH` 시각은 단일 분 값이 아니라 범위로 표시합니다.
- `DerivedStopTime`에 `windowStartMinutes` / `windowEndMinutes`가 추가되었습니다.
- 결과 화면, 실행 세션 화면, 관리자 화면이 새 신뢰도 모델을 반영합니다.
- 관리자 지표에서 기존 `generated` 집계를 `estimated`와 `rough`로 분리했습니다.
- 레거시 호환을 위해 `includeGeneratedTimes`는 계속 받지만 다음처럼 매핑됩니다.
  - `false -> OFFICIAL_ONLY`
  - `true -> INCLUDE_ESTIMATED`

## 현재 로컬 스냅샷

다음 수치는 로컬 `dev.db` 기준 현재 상태입니다.

- 활성 `Route`: `198`
- 활성 `RoutePattern`: `863`
- 활성 `RoutePatternScheduleSource`: `642`
- 활성 `Trip`: `8,995`
- 공식 시각이 있는 정류장 수: `687`
- 생성 시각이 있는 정류장 수: `1,695`
- 그중 `estimated` 생성 정류장 수: `1,695`
- 그중 `rough` 생성 정류장 수: `0`
- 검색 가능한 정류장 수: `2,080`
- 아직 공식/생성 시각이 모두 없는 정류장 수: `779`
- 활성 source인데 trip이 0개인 경우: `0`

현재 로컬 DB에는 `roughGeneratedStopCount = 0`입니다. 이유는 rough 생성 로직은 이미 코드에 들어갔지만, 이 문서 시점의 로컬 `timetables-xlsx` 결과가 해당 코드 반영 이전 데이터이기 때문입니다. 실제 rough row를 DB에 반영하려면 `timetables-xlsx`를 다시 실행해야 합니다.

최신 ingest 기준:

- 최신 `routes-html` 성공 시각: `2026-03-26 12:00:12 KST`
- 최신 `timetables-xlsx` 성공 시각: `2026-03-26 13:38:41 KST`
- `routes-html`
  - `matched variant`: `628`
  - `unmatched variant`: `59`
  - `skipped variant`: `83`
- `timetables-xlsx`
  - `schedule source`: `642`
  - `trip`: `8,995`
  - `derived stop time`: `146,875`

## 시간 신뢰도 모델

### 1. `OFFICIAL`

- 실제 `StopTime`
- 공식 시각만 사용
- UI에서는 정확한 시각으로 표시

### 2. `ESTIMATED`

- `DerivedStopTime.timeSource = OFFICIAL_ANCHOR_INTERPOLATED`
- 공식 anchor 사이를 보수적으로 보간한 값
- UI에서는 정확한 시각처럼 보이지만 경고가 붙을 수 있음

### 3. `ROUGH`

- `DerivedStopTime.timeSource = DISTANCE_INTERPOLATED`
- `windowStartMinutes` / `windowEndMinutes`를 함께 가짐
- UI에서는 범위로 표시
- realtime 보정 대상에서 제외
- `ALLOW_ROUGH` 모드에서만 사용되고, 그것도 `fallback-only`

### 요청 모드

| 모드 | 그래프에 포함되는 시간 |
| --- | --- |
| `OFFICIAL_ONLY` | `StopTime`만 |
| `INCLUDE_ESTIMATED` | `StopTime` + `OFFICIAL_ANCHOR_INTERPOLATED` |
| `ALLOW_ROUGH` | 내부적으로 먼저 `INCLUDE_ESTIMATED`를 시도하고, 실패 시에만 `DISTANCE_INTERPOLATED`까지 포함 |

### 점수 패널티

- `OFFICIAL`: 추가 패널티 없음
- `ESTIMATED`: `+6`
- `ROUGH`: `+18 + roughWindowMinutes`

즉 같은 조건이면 `OFFICIAL < ESTIMATED < ROUGH` 순으로 항상 불리하게 평가됩니다.

## Planner 동작 방식

1. `/planner` UI에서 장소를 검색합니다.
2. 각 장소를 `osrm-foot` 기반 동적 place-stop 링크로 주변 정류장과 연결합니다.
3. 활성 노선/패턴/시간표 source/도보 링크를 이용해 planner graph를 구성합니다.
4. round-based 검색으로 후보 구간을 만들고 3개의 preference 결과를 고릅니다.
5. 결과는 `PlanQuery` / `PlanCandidate`에 저장되고, 이후 실행 세션 snapshot으로 이어집니다.

### 현재 planner graph에 포함되는 것

- `Stop`
- `WalkLink(kind=STOP_STOP)`
- `RoutePattern`
- `Trip`
- `StopTime`
- 선택적으로 `DerivedStopTime`

### place -> stop 연결

- place-stop 링크는 요청 시점마다 `osrm-foot`로 다시 계산합니다.
- 현재 기본 상수:
  - crow-distance prefilter: 상위 `24`개 정류장
  - 최종 사용: 상위 `12`개 정류장
  - 장소 반경: `3km`
  - place-stop 최대 도보: `25분`

## Worker / Timetable Materialization

### 주요 job

| Job key | 주요 write 대상 | 설명 |
| --- | --- | --- |
| `stops` | `Stop`, `StopTranslation` | BIS 정류장 적재 |
| `routes-openapi` | `Route` | 활성 route master |
| `route-patterns-openapi` | `RoutePattern`, `RoutePatternStop` | stop-level 패턴 적재 |
| `routes-html` | `RoutePatternScheduleSource` | HTML 시간표와 패턴 authoritative matching |
| `route-geometries` | `RoutePatternGeometry`, `RoutePatternStopProjection` | geometry / projection 적재 |
| `timetables-xlsx` | `Trip`, `StopTime`, `DerivedStopTime` | sparse official + derived stop time 생성 |
| `walk-links` | `WalkLink` | stop-stop 도보 그래프 |
| `vehicle-device-map` | `VehicleDeviceMap` | realtime 보조 매핑 |
| `gnss-history` | `GnssObservation` | GNSS 수집 |

### `timetables-xlsx`의 2단계 파생 시간 생성

#### strict estimated pass

기존 보수적 보간 로직입니다.

- `timeSource = OFFICIAL_ANCHOR_INTERPOLATED`
- 대략 다음 guardrail을 만족할 때만 생성
  - interior stop gap 제한
  - anchor span distance 제한
  - anchor span time 제한
  - projection confidence / snap distance 제한

#### rough pass

이번 변경에서 추가된 로직입니다.

- 대상은 이미 authoritative source로 만들어진 `Trip` 내부의 빈 정류장만입니다.
- `RoutePatternStop.distanceFromStart`를 우선 사용합니다.
- 그 값이 불안정할 때만 projection `offsetMeters`를 fallback으로 사용합니다.
- 다음 조건을 만족할 때만 rough row를 생성합니다.
  - 공식 anchor 2개 이상
  - interior stop 수 `<= 20`
  - anchor span `<= 20km`
  - anchor span `<= 70분`
  - 진행 거리 monotonic
- `timeSource = DISTANCE_INTERPOLATED`
- `confidence < 0.5`
- `windowStartMinutes` / `windowEndMinutes`를 함께 저장합니다.

## API 요약

### `GET /api/search`

query params:

- `kind`: `place | stop`
- `q`
- `limit`: `1..20`, 기본 `8`
- `includeGeneratedStops`: stop search에서만 의미 있음

### `POST /api/planner/plan`

주요 입력:

```json
{
  "language": "ko",
  "startAt": "2026-03-27T09:00:00+09:00",
  "timeReliabilityMode": "INCLUDE_ESTIMATED",
  "places": [
    {
      "mode": "stored",
      "placeId": "..."
    }
  ]
}
```

레거시 호환:

- `includeGeneratedTimes=false`는 `OFFICIAL_ONLY`로 해석
- `includeGeneratedTimes=true`는 `INCLUDE_ESTIMATED`로 해석

주요 응답 필드:

- `planId`
- `timeReliabilityMode`
- `nextSuggestedTimeReliabilityMode`
- `candidates`
- `fallbackMessage`

`nextSuggestedTimeReliabilityMode`는 현재 모드에서 후보가 없지만 상위 모드에서 후보가 있을 때만 채워집니다.

### `POST /api/planner/session`

```json
{
  "planCandidateId": "..."
}
```

### `GET /api/planner/session/[id]`

주요 필드:

- `status`
- `currentLeg`
- `nextLeg`
- `nextActionAt`
- `realtimeApplied`
- `delayMinutes`
- `replacementSuggested`
- `notice`
- `summary`
- `legs`

`ROUGH` leg는 시간 범위를 포함할 수 있고 realtime 보정을 시도하지 않습니다.

## UI 반영 상태

### Planner 입력 화면

- 기존 체크박스 대신 3단계 selector 사용
  - `공식만`
  - `추정 포함`
  - `대략까지 허용`

### 결과 화면

- 후보 요약에 현재 계산 모드 표시
- `ROUGH` 후보는 badge와 안내 문구 표시
- `ROUGH` leg와 최종 도착 시각은 범위로 표시

### 실행 세션 화면

- snapshot의 `timeReliability`를 그대로 사용
- `ROUGH` leg는 범위로 표시
- `ROUGH` leg는 realtime 보정에서 제외

### 관리자 화면

- 기존 `Generated Stop` 외에
  - `Estimated Stop`
  - `Rough Stop`
  를 따로 표시

## 현재 남아 있는 주요 문제

### 1. authoritative matching이 안 되는 일반 노선

시간표 HTML 페이지는 있는데 내부 stop-level pattern에 authoritative하게 붙이지 못하는 노선이 아직 남아 있습니다. 대표적인 예가 `771-2` 계열입니다.

핵심 문제는 "시간표가 없다"가 아니라 "시간표의 timing point 집합이 내부 패턴과 충분히 정확하게 대응되지 않는다"입니다.

### 2. trip은 있지만 branch / 소정류장까지 시간이 완전히 내려가지 않는 경우

strict estimated와 rough는 모두 "이미 trip이 있는 패턴"만 다룹니다. 따라서 branch 분기나 세부 정류장 커버리지가 부족한 경우는 여전히 남아 있습니다.

### 3. realtime은 아직 완전 wiring 전

GNSS, vehicle-device-map, delay 추정 helper는 존재하지만, planner 결과 자체가 실시간 재탐색까지 수행하는 구조는 아닙니다. 실행 세션은 기본적으로 snapshot / timetable 중심입니다.

### 4. special route는 일반 planner 네트워크에서 제외

다음 계열은 현재 일반 planner coverage 계산에서 제외합니다.

- `임시`
- `우도`
- `옵서버스`
- `관광지순환`
- `마을버스`

## Schedule Matching 진단

현재 `routes-html` 진단 메타에서 바로 확인할 수 있는 항목:

- `matchedVariants`
- `unmatchedVariants`
- `skippedSpecialSchedules`
- `nearMisses`
- `rejectionBreakdown`
- `resolvedMixedVariantSchedules`
- `unresolvedMixedVariantSchedules`
- `inheritedVariantRowCount`
- `unresolvedVariantRowCount`

현재 로컬 기준:

- mixed variant unresolved schedule: `0`
- inherited variant row count: `21`
- rejection breakdown 상위:
  - `low_coverage`: `25`
  - `authoritativeness_gap`: `14`
  - `sparse_profile`: `13`
  - `no_candidates`: `3`
  - `processing_error(fetch failed)`: `2`
  - `processing_error(timeout)`: `2`

## Planner readiness

`GET /api/search`와 `POST /api/planner/plan`은 같은 readiness 체크를 사용합니다.

필수 successful job:

- `stops`
- `routes-openapi`
- `route-patterns-openapi`
- `routes-html`
- `route-geometries`
- `timetables-xlsx`
- `walk-links`

추가 조건:

- `stopCount > 0`
- `routePatternCount > 0`
- `tripCount > 0`
- `timetableRoutePatternCount > 0`
- `walkLinkCount > 0`
- `KAKAO_REST_API_KEY` 존재

## 개발 / 실행

### 설치

```bash
npm install
copy .env.example .env
```

### DB 초기화

```bash
npm run prisma:push
npm run prisma:seed
```

### 개발 서버

```bash
npm run dev
```

### 앱만 실행

```bash
npm run dev:app -- --port 5176
```

### OSRM만 실행 / 종료

```bash
npm run dev:osrm
npm run dev:osrm:stop
```

### 주요 worker 실행 예시

```bash
npm run worker -- --job stops
npm run worker -- --job routes-html
npm run worker -- --job route-geometries
npm run worker -- --job timetables-xlsx
npm run worker -- --job gnss-history
npm run worker:run-all
```

rough row를 실제 DB에 채우려면 이번 코드 반영 후 `timetables-xlsx`를 다시 실행해야 합니다.

## 권장 재적재 순서

1. `stops`
2. `stop-translations` (선택)
3. `routes-openapi`
4. `route-patterns-openapi`
5. `routes-html`
6. `route-geometries`
7. `timetables-xlsx`
8. `walk-links`

realtime 보조 데이터까지 보강하려면 추가로:

1. `vehicle-device-map`
2. `gnss-history`

## 검증 명령

```bash
npm run typecheck
npm test
npm run build
```

이 문서를 갱신한 시점의 코드 검증 상태:

- `npm run typecheck` 통과
- `npm test` 통과
- Vitest `23`개 파일, `106`개 테스트 통과

## 프로젝트 구조

```text
app/                      Next.js App Router pages and API routes
src/components/           UI components
src/features/admin/       Admin dashboard queries
src/features/planner/     Search, planning, scoring, session logic
src/lib/                  Env, db, GTFS, OSRM, geometry, source catalog
prisma/                   Prisma schema and seed
tests/                    Vitest tests
worker/core/              Worker runtime and job runner
worker/jobs/              Ingest jobs and parsing helpers
scripts/                  dev / OSRM / GTFS probe scripts
docker/osrm/              OSRM datasets and profiles
```
