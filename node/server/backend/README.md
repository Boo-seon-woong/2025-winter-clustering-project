# final_node backend

## 주요 변경점

- 무상태 인증 토큰 (`module/auth.js`)
- 과부하 제어 (`SERVER_MAX_INFLIGHT`, `SERVER_MAX_QUEUE`, `SERVER_QUEUE_TIMEOUT_MS`)
- feed 캐시/중복 제거로 `GET /api/posts` fan-out 완화
- KVS keep-alive + retry + circuit breaker
- `POST /api/posts`의 peer broadcast를 비동기 처리

## 실행

```bash
cd /root/root/final_node/server/backend
npm install
ENV_PATH=/root/root/final_node/.env node server.js
```

## 엔드포인트

- `GET /healthz`
- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
- `POST /api/posts`
- `GET /api/posts`
- `GET /api/posts/:id`
