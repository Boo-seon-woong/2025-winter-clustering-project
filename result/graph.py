import re
import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator

# =========================
# style
# =========================
plt.rcParams.update({
    "font.family": "serif",
    "font.size": 9,
    "axes.labelsize": 10,
    "legend.fontsize": 9,
    "xtick.labelsize": 8,
    "ytick.labelsize": 8,
    "axes.linewidth": 1.0,
})

FIG_W = 3.5
FIG_H = 2.6

CSV_PATH = "full_experiment_records.csv"

LAT_METRICS = ["mean", "min", "max", "p95", "p99", "p99.9"]

# =========================
# 유틸
# =========================
def parse_users_from_filename(fname):
    m = re.search(r"(\d+)", fname)
    return int(m.group(1)) if m else -1

def parse_stage_summary(text):
    out = {}

    m = re.search(r"cycle_ok=(\d+)/(\d+) \(([\d.]+)%\)", text)
    if m:
        out["cycle_success_rate"] = float(m.group(3))

    return out

def parse_metric_row(line):
    parts = line.strip().split()
    if len(parts) < 14:
        return None

    try:
        name = parts[0]
        ok_rate = float(parts[5].rstrip("%"))
        mean = float(parts[7])
        min_v = float(parts[8])
        max_v = float(parts[9])
        p95 = float(parts[10])
        p99 = float(parts[11])
        p999 = float(parts[12])
    except:
        return None

    return {
        "name": name,
        "mean": mean,
        "min": min_v,
        "max": max_v,
        "p95": p95,
        "p99": p99,
        "p99.9": p999,
        "success_rate": ok_rate
    }

# =========================
# CSV 파싱
# =========================
df = pd.read_csv(CSV_PATH)

records = {}

for fname, g in df.groupby("filename"):
    text = "\n".join(g["content"].fillna("").astype(str).tolist())
    users = parse_users_from_filename(fname)

    stage = parse_stage_summary(text)

    per_op = {}
    for op in ["create_post", "list_posts"]:
        lines = [ln for ln in text.splitlines() if ln.strip().startswith(op)]
        if lines:
            row = parse_metric_row(lines[-1])
            if row:
                per_op[op] = row

    records[fname] = {
        "users": users,
        "cycle_success_rate": stage.get("cycle_success_rate", None),
        "ops": per_op
    }

# =========================
# single / cluster 분리
# =========================
single = []
cluster = []

for fname, r in records.items():
    if "single" in fname:
        single.append(r)
    elif "3node" in fname:
        cluster.append(r)

single.sort(key=lambda x: x["users"])
cluster.sort(key=lambda x: x["users"])

# =========================
# 공통 플로팅 함수
# =========================
def custom_plot(x1, y1, x2, y2, ylabel, filename, is_success=False):

    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))

    ax.plot(x1, y1,
            linestyle="--",
            marker="o",
            markersize=3.5,
            linewidth=1.0,
            color="0.15",
            label="Single")

    ax.plot(x2, y2,
            linestyle="-",
            marker="s",
            markersize=3.5,
            linewidth=1.0,
            color="0.6",
            label="3-Node")

    ax.set_xlabel("Users")
    ax.set_ylabel(ylabel)

    # X ticks
    ax.xaxis.set_major_locator(MultipleLocator(500))
    ax.xaxis.set_minor_locator(MultipleLocator(250))

    # Grid
    ax.grid(which='major', linestyle=":", linewidth=0.6)
    ax.grid(which='minor', linestyle=":", linewidth=0.4)

    # Success rate는 padding 추가
    if is_success:
        ax.set_ylim(0, 105)

    ax.legend(frameon=False)
    plt.tight_layout(pad=0.8)
    plt.savefig(filename, dpi=300, bbox_inches="tight")
    plt.close()

# =========================
# 1️⃣ Latency 그래프 생성
# =========================
for metric in LAT_METRICS:

    for op in ["create_post", "list_posts"]:

        s_x, s_y = [], []
        c_x, c_y = [], []

        for r in single:
            if op in r["ops"]:
                s_x.append(r["users"])
                s_y.append(r["ops"][op][metric])

        for r in cluster:
            if op in r["ops"]:
                c_x.append(r["users"])
                c_y.append(r["ops"][op][metric])

        custom_plot(
            s_x, s_y,
            c_x, c_y,
            f"{op} {metric.upper()} (ms)",
            f"{op}_{metric}.png",
            is_success=False
        )

# =========================
# 2️⃣ Success Rate 그래프
# =========================

# create success
s_x, s_y, c_x, c_y = [], [], [], []
for r in single:
    if "create_post" in r["ops"]:
        s_x.append(r["users"])
        s_y.append(r["ops"]["create_post"]["success_rate"])
for r in cluster:
    if "create_post" in r["ops"]:
        c_x.append(r["users"])
        c_y.append(r["ops"]["create_post"]["success_rate"])

custom_plot(s_x, s_y, c_x, c_y,
          "Create Success Rate (%)",
          "create_success_rate.png",
          is_success=True)

# list success
s_x, s_y, c_x, c_y = [], [], [], []
for r in single:
    if "list_posts" in r["ops"]:
        s_x.append(r["users"])
        s_y.append(r["ops"]["list_posts"]["success_rate"])
for r in cluster:
    if "list_posts" in r["ops"]:
        c_x.append(r["users"])
        c_y.append(r["ops"]["list_posts"]["success_rate"])

custom_plot(s_x, s_y, c_x, c_y,
          "List Success Rate (%)",
          "list_success_rate.png",
          is_success=True)

# cycle success
s_x, s_y, c_x, c_y = [], [], [], []
for r in single:
    if r["cycle_success_rate"] is not None:
        s_x.append(r["users"])
        s_y.append(r["cycle_success_rate"])
for r in cluster:
    if r["cycle_success_rate"] is not None:
        c_x.append(r["users"])
        c_y.append(r["cycle_success_rate"])

custom_plot(s_x, s_y, c_x, c_y,
          "Cycle Success Rate (%)",
          "cycle_success_rate.png",
          is_success=True)

print("All graphs generated.")