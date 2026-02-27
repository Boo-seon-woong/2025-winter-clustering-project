<div align="right">

**Language**: [한국어](./readme.md) | [English](./readme_en.md)

</div>

<div align="center">

# Clustering Project
### RocksDB 기반 분산 KVS + Node.js Backend + Ingress 실험 환경

고부하 환경에서 안정성, 지연 시간, 확장성을 검증하기 위한 분산 환경 실험 프로젝트입니다.

</div>

<a id="toc-overview"></a>
<details>
<summary><strong>1. 한눈에 보기</strong></summary>

| 영역 | 경로 | 역할 |
|---|---|---|
| Ingress | `ingress/` | 외부 트래픽 진입점, least-inflight 라우팅, circuit breaker, admission control |
| Node (개별 노드) | `node/` | `kvs`(C++/RocksDB) + `server/backend`(Node.js API) |
| 실험 도구 | `stress_test/`, `create_account.js` | 부하 생성, 사용자 계정 대량 생성, 실험 반복 자동화 |

</details>

<a id="toc-architecture"></a>
<details>
<summary><strong>2. 아키텍처</strong></summary>

<p align="center">
  <img src="./img/Diagram.png" alt="클러스터 아키텍처 다이어그램" width="1000" />
</p>

</details>

<a id="toc-key-features"></a>
<details>
<summary><strong>3. 핵심 특징</strong></summary>

- Ingress: least-inflight 라우팅, queue timeout 기반 load shedding, upstream circuit breaker
- Backend: 무상태 토큰 인증, admission control, `/api/posts` 캐시와 중복 요청 억제
- KVS: RocksDB 기반 분산 저장소, 노드 간 replication/fan-out read
- 실험: Node 기반 경량 스트레스 테스트 + 계정 시드 스크립트

</details>

<a id="toc-repo-layout"></a>
<details>
<summary><strong>4. 저장소 구조</strong></summary>

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

</details>

<a id="toc-quick-start"></a>
<details>
<summary><strong>5. 빠른 시작</strong></summary>

<a id="toc-quick-start-1"></a>
### 1) 사전 준비

- Node.js 18+
- npm
- CMake 3.10+
- C++17 컴파일러
- RocksDB 및 링크 라이브러리(`snappy`, `zstd`, `zlib`, `bz2`, optional `lz4`)

<a id="toc-quick-start-2"></a>
### 2) 환경 파일 준비

```bash
cp node/.env.example node/.env
cp ingress/.env.example ingress/.env
cp stress_test/.env.example stress_test/.env
```

<a id="toc-quick-start-3"></a>
### 3) Node 의존성 설치

```bash
cd ingress && npm install
cd ../node/server/backend && npm install
```

<a id="toc-quick-start-4"></a>
### 4) KVS 빌드

```bash
cd /root/2025/clustering_project/node/kvs
cmake -S . -B build
cmake --build build -j"$(nproc)"
```

</details>

<a id="toc-run-order"></a>
<details>
<summary><strong>6. 실행 순서</strong></summary>

각 프로세스는 별도 터미널에서 실행하는 것을 권장합니다.

<a id="toc-run-order-1"></a>
### 1) KVS 실행

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env ./node/kvs/build/kvsd
```

<a id="toc-run-order-2"></a>
### 2) Backend 실행

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env node node/server/backend/server.js
```

<a id="toc-run-order-3"></a>
### 3) Ingress 실행

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/ingress/.env node ingress/server.js
```

<a id="toc-run-order-4"></a>
### 4) 헬스체크

```bash
curl http://<ingress-host>:8080/healthz
curl http://<backend-host>:3000/healthz
```

</details>

<a id="toc-experiment-setup"></a>
<details>
<summary><strong>7. 실험 세팅</strong></summary>

<a id="toc-experiment-setup-a"></a>
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

<a id="toc-experiment-setup-b"></a>
### B. 부하 테스트 (`stress_test/`)

```bash
cd /root/2025/clustering_project/stress_test
node http_stress.js
node max_users_1hz.js
```

- `http_stress.js`: 고정 타겟에 연속 요청을 보내며 RPS/오류율 확인
- `max_users_1hz.js`: 사용자당 1Hz(`POST + GET`) 기준 최대 동시 사용자 범위 탐색

</details>

<a id="toc-env-guide"></a>
<details>
<summary><strong>8. 환경변수 파일 가이드</strong></summary>

- `node/.env`: 개별 노드(KVS + Backend) 설정
- `ingress/.env`: Ingress 라우팅 및 보호 정책 설정
- `stress_test/.env`: 실험 강도, 성공 기준, 타임아웃 설정

</details>

<a id="toc-experiment-result"></a>
<details>
<summary><strong>9. 실험 과정 및 결과</strong></summary>

<dl>
<dd>

<a id="main-sec-1"></a>
<details>
<summary><strong>9-1) 실험 인프라</strong></summary>

서버는 kamatera에서 제공하는 클라우드 서버를 최대 4개까지 이용하였으며, 모든 실험 노드는 동일 스펙으로 구성했습니다.

- Provider: Kamatera (server location:Tokyo)
- OS: Ubuntu 24.04 64bit
- Availability Type
- vCPU: 2
- RAM: 2GB
- SSD: 20GB

토폴로지 구성:

- `Single Node`: `(1node) + (ingress + max_users_1hz.js)` = 총 2개 노드
- `3-Node`: `(3node) + (ingress + max_users_1hz.js)` = 총 4개 노드

</details>

<a id="main-sec-2"></a>
<details>
<summary><strong>9-2) 실험 조건</strong></summary>

`max_users_1hz.js` 기준으로 아래 설정을 사용했고, 실험 중 변경한 값은 `USERS`, `BASE_URL`만입니다.

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

</details>

<a id="main-sec-3"></a>
<details>
<summary><strong>9-3) 판정 기준</strong></summary>

각 사용자 구간(stage)은 아래 기준을 모두 만족하면 `pass=yes`로 판정:

- `cycle_ok_rate >= 98%`
- `login_ok_rate >= 98%`
- `create_post_p95 <= 1500ms`
- `list_posts_p95 <= 1500ms`

</details>

<a id="main-sec-4"></a>
<details>
<summary><strong>9-4) 핵심 결과 (CSV 집계)</strong></summary>

데이터 소스:
- `result/final_result/single_node_result.csv`
- `result/final_result/three_node_result.csv`

집계 방식:
- 각 사용자 구간(`users`)별 5회 반복 실험 평균값
- `cycle 성공률 = cycle_ok_num / cycle_ok_den * 100`
- `stage_pass 비율 = pass(yes) 비중`

| 항목 | Single Node (5회 평균) | 3-Node (5회 평균) |
|---|---:|---:|
| `stage_pass=yes` 비율 100% 최대 사용자 수 | 1250 | 750 |
| `stage_pass=yes` 비율 80% 이상 최대 사용자 수 | 1750 | 1500 |
| 2000 users cycle 성공률 | 84.19% | 97.14% |
| 2250 users cycle 성공률 | 66.67% | 96.72% |
| 2500 users cycle 성공률 | 49.00% | 94.68% |
| 3000 users cycle 성공률 | 60.64% | 95.81% |
| 3000 users create 성공률 | 74.69% | 96.18% |
| 3000 users list 성공률 | 78.24% | 98.80% |

관찰 포인트:

- 고부하 구간(2000+ users)에서 `3-Node`의 cycle/create/list 성공률은 `Single Node`보다 일관되게 높았습니다.
- 반면 `stage_pass` 기준(성공률 + p95 임계값 동시 충족)은 실험 간 변동이 커서, 단일 지표보다 반복 실험 비율로 해석하는 것이 안전합니다.
- 특히 `3-Node`는 요청을 더 많이 처리하면서 지연시간 분포가 넓어지는 경향이 있어, 성공률과 p95를 함께 보는 해석이 필요합니다.

</details>

<a id="main-sec-5-1"></a>
<details>
<summary><strong>9-5-1) 성공률 그래프</strong></summary>

<p>
  <img src="./result/final_result/create_success.png" alt="create_success" width="32%" />
  <img src="./result/final_result/list_success.png" alt="list_success" width="32%" />
  <img src="./result/final_result/cycle_success.png" alt="cycle_success" width="32%" />
</p>

</details>

<a id="main-sec-5-2"></a>
<details>
<summary><strong>9-5-2) create_post 지연시간 그래프</strong></summary>

<p>
  <img src="./result/final_result/create_post_mean.png" alt="create_post_mean" width="32%" />
  <img src="./result/final_result/create_post_p95.png" alt="create_post_p95" width="32%" />
  <img src="./result/final_result/create_post_p99.png" alt="create_post_p99" width="32%" />
</p>

</details>

<a id="main-sec-5-3"></a>
<details>
<summary><strong>9-5-3) list_posts 지연시간 그래프</strong></summary>

<p>
  <img src="./result/final_result/list_posts_mean.png" alt="list_posts_mean" width="32%" />
  <img src="./result/final_result/list_posts_p95.png" alt="list_posts_p95" width="32%" />
  <img src="./result/final_result/list_posts_p99.png" alt="list_posts_p99" width="32%" />
</p>

</details>

<a id="main-sec-6"></a>
<details>
<summary><strong>9-6) 결론</strong></summary>

`result/final_result` 기준(2026-02-26 ~ 2026-02-27, 각 구성 5회 반복) 결론은 다음과 같습니다.

- `2000~3000 users` 구간에서 `3-Node`는 `Single Node` 대비 cycle/create/list 성공률을 더 높게 유지했습니다.
- 단, `stage_pass`(성공률 + p95 임계값 동시 만족) 비율은 실험 변동성 영향이 커서, 단일 run 결과로 최대 수용량을 단정하기 어렵습니다.
- `3-Node`는 고부하에서 처리량을 더 유지하는 대신 p95/p99 지연시간이 커지는 구간이 있어, 운영 기준은 `성공률 + tail latency`를 함께 관리해야 합니다.
- 따라서 본 실험은 수평 확장이 실패율 방어에는 유효하지만, tail latency 최적화 없이는 고부하 통과율(`pass`)이 흔들릴 수 있음을 보여줍니다.

</details>

</dd>
</dl>

</details>
