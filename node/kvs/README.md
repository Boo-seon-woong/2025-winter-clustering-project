# rdb/kvs

간단한 RocksDB 분산 KVS 엔진.

- DB 경로 기본: `rdb/kvs/db`
- Column Family: `account`, `post`
- 모든 노드는 동등
- account 생성: 전체 노드 full replicate
- post 생성: alive 노드만 대상으로 sharding + `R=2` partial replicate

## Build
# ( 현재 위치: <repo>/rdb)
```bash
cmake -S kvs -B kvs/build
cmake --build kvs/build -j
```
cmake -S . -B build
cmake --build build -j"$(nproc)"

## Run

```bash
cp rdb/kvs/.env.example rdb/kvs/.env
ENV_PATH=$PWD/rdb/kvs/.env ./rdb/kvs/build/kvsd
```

## LDB Scripts

```bash
# ldb 준비(복사/빌드)
rdb/kvs/scripts/build_ldb.sh

# DB 조회 예시
ENV_PATH=$PWD/rdb/.env rdb/kvs/scripts/ldb.sh list_column_families
ENV_PATH=$PWD/rdb/.env rdb/kvs/scripts/ldb.sh scan --column_family=post
```

## Public API (port 4000)

`application/x-www-form-urlencoded` POST

- `/account/create`
  - req: `id`, `name`, `password_hash(optional)`
- `/account/get`
  - req: `id`
- `/post/create`
  - req: `account_id`, `title`, `content`, `id(optional)`
- `/post/get`
  - req: `id`
- `/post/titles`
  - req: `limit(optional)`

## Internal API (node-to-node)

- `/internal/account/put`
- `/internal/account/get`
- `/internal/post/put`
- `/internal/post/get`
- `/internal/post/titles`
- `/internal/ping`
