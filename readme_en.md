<div align="right">

**Language**: [Korean](./readme.md) | [English](./readme_en.md)

</div>

<div align="center">

# Clustering Project
### Multi-node Experiment Stack: Distributed RocksDB KVS + Node.js Backend + Ingress

A multi-node experiment project for validating stability, latency, and scalability under high load.

</div>

## At a Glance

| Area | Path | Role |
|---|---|---|
| Ingress | `ingress/` | External traffic entry point, least-inflight routing, circuit breaker, admission control |
| Node (individual node) | `node/` | `kvs` (C++/RocksDB) + `server/backend` (Node.js API) |
| Experiment tooling | `stress_test/`, `create_account.js` | Load generation, bulk account seeding, repeatable experiment setup |

## Architecture

<p align="center">
  <img src="./image/diagram.png" alt="Cluster architecture diagram" width="1000" />
</p>

## Key Features

- Ingress: least-inflight routing, queue-timeout load shedding, upstream circuit breaker
- Backend: stateless token auth, admission control, `/api/posts` cache and in-flight dedupe
- KVS: RocksDB-based distributed store with node-to-node replication/fan-out reads
- Experiment stack: lightweight Node-based stress tools + account seed script

## Repository Layout

```text
.
├── ingress/                 # Ingress server (Node.js)
├── node/                    # Individual node
│   ├── kvs/                 # KVS server (C++ / RocksDB)
│   └── server/backend/      # API server (Node.js)
├── stress_test/             # Load test scripts
├── create_account.js        # Bulk account create/verify script
├── readme.md                # Korean documentation
└── readme_en.md             # English documentation
```

## Quick Start

### 1) Prerequisites

- Node.js 18+
- npm
- CMake 3.10+
- C++17 compiler
- RocksDB and link libraries (`snappy`, `zstd`, `zlib`, `bz2`, optional `lz4`)

### 2) Prepare environment files

```bash
cp node/.env.example node/.env
cp ingress/.env.example ingress/.env
cp stress_test/.env.example stress_test/.env
```

### 3) Install Node dependencies

```bash
cd ingress && npm install
cd ../node/server/backend && npm install
```

### 4) Build KVS

```bash
cd /root/2025/clustering_project/node/kvs
cmake -S . -B build
cmake --build build -j"$(nproc)"
```

## Run Order

Run each process in a separate terminal.

### 1) Run KVS

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env ./node/kvs/build/kvsd
```

### 2) Run Backend

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env node node/server/backend/server.js
```

### 3) Run Ingress

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/ingress/.env node ingress/server.js
```

### 4) Health checks

```bash
curl http://<ingress-host>:8080/healthz
curl http://<backend-host>:3000/healthz
```

## Experiment Setup

### A. Account seeding (`create_account.js`)

`create_account.js` runs `POST /api/register -> POST /api/login -> GET /api/me` for each account, validates auth readiness, and writes a trace to `create_accounts_trace.json`.

```bash
cd /root/2025/clustering_project
ENV_PATH=/root/2025/clustering_project/node/.env \
BASE_URL=http://127.0.0.1:8080 \
USER_COUNT=1000 \
CONCURRENCY=32 \
node create_account.js
```

Main options:
- `USER_COUNT`, `START_INDEX`, `CONCURRENCY`
- `EMAIL_PREFIX`, `EMAIL_DOMAIN`, `PASSWORD`
- `REQUEST_TIMEOUT_MS`, `REQUEST_RETRIES`
- `TRACE_PATH`

### B. Load testing (`stress_test/`)

```bash
cd /root/2025/clustering_project/stress_test
node http_stress.js
node max_users_1hz.js
```

- `http_stress.js`: continuous fixed-target traffic for RPS/failure-rate checks
- `max_users_1hz.js`: max concurrent-user search at 1Hz per user (`POST + GET`)

## Environment File Guide

- `node/.env`: per-node settings (KVS + Backend)
- `ingress/.env`: ingress routing and protection policy settings
- `stress_test/.env`: experiment intensity, pass criteria, timeout settings

## Git Tracking Policy

Current `.gitignore` excludes only the following:

- Dependency code: `**/node_modules/`
- Secret config: `**/.env` (`.env.example` remains committable)
- Node DB contents: `node/**/db/**` (directory structure is kept)

Everything else is intentionally committed for experiment reproducibility.
