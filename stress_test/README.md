# stress_folder

`k6`보다 가볍게 요청만 밀어 넣는 Node 기반 부하 스크립트입니다.
모든 설정은 `stress_folder/.env`에서 읽습니다.

## 파일
- `http_stress.js`: 의존성 없이 실행되는 경량 HTTP 스트레스 도구
- `max_users_1hz.js`: 사용자당 1초마다 `POST /api/posts` + `GET /api/posts` 수행 시 최대 동시 사용자 추정
- `load_env.js`: `.env` 로더
- `.env`: 실행 설정 파일
- `.env.example`: 템플릿

## 빠른 실행

1) `stress_folder/.env` 수정
2) 실행:

```bash
cd /root/home/stress_folder
node http_stress.js
```

## 주요 환경변수
- `TARGET` 기본 `http://127.0.0.1:8080/healthz`
- `METHOD` 기본 `GET`
- `WORKERS` 기본 `(CPU 코어 - 1)`
- `PROGRESS_INTERVAL_SEC` 기본 `5` (`0`이면 진행 로그 비활성화)
- `CONCURRENCY_PER_WORKER` 기본 `256`
- `DURATION_SEC` 기본 `60`
- `TARGET_HZ` 기본 `1` (사용자 1명당 초당 사이클 수; 1사이클=`POST+GET`)
- `REQUEST_TIMEOUT_MS` 기본 `3000`
- `MAX_SOCKETS_PER_WORKER` 기본 `max(CONCURRENCY_PER_WORKER*2, 512)`
- `KEEP_ALIVE` 기본 `true`
- `HEADERS` 예: `Authorization:Bearer xxx;X-Foo:bar`
- `BODY` POST/PUT payload

## 단계별 사용자 탐색 (1Hz write+get, binary 없음)

각 사용자가 매초 아래를 1회 수행한다고 가정합니다.
- `POST /api/posts`
- `GET /api/posts`

`USERS>0`이면 단일 단계만 수행합니다.
`USERS=0`이면 `START_USERS`부터 `MAX_USERS`까지 `STAGE_STEP` 단위로 단계 테스트를 수행합니다.
binary 탐색은 하지 않습니다.
`USER_START_SPREAD_MS=0`이면 유저 시작 지터 없이 최대한 동시에 동일 패턴으로 부하를 보냅니다.

```bash
cd /root/home/stress_folder
node max_users_1hz.js
```

마지막에 `last_pass_users`, `first_fail_users`를 출력합니다.
각 단계에서 아래를 출력합니다.
- login/cycle 성공/실패 개수 + 비율
- `login`, `create_post`, `list_posts`별 `avg`, `mean`, `min`, `max`, `p95`, `p99`, `p99.9`
- 요청 status 분포(2xx/3xx/4xx/5xx), timeout 개수

## 팁
- 생성기 병목을 줄이려면 `WORKERS`와 `CONCURRENCY_PER_WORKER`를 단계적으로 올리세요.
- ingress/서버와 부하 생성기를 분리한 머신에서 돌리는 것이 가장 정확합니다.
