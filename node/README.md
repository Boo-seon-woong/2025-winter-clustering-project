# final_node

`final_node`는 `test_node`를 직접 수정하지 않고, 실험 결과 기반 개선을 반영한 재실험용 버전입니다.

## 목표

- 애플리케이션 노드 수 증가 시 병목이 ingress/세션 계층에서 먼저 막히지 않도록 개선
- 고부하에서 timeout 누적 대신 load shedding/backpressure로 tail latency 폭발 완화
- 상태 저장 세션 의존 제거(무상태 인증)로 sticky 라우팅 의존성 축소

## 구성

- `kvs` (C++/RocksDB)
  - `/post/create` 응답 확장 (id + account_id/title/content/created_at)
  - `/post/titles` 원격 fan-out을 병렬화하고 시간 예산/peer limit 적용
  - account/post 복제 및 원격 read fan-out 병렬화 + 노드 alive cache
- `server/backend` (Node.js)
  - 무상태 서명 토큰 인증(`AUTH_TOKEN_SECRET`)
  - admission control (`SERVER_MAX_INFLIGHT`, `SERVER_MAX_QUEUE`)
  - feed cache + in-flight dedupe (`LIST_POSTS_CACHE_TTL_MS`)
  - KVS keep-alive/retry/circuit breaker 클라이언트
  - peer broadcast를 요청 경로에서 비동기화
- `ingress` (Node.js)
  - least-inflight 라우팅
  - upstream circuit breaker
  - ingress backpressure/queue timeout
  - `/healthz` 제공

## 준비

1. `final_node/.env`와 `final_node/ingress/.env`를 노드별 값으로 수정
1. 각 노드에서 `NODE_ID`, `SERVER_HOST`, `KVS_HOST`, `DB_PATH`를 해당 서버에 맞게 설정
1. `AUTH_TOKEN_SECRET`를 충분히 긴 랜덤 값으로 통일

## 빌드/실행

### 1) kvsd

```bash
cd /root/root/final_node/kvs
cmake -S . -B build
cmake --build build -j"$(nproc)"
ENV_PATH=/root/root/final_node/.env ./build/kvsd
```

### 2) backend

```bash
cd /root/root/final_node/server/backend
npm install
ENV_PATH=/root/root/final_node/.env node server.js
```

### 3) ingress

```bash
cd /root/root/final_node/ingress
npm install
ENV_PATH=/root/root/final_node/ingress/.env node server.js
```

## 헬스체크

- backend: `GET http://<backend-host>:3000/healthz`
- ingress: `GET http://<ingress-host>:8080/healthz`

## 재실험 권장

기존과 동일한 k6 시나리오로 `BASE_URL=http://<ingress>:8080`를 사용해 비교합니다.

관찰 포인트:

- 400/500 VU 구간 failure rate 변화
- `http_req_duration p95`, `max` tail 억제 여부
- 노드 수 증가(1 -> 3) 시 RPS ceiling 이동 여부
