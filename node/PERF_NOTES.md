# Performance Notes

## 2026-02-14: `/api/posts` max latency ~15s incident

### Symptom

- k6 결과에서 `p95`는 낮았지만 `max`가 약 `15.2s`로 튀는 tail latency 발생
- backend 로그에서 아래 패턴이 반복됨
  - `[kvs:ok] ... path="/post/titles" ... ms=152xx`
  - `[kvs:ok] ... path="/account/get" ... ms=152xx`
  - `[posts:list] ... ms=152xx`

### Root Cause

1. `kvsd`의 `/post/titles` 경로가 전체 데이터를 스캔하는 fallback 경로로 진입할 때, 전역 mutex 구간에서 오래 머물 수 있었음.
2. backend `listPosts()`가 작성자 이름을 채우기 위해 `/account/get`를 많이 호출하면서 tail latency를 확대함.
3. 환경 설정이 어긋나면(예: `BASE_URL=127.0.0.1`, `SERVER_HOST=172.x.x.x`) connection refused가 섞여 분석을 방해할 수 있음.

### What was improved

#### KVS (`test_node/kvs/kvs.cc`, `test_node/kvs/kvs.h`)

- 게시글 타이틀 인덱스 키 추가: `t:<reverse_created_at>:<post_id>`
- `PutPost()`에서 본문(`p:`)과 인덱스(`t:`)를 `WriteBatch`로 원자적 기록
- `LocalTitles(limit)` 구현
  - 인덱스가 있으면 limit만큼 즉시 반환
  - 인덱스가 없을 때만 fallback 스캔 + 인덱스 backfill
- `ListTitles()`가 항상 `local_limit=lim`으로 조회하도록 조정
- `/internal/post/titles`도 `limit`를 전달/처리하도록 변경
- `/post/titles`, `/internal/post/titles` 응답에 `account_idN` 포함

#### Backend (`test_node/server/backend/module/kvs.js`, `test_node/server/backend/module/posts.js`)

- `listTitles()` 파서가 `account_id`를 읽도록 수정
- `listPosts()`가 가능한 경우 `titles` 응답만으로 결과를 구성하고 `getPost()` fan-out 제거
- 작성자 이름 조회 최적화
  - process-wide 캐시(`AUTHOR_NAME_CACHE_TTL_MS`, `AUTHOR_NAME_CACHE_MAX`)
  - in-flight dedupe로 동일 `account_id` 동시 중복 조회 제거

#### Config (`test_node/.env`)

- `SINGLE_NODE=true` 명시 (single-node 의도를 설정 파일에 고정)

### Result (after fix)

- 단독 검증: `curl -X POST /post/titles -d 'limit=100'` 응답이 `~8-13ms`
- k6(10 VU) 결과
  - `http_req_duration max`: `15.2s` -> `17.9ms`
  - `http_req_duration p95`: `~6ms` -> `~2ms`
  - `list_posts p95`: `~8.7ms` -> `~2.2ms`

### Rebuild/Restart checklist

1. `kvsd` rebuild
   - `cd /root/2025/test_node/kvs`
   - `cmake -S . -B build`
   - `cmake --build build -j"$(nproc)"`
2. `kvsd` restart
   - `ENV_PATH=/root/2025/test_node/.env ./build/kvsd`
3. backend restart
   - `cd /root/2025/test_node/server/backend`
   - `ENV_PATH=/root/2025/test_node/.env node server.js`
4. k6 실행 시 `BASE_URL`이 서버 바인딩 주소와 일치하는지 확인
   - 예: `BASE_URL=http://172.31.52.137:3000`
