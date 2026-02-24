<div align="right">

**Language**: [한국어](./readme.md) | [English](./readme_en.md)

</div>

<div align="center">

# Clustering Project
### RocksDB 기반 분산 KVS + Node.js Backend + Ingress 실험 환경

고부하 환경에서 안정성, 지연 시간, 확장성을 검증하기 위한 멀티노드 실험 프로젝트입니다.

</div>

## 한눈에 보기

| 영역 | 경로 | 역할 |
|---|---|---|
| Ingress | `ingress/` | 외부 트래픽 진입점, least-inflight 라우팅, circuit breaker, admission control |
| Node (개별 노드) | `node/` | `kvs`(C++/RocksDB) + `server/backend`(Node.js API) |
| 실험 도구 | `stress_test/`, `create_account.js` | 부하 생성, 사용자 계정 대량 생성, 실험 반복 자동화 |

## 아키텍처

<p align="center">
  <img src="./img/Diagram.png" alt="클러스터 아키텍처 다이어그램" width="1000" />
</p>

## 핵심 특징

- Ingress: least-inflight 라우팅, queue timeout 기반 load shedding, upstream circuit breaker
- Backend: 무상태 토큰 인증, admission control, `/api/posts` 캐시와 중복 요청 억제
- KVS: RocksDB 기반 분산 저장소, 노드 간 replication/fan-out read
- 실험: Node 기반 경량 스트레스 테스트 + 계정 시드 스크립트

## 저장소 구조

```text
.
├── ingress/                 # Ingress 서버 (Node.js)
├── node/                    # 개별 노드
│   ├── kvs/                 # KVS 서버 (C++ / RocksDB)
│   └── server/backend/      # API 서버 (Node.js)
├── stress_test/             # 부하 테스트 스크립트
├── create_account.js        # 계정 대량 생성/검증 스크립트
├── readme.md                # 한국어 문서
└── readme_en.md             # English documentation
```

## 빠른 시작

### 1) 사전 준비

- Node.js 18+
- npm
- CMake 3.10+
- C++17 컴파일러
- RocksDB 및 링크 라이브러리(`snappy`, `zstd`, `zlib`, `bz2`, optional `lz4`)

### 2) 환경 파일 준비

```bash
cp node/.env.example node/.env
cp ingress/.env.example ingress/.env
cp stress_test/.env.example stress_test/.env
```

### 3) Node 의존성 설치

```bash
cd ingress && npm install
cd ../node/server/backend && npm install
```

### 4) KVS 빌드

```bash
cd /root/2025/clustering_project/node/kvs
cmake -S . -B build
cmake --build build -j"$(nproc)"
```

## 실행 순서

각 프로세스는 별도 터미널에서 실행하는 것을 권장합니다.

### 1) KVS 실행

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env ./node/kvs/build/kvsd
```

### 2) Backend 실행

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env node node/server/backend/server.js
```

### 3) Ingress 실행

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/ingress/.env node ingress/server.js
```

### 4) 헬스체크

```bash
curl http://<ingress-host>:8080/healthz
curl http://<backend-host>:3000/healthz
```

## 실험 세팅

### A. 계정 시드 생성 (`create_account.js`)

`create_account.js`는 `POST /api/register -> POST /api/login -> GET /api/me`를 순서대로 수행해 계정 생성 및 인증 가능 여부를 검증하고, 결과를 `create_accounts_trace.json`으로 기록합니다.

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env \
BASE_URL=http://127.0.0.1:8080 \
USER_COUNT=1000 \
CONCURRENCY=32 \
node create_account.js
```

주요 옵션:
- `USER_COUNT`, `START_INDEX`, `CONCURRENCY`
- `EMAIL_PREFIX`, `EMAIL_DOMAIN`, `PASSWORD`
- `REQUEST_TIMEOUT_MS`, `REQUEST_RETRIES`
- `TRACE_PATH`

### B. 부하 테스트 (`stress_test/`)

```bash
cd /root/2025/clustering_project/stress_test
node http_stress.js
node max_users_1hz.js
```

- `http_stress.js`: 고정 타겟에 연속 요청을 보내며 RPS/오류율 확인
- `max_users_1hz.js`: 사용자당 1Hz(`POST + GET`) 기준 최대 동시 사용자 범위 탐색

## 환경변수 파일 가이드

- `node/.env`: 개별 노드(KVS + Backend) 설정
- `ingress/.env`: Ingress 라우팅 및 보호 정책 설정
- `stress_test/.env`: 실험 강도, 성공 기준, 타임아웃 설정

## 실험 과정 및 결과 (`result/` 기준)

### 1) 실험 인프라

모든 실험 노드는 동일 스펙으로 구성했습니다.

- Provider: Kamatera (Tokyo)
- OS: Ubuntu 24.04 64bit
- Availability Type
- vCPU: 2
- RAM: 2GB
- SSD: 20GB

토폴로지 구성:

- `Single Node`: `(1node) + (ingress + max_users_1hz.js)` = 총 3개 노드
- `3-Node`: `(3node) + (ingress + max_users_1hz.js)` = 총 4개 노드

### 2) 실험 조건

`max_users_1hz.js` 기준으로 아래 설정을 사용했고, 실험 중 변경한 값은 `USERS`, `BASE_URL`만입니다.
문서에는 주소 노출을 피하기 위해 `BASE_URL`을 마스킹했습니다.

```dotenv
USERS=1000
# Common
BASE_URL=http://<ingress-host>:8080
REQUEST_TIMEOUT_MS=3000
WORKERS=4
PROGRESS_INTERVAL_SEC=5

# http_stress.js
TARGET=http://<ingress-host>:8080/healthz
METHOD=GET
CONCURRENCY_PER_WORKER=256
DURATION_SEC=30
TARGET_HZ=1
MAX_SOCKETS_PER_WORKER=1024
KEEP_ALIVE=true
PRINT_INTERVAL_MS=1000

# max_users_1hz.js
PASSWORD=Passw0rd!
EMAIL_PREFIX=k6user
EMAIL_DOMAIN=example.com
USER_START_INDEX=1
USER_START_SPREAD_MS=0
GET_PATH=/api/posts
POST_PATH=/api/posts
MIN_LOGIN_OK_RATE=0.98
MIN_CYCLE_OK_RATE=0.98
POST_P95_MS=1500
GET_P95_MS=1500
LOGIN_CONCURRENCY=64
```

### 3) 데이터 소스 및 판정 기준

- 원본 집계: `result/full_experiment_records.csv`
- 시각화: `result/*.png`
- 파일명 규칙: `{users}_{single|3node}.txt`
- 단계 통과 기준:
  - `cycle_ok_rate >= 98%`
  - `login_ok_rate >= 98%`
  - `create_post_p95 <= 1500ms`
  - `list_posts_p95 <= 1500ms`

### 4) 핵심 결과 요약

| 항목 | Single Node | 3-Node |
|---|---:|---:|
| 기준 충족 최대 사용자 수 | 1500 | 2000 |
| 1750 users cycle 성공률 | 81.36% | 99.99% |
| 2000 users cycle 성공률 | 59.71% | 100.00% |
| 2000 users create 성공률 | 79.73% | 100.00% |
| 2000 users list 성공률 | 73.04% | 100.00% |
| 2500 users cycle 성공률 | 52.09% | 96.21% |
| 3000 users cycle 성공률 | 62.61% | 95.72% |

관찰 포인트:

- `Single Node`는 1750 users부터 성공률이 급격히 하락했고, 통과 기준은 1500 users에서 멈췄습니다.
- `3-Node`는 2000 users까지 기준을 만족했으며, 고부하 구간(2000+)에서도 성공률 하락 폭이 상대적으로 작았습니다.
- 다만 `3-Node`도 2500 users 이후에는 `cycle_ok_rate` 또는 지연시간 기준을 넘어서기 시작해 `pass=no`가 발생했습니다.

### 5) 그래프

성공률 그래프:

![create_success_rate](./result/create_success_rate.png)
![list_success_rate](./result/list_success_rate.png)
![cycle_success_rate](./result/cycle_success_rate.png)

`create_post` 지연시간 그래프:

![create_post_min](./result/create_post_min.png)
![create_post_mean](./result/create_post_mean.png)
![create_post_max](./result/create_post_max.png)
![create_post_p95](./result/create_post_p95.png)
![create_post_p99](./result/create_post_p99.png)
![create_post_p99.9](./result/create_post_p99.9.png)

`list_posts` 지연시간 그래프:

![list_posts_min](./result/list_posts_min.png)
![list_posts_mean](./result/list_posts_mean.png)
![list_posts_max](./result/list_posts_max.png)
![list_posts_p95](./result/list_posts_p95.png)
![list_posts_p99](./result/list_posts_p99.png)
![list_posts_p99.9](./result/list_posts_p99.9.png)

## Git 추적 정책

현재 `.gitignore`는 아래만 제외합니다.

- 의존성 코드: `**/node_modules/`
- 비밀 설정: `**/.env` (`.env.example`은 커밋 가능)
- Node DB 내용물: `node/**/db/**` (디렉터리 자체는 유지)

즉, 위 항목 외에는 실험 코드와 설정을 모두 커밋하는 정책입니다.
