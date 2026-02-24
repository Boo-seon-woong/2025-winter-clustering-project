# 실험 결과 정리 (`result/`)

이 디렉터리는 `single node` vs `3-node cluster` 비교 실험의 원본 기록(`full_experiment_records.csv`)과 시각화 결과(`*.png`)를 담고 있습니다.

## 목차

- [1) 실험 인프라](#sec-1)
- [2) 실험 조건](#sec-2)
- [3) 판정 기준](#sec-3)
- [4) 핵심 결과 (CSV 집계)](#sec-4)
- [5-1) 성공률 그래프](#sec-5-1)
- [5-2) create_post 지연시간 그래프](#sec-5-2)
- [5-3) list_posts 지연시간 그래프](#sec-5-3)
- [6) 그래프 재생성](#sec-6)

<a id="sec-1"></a>
<details>
<summary><strong>1) 실험 인프라</strong></summary>

- Provider: Kamatera (Tokyo)
- OS: Ubuntu 24.04 64bit
- Availability Type
- vCPU: 2
- RAM: 2GB
- SSD: 20GB

토폴로지:

- `Single Node`: `(1node) + (ingress + max_users_1hz.js)` = 총 3개 노드
- `3-Node`: `(3node) + (ingress + max_users_1hz.js)` = 총 4개 노드

</details>

<a id="sec-2"></a>
<details>
<summary><strong>2) 실험 조건</strong></summary>

실험 중 변경한 값은 `USERS`, `BASE_URL`만이며, 주소 노출 방지를 위해 아래 예시는 마스킹했습니다.

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

<a id="sec-3"></a>
<details>
<summary><strong>3) 판정 기준</strong></summary>

각 사용자 구간(stage)은 아래 기준을 모두 만족하면 `pass=yes`로 판정:

- `cycle_ok_rate >= 98%`
- `login_ok_rate >= 98%`
- `create_post_p95 <= 1500ms`
- `list_posts_p95 <= 1500ms`

</details>

<a id="sec-4"></a>
<details>
<summary><strong>4) 핵심 결과 (CSV 집계)</strong></summary>

데이터 소스: `full_experiment_records.csv`

| 항목 | Single Node | 3-Node |
|---|---:|---:|
| 기준 충족 최대 사용자 수 | 1500 | 2000 |
| 1750 users cycle 성공률 | 81.36% | 99.99% |
| 2000 users cycle 성공률 | 59.71% | 100.00% |
| 2000 users create 성공률 | 79.73% | 100.00% |
| 2000 users list 성공률 | 73.04% | 100.00% |
| 2500 users cycle 성공률 | 52.09% | 96.21% |
| 3000 users cycle 성공률 | 62.61% | 95.72% |

요약:

- `Single Node`는 1750 users부터 성공률이 크게 떨어지며 1500 users까지만 기준을 통과했습니다.
- `3-Node`는 2000 users까지 기준을 통과했고, 고부하 구간에서도 성공률 방어가 상대적으로 안정적입니다.
- `3-Node`도 2500 users부터는 일부 지표(특히 cycle/p95 tail) 악화로 `pass=no`가 발생합니다.

</details>

<a id="sec-5-1"></a>
<details>
<summary><strong>5-1) 성공률 그래프</strong></summary>

<p>
  <img src="./create_success_rate.png" alt="create_success_rate" width="32%" />
  <img src="./list_success_rate.png" alt="list_success_rate" width="32%" />
  <img src="./cycle_success_rate.png" alt="cycle_success_rate" width="32%" />
</p>

</details>

<a id="sec-5-2"></a>
<details>
<summary><strong>5-2) create_post 지연시간 그래프</strong></summary>

<p>
  <img src="./create_post_min.png" alt="create_post_min" width="32%" />
  <img src="./create_post_mean.png" alt="create_post_mean" width="32%" />
  <img src="./create_post_max.png" alt="create_post_max" width="32%" />
</p>
<p>
  <img src="./create_post_p95.png" alt="create_post_p95" width="32%" />
  <img src="./create_post_p99.png" alt="create_post_p99" width="32%" />
  <img src="./create_post_p99.9.png" alt="create_post_p99.9" width="32%" />
</p>

</details>

<a id="sec-5-3"></a>
<details>
<summary><strong>5-3) list_posts 지연시간 그래프</strong></summary>

<p>
  <img src="./list_posts_min.png" alt="list_posts_min" width="32%" />
  <img src="./list_posts_mean.png" alt="list_posts_mean" width="32%" />
  <img src="./list_posts_max.png" alt="list_posts_max" width="32%" />
</p>
<p>
  <img src="./list_posts_p95.png" alt="list_posts_p95" width="32%" />
  <img src="./list_posts_p99.png" alt="list_posts_p99" width="32%" />
  <img src="./list_posts_p99.9.png" alt="list_posts_p99.9" width="32%" />
</p>

</details>

<a id="sec-6"></a>
<details>
<summary><strong>6) 그래프 재생성</strong></summary>

```bash
cd /root/2025/clustering_project/result
python graph.py
```

`graph.py`는 `full_experiment_records.csv`를 파싱해 위 PNG 파일들을 다시 생성합니다.

</details>
