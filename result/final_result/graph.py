import pandas as pd
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator

# =========================
# Style
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

# =========================
# Load CSV
# =========================
single = pd.read_csv("single_node_result.csv")
cluster = pd.read_csv("three_node_result.csv")

# =========================
# Preprocessing
# =========================

def preprocess(df):
    # % 제거
    df["create_post_ok_rate"] = df["create_post_ok_rate"].str.rstrip("%").astype(float)
    df["list_posts_ok_rate"] = df["list_posts_ok_rate"].str.rstrip("%").astype(float)
    df["login_ok_rate"] = df["login_ok_rate"].str.rstrip("%").astype(float)

    # cycle success rate 계산
    df["cycle_success_rate"] = (
        df["cycle_ok_num"] / df["cycle_ok_den"] * 100
    )

    return df

single = preprocess(single)
cluster = preprocess(cluster)

# =========================
# 평균 + 표준편차 계산
# =========================

def aggregate(df, metric):
    grouped = df.groupby("users")[metric].agg(["mean", "std"]).reset_index()
    return grouped

# =========================
# Plot Function (with errorbar)
# =========================

def plot_metric(metric, ylabel, filename, is_success=False):

    s = aggregate(single, metric)
    c = aggregate(cluster, metric)

    fig, ax = plt.subplots(figsize=(FIG_W, FIG_H))

    ax.errorbar(
        s["users"], s["mean"], yerr=s["std"],
        linestyle="--", marker="o",
        markersize=3.5, linewidth=1.0,
        color="0.15", label="Single",
        capsize=2
    )

    ax.errorbar(
        c["users"], c["mean"], yerr=c["std"],
        linestyle="-", marker="s",
        markersize=3.5, linewidth=1.0,
        color="0.6", label="3-Node",
        capsize=2
    )

    ax.set_xlabel("Users")
    ax.set_ylabel(ylabel)

    ax.xaxis.set_major_locator(MultipleLocator(500))
    ax.xaxis.set_minor_locator(MultipleLocator(250))

    ax.grid(which='major', linestyle=":", linewidth=0.6)
    ax.grid(which='minor', linestyle=":", linewidth=0.4)

    if is_success:
        ax.set_ylim(0, 105)

    ax.legend(frameon=False)
    plt.tight_layout(pad=0.8)
    plt.savefig(filename, dpi=300, bbox_inches="tight")
    plt.close()

# =========================
# Latency Graphs
# =========================

latency_metrics = {
    "create_post_mean": "Create Mean (ms)",
    "create_post_p95": "Create P95 (ms)",
    "create_post_p99": "Create P99 (ms)",
    "list_posts_mean": "List Mean (ms)",
    "list_posts_p95": "List P95 (ms)",
    "list_posts_p99": "List P99 (ms)",
}

for metric, label in latency_metrics.items():
    plot_metric(metric, label, f"{metric}.png")

# =========================
# Success Rate Graphs
# =========================

plot_metric("create_post_ok_rate",
            "Create Success Rate (%)",
            "create_success.png",
            is_success=True)

plot_metric("list_posts_ok_rate",
            "List Success Rate (%)",
            "list_success.png",
            is_success=True)

plot_metric("cycle_success_rate",
            "Cycle Success Rate (%)",
            "cycle_success.png",
            is_success=True)

print("All graphs generated with error bars.")