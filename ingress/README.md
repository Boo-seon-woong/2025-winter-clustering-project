# final_node ingress

## 특징

- least-inflight 라우팅
- upstream circuit breaker
- ingress admission control/load shedding
- keep-alive connection pool
- `GET /healthz` 제공

## 실행

```bash
cd /root/root/final_node/ingress
npm install
ENV_PATH=/root/root/final_node/ingress/.env node server.js
```
