#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-boosw1}"
REMOTE_BASE="${REMOTE_BASE:-/root/root/final_node}"
LOCAL_BASE="${LOCAL_BASE:-/root/home}"
STRESS_SCRIPT="${STRESS_SCRIPT:-$LOCAL_BASE/stress_folder/max_users_1hz.js}"
STRESS_DIR="${STRESS_DIR:-$LOCAL_BASE/stress_folder}"
RESULT_DIR="${RESULT_DIR:-$LOCAL_BASE/final_result}"

USER_START="${USER_START:-250}"
USER_STEP="${USER_STEP:-250}"
USER_END="${USER_END:-3000}"
RUN_COUNT="${RUN_COUNT:-5}"

TS="$(date +%Y%m%d_%H%M%S)"
SUMMARY_FILE="$RESULT_DIR/single_node_sweep_${TS}.txt"

mkdir -p "$RESULT_DIR"

remote_stop_kvsd() { ssh "$REMOTE_HOST" "fuser -k 4000/tcp || true"; }
remote_stop_backend() { ssh "$REMOTE_HOST" "fuser -k 3000/tcp || true"; }
remote_drop_post_cf() {
  ssh "$REMOTE_HOST" "
out=\$(ldb --db=$REMOTE_BASE/kvs/db drop_column_family post 2>&1) || rc=\$?
rc=\${rc:-0}
if [ \$rc -eq 0 ]; then
  echo \"\$out\"
  exit 0
fi
if echo \"\$out\" | grep -qi \"post doesn't exist in db\"; then
  echo \"SKIP: post CF already missing (already reset)\"
  exit 0
fi
echo \"\$out\" >&2
exit \$rc
"
}
remote_start_kvsd() { ssh -n "$REMOTE_HOST" "cd $REMOTE_BASE && setsid -f env ENV_PATH=$REMOTE_BASE/.env ./kvs/build/kvsd >$REMOTE_BASE/kvsd.log 2>&1"; }
remote_start_backend() { ssh -n "$REMOTE_HOST" "cd $REMOTE_BASE/server/backend && setsid -f env ENV_PATH=$REMOTE_BASE/.env node server.js >$REMOTE_BASE/server/backend/server.log 2>&1"; }
remote_check_listen() { ssh "$REMOTE_HOST" "ss -lntp | grep ':4000' || true; ss -lntp | grep ':3000' || true"; }

echo "[init] start fresh backend/kvsd on $REMOTE_HOST" | tee "$SUMMARY_FILE"
remote_stop_kvsd
remote_stop_backend
remote_drop_post_cf | tee -a "$SUMMARY_FILE"
remote_start_kvsd
remote_start_backend
sleep 2
remote_check_listen | tee -a "$SUMMARY_FILE"

for exp_no in $(seq 1 "$RUN_COUNT"); do
  echo "" | tee -a "$SUMMARY_FILE"
  echo "===== experiment $exp_no/$RUN_COUNT =====" | tee -a "$SUMMARY_FILE"

  for users in $(seq "$USER_START" "$USER_STEP" "$USER_END"); do
    RUN_FILE="$RESULT_DIR/single_node_exp${exp_no}_${users}_${TS}.txt"

    echo "" | tee -a "$SUMMARY_FILE"
    echo "[exp $exp_no/$RUN_COUNT] USERS=$users" | tee -a "$SUMMARY_FILE"
    echo "[1/4] stop kvsd" | tee -a "$SUMMARY_FILE"
    remote_stop_kvsd
    sleep 1

    echo "[2/4] drop post CF" | tee -a "$SUMMARY_FILE"
    remote_drop_post_cf | tee -a "$SUMMARY_FILE"

    echo "[3/4] start kvsd" | tee -a "$SUMMARY_FILE"
    remote_start_kvsd
    sleep 2
    remote_check_listen | tee -a "$SUMMARY_FILE"

    echo "[4/4] run stress USERS=$users" | tee -a "$SUMMARY_FILE"
    sleep 1
    {
      echo "[experiment] $exp_no/$RUN_COUNT"
      echo "[users] $users"
      echo "[timestamp] $(date '+%F %T %Z')"
      echo ""
      (
        cd "$STRESS_DIR"
        USERS="$users" node "$STRESS_SCRIPT"
      )
    } | tee "$RUN_FILE"
    sleep 1
  done
done

echo "" | tee -a "$SUMMARY_FILE"
echo "[final] cleanup: drop post CF, stop kvsd/server.js" | tee -a "$SUMMARY_FILE"
remote_stop_kvsd
remote_drop_post_cf | tee -a "$SUMMARY_FILE"
remote_stop_kvsd
remote_stop_backend
remote_check_listen | tee -a "$SUMMARY_FILE"

echo "[done] summary: $SUMMARY_FILE"
