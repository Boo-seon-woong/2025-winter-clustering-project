<div align="right">

**Language**: [Korean](./readme.md) | [English](./readme_en.md)

</div>

<div align="center">

# Clustering Project
### RocksDB-based Distributed KVS + Node.js Backend + Ingress Test Environment

This is a distributed test project for validating stability, latency, and scalability under high-load conditions.

</div>

<a id="toc-overview"></a>
<details>
<summary><strong>1. Overview at a Glance</strong></summary>

| Area | Path | Role |
|---|---|---|
| Ingress | `ingress/` | External traffic entry point, least-inflight routing, circuit breaker, admission control |
| Node (individual node) | `node/` | `kvs` (C++/RocksDB) + `server/backend` (Node.js API) |
| Test tools | `stress_test/`, `create_account.js` | Load generation, bulk user account creation, test iteration automation |

</details>

<a id="toc-architecture"></a>
<details>
<summary><strong>2. Architecture</strong></summary>

<p align="center">
  <img src="./img/Diagram.png" alt="Cluster architecture diagram" width="1000" />
</p>

</details>

<a id="toc-key-features"></a>
<details>
<summary><strong>3. Key Features</strong></summary>

- Ingress: least-inflight routing, queue-timeout-based load shedding, upstream circuit breaker
- Backend: stateless token authentication, admission control, `/api/posts` caching and duplicate-request suppression
- KVS: RocksDB-based distributed storage, inter-node replication/fan-out read
- Tests: lightweight Node-based stress tests + account seeding script

</details>

<a id="toc-repo-layout"></a>
<details>
<summary><strong>4. Repository Layout</strong></summary>

```text
.
├── ingress/                 # Ingress server (Node.js)
├── node/                    # Individual node
│   ├── kvs/                 # KVS server (C++ / RocksDB)
│   └── server/backend/      # API server (Node.js)
├── stress_test/             # Load test scripts
├── create_account.js        # Bulk account creation/validation script
├── readme.md                # Korean documentation
└── readme_en.md             # English documentation
```

</details>

<a id="toc-quick-start"></a>
<details>
<summary><strong>5. Quick Start</strong></summary>

<a id="toc-quick-start-1"></a>
### 1) Prerequisites

- Node.js 18+
- npm
- CMake 3.10+
- C++17 compiler
- RocksDB and linked libraries (`snappy`, `zstd`, `zlib`, `bz2`, optional `lz4`)

<a id="toc-quick-start-2"></a>
### 2) Prepare environment files

```bash
cp node/.env.example node/.env
cp ingress/.env.example ingress/.env
cp stress_test/.env.example stress_test/.env
```

<a id="toc-quick-start-3"></a>
### 3) Install Node dependencies

```bash
cd ingress && npm install
cd ../node/server/backend && npm install
```

<a id="toc-quick-start-4"></a>
### 4) Build KVS

```bash
cd /root/2025/clustering_project/node/kvs
cmake -S . -B build
cmake --build build -j"$(nproc)"
```

</details>

<a id="toc-run-order"></a>
<details>
<summary><strong>6. Run Order</strong></summary>

It is recommended to run each process in a separate terminal.

<a id="toc-run-order-1"></a>
### 1) Run KVS

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env ./node/kvs/build/kvsd
```

<a id="toc-run-order-2"></a>
### 2) Run Backend

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env node node/server/backend/server.js
```

<a id="toc-run-order-3"></a>
### 3) Run Ingress

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/ingress/.env node ingress/server.js
```

<a id="toc-run-order-4"></a>
### 4) Health checks

```bash
curl http://<ingress-host>:8080/healthz
curl http://<backend-host>:3000/healthz
```

</details>

<a id="toc-experiment-setup"></a>
<details>
<summary><strong>7. Experiment Setup</strong></summary>

<a id="toc-experiment-setup-a"></a>
### A. Seed accounts (`create_account.js`)

`create_account.js` executes `POST /api/register -> POST /api/login -> GET /api/me` in sequence to verify account creation and authentication, and records results in `create_accounts_trace.json`.

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env \
BASE_URL=http://127.0.0.1:8080 \
USER_COUNT=1000 \
CONCURRENCY=32 \
node create_account.js
```

Key options:
- `USER_COUNT`, `START_INDEX`, `CONCURRENCY`
- `EMAIL_PREFIX`, `EMAIL_DOMAIN`, `PASSWORD`
- `REQUEST_TIMEOUT_MS`, `REQUEST_RETRIES`
- `TRACE_PATH`

<a id="toc-experiment-setup-b"></a>
### B. Load tests (`stress_test/`)

```bash
cd /root/2025/clustering_project/stress_test
node http_stress.js
node max_users_1hz.js
```

- `http_stress.js`: sends continuous requests to a fixed target to check RPS/error rate
- `max_users_1hz.js`: finds the maximum concurrent-user range at 1Hz (`POST + GET`) per user

</details>

<a id="toc-env-guide"></a>
<details>
<summary><strong>8. Environment File Guide</strong></summary>

- `node/.env`: individual node (KVS + Backend) settings
- `ingress/.env`: Ingress routing and protection policy settings
- `stress_test/.env`: test intensity, success criteria, timeout settings

</details>

<a id="toc-experiment-result"></a>
<details>
<summary><strong>9. Experiment Process and Results (based on `result/`)</strong></summary>

<dl>
<dd>

<a id="main-sec-1"></a>
<details>
<summary><strong>9-1) Test Infrastructure</strong></summary>

All test nodes were configured with identical specs.

- Provider: Kamatera (Tokyo)
- OS: Ubuntu 24.04 64bit
- Availability Type
- vCPU: 2
- RAM: 2GB
- SSD: 20GB

Topology:

- `Single Node`: `(1node) + (ingress + max_users_1hz.js)` = total 3 nodes
- `3-Node`: `(3node) + (ingress + max_users_1hz.js)` = total 4 nodes

</details>

<a id="main-sec-2"></a>
<details>
<summary><strong>9-2) Test Conditions</strong></summary>

Using `max_users_1hz.js`, the following settings were used, and only `USERS` and `BASE_URL` were changed during tests.
In this document, `BASE_URL` is masked to avoid exposing addresses.

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
<summary><strong>9-3) Pass Criteria</strong></summary>

Each user stage is judged as `pass=yes` when all criteria below are satisfied:

- `cycle_ok_rate >= 98%`
- `login_ok_rate >= 98%`
- `create_post_p95 <= 1500ms`
- `list_posts_p95 <= 1500ms`

</details>

<a id="main-sec-4"></a>
<details>
<summary><strong>9-4) Key Results (CSV Aggregation)</strong></summary>

Data source: `result/full_experiment_records.csv`

| Metric | Single Node | 3-Node |
|---|---:|---:|
| Maximum users meeting criteria | 1500 | 2000 |
| Cycle success rate at 1750 users | 81.36% | 99.99% |
| Cycle success rate at 2000 users | 59.71% | 100.00% |
| Create success rate at 2000 users | 79.73% | 100.00% |
| List success rate at 2000 users | 73.04% | 100.00% |
| Cycle success rate at 2500 users | 52.09% | 96.21% |
| Cycle success rate at 3000 users | 62.61% | 95.72% |

Observations:

- `Single Node` showed a sharp drop in success rate from 1750 users, and the pass criteria stopped at 1500 users.
- `3-Node` met the criteria up to 2000 users, and the success-rate drop remained relatively small even in high-load ranges (2000+).
- However, `3-Node` also began producing `pass=no` after 2500 users as `cycle_ok_rate` or latency thresholds were exceeded.

</details>

<a id="main-sec-5-1"></a>
<details>
<summary><strong>9-5-1) Success Rate Graphs</strong></summary>

<p>
  <img src="./result/create_success_rate.png" alt="create_success_rate" width="32%" />
  <img src="./result/list_success_rate.png" alt="list_success_rate" width="32%" />
  <img src="./result/cycle_success_rate.png" alt="cycle_success_rate" width="32%" />
</p>

</details>

<a id="main-sec-5-2"></a>
<details>
<summary><strong>9-5-2) create_post Latency Graphs</strong></summary>

<p>
  <img src="./result/create_post_min.png" alt="create_post_min" width="32%" />
  <img src="./result/create_post_mean.png" alt="create_post_mean" width="32%" />
  <img src="./result/create_post_max.png" alt="create_post_max" width="32%" />
</p>
<p>
  <img src="./result/create_post_p95.png" alt="create_post_p95" width="32%" />
  <img src="./result/create_post_p99.png" alt="create_post_p99" width="32%" />
  <img src="./result/create_post_p99.9.png" alt="create_post_p99.9" width="32%" />
</p>

</details>

<a id="main-sec-5-3"></a>
<details>
<summary><strong>9-5-3) list_posts Latency Graphs</strong></summary>

<p>
  <img src="./result/list_posts_min.png" alt="list_posts_min" width="32%" />
  <img src="./result/list_posts_mean.png" alt="list_posts_mean" width="32%" />
  <img src="./result/list_posts_max.png" alt="list_posts_max" width="32%" />
</p>
<p>
  <img src="./result/list_posts_p95.png" alt="list_posts_p95" width="32%" />
  <img src="./result/list_posts_p99.png" alt="list_posts_p99" width="32%" />
  <img src="./result/list_posts_p99.9.png" alt="list_posts_p99.9" width="32%" />
</p>

</details>

</dd>
</dl>

</details>
