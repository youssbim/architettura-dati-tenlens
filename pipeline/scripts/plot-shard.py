#!/usr/bin/env python3
"""Grafici del benchmark sharding (Condizione 2 del prof) per il report.
Legge ../benchmarks/shard-bench.jsonl (una riga per N shard) e produce PNG."""
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

SRC = "../benchmarks/shard-bench.jsonl"
OUT = "../benchmarks"
os.makedirs(OUT, exist_ok=True)

rows = [json.loads(l) for l in open(SRC) if l.strip()]
rows.sort(key=lambda r: r["shards"])
shards = [r["shards"] for r in rows]

ACCENT = "#4b2fd6"
ACCENT2 = "#007a5e"
plt.rcParams.update({"font.size": 13, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.grid": True, "grid.alpha": 0.25, "figure.dpi": 130})

# ── 1. LETTURA: latenza aggregazione (scatter-gather) vs shard ──
fig, ax = plt.subplots(figsize=(6.4, 4.2))
agg = [r["aggP50"] for r in rows]
ax.plot(shards, agg, "-o", color=ACCENT, lw=2.6, ms=9)
for x, y in zip(shards, agg):
    ax.annotate(f"{y:.0f} ms", (x, y), textcoords="offset points", xytext=(0, 10),
                ha="center", fontweight="bold", color=ACCENT)
ax.set_xlabel("numero di shard (nodi)"); ax.set_ylabel("latenza p50 (ms)")
ax.set_title("Lettura — aggregazione scatter-gather\npiù nodi → più parallelismo → più veloce", fontweight="bold")
ax.set_xticks(shards); ax.set_ylim(0, max(agg) * 1.22)
fig.tight_layout(); fig.savefig(f"{OUT}/shard-read-aggregation.png"); plt.close(fig)

# ── 2. LETTURA: puntuale per CIG (1 shard) → costante ──
fig, ax = plt.subplots(figsize=(6.4, 4.2))
pt = [r["pointP50"] for r in rows]
ax.plot(shards, pt, "-o", color=ACCENT2, lw=2.6, ms=9)
for x, y in zip(shards, pt):
    ax.annotate(f"{y:.2f} ms", (x, y), textcoords="offset points", xytext=(0, 10),
                ha="center", fontweight="bold", color=ACCENT2)
ax.set_xlabel("numero di shard (nodi)"); ax.set_ylabel("latenza p50 (ms)")
ax.set_title("Lettura — puntuale per CIG\ncolpisce 1 solo shard → costante", fontweight="bold")
ax.set_xticks(shards); ax.set_ylim(0, max(pt) * 1.3)
fig.tight_layout(); fig.savefig(f"{OUT}/shard-read-point.png"); plt.close(fig)

# ── 3. SCRITTURA: throughput (doc/s) vs shard ──
fig, ax = plt.subplots(figsize=(6.4, 4.2))
w = [r["writeDocsPerSec"] / 1000 for r in rows]
bars = ax.bar([str(s) for s in shards], w, color=ACCENT, width=0.55)
for b, y in zip(bars, w):
    ax.annotate(f"{y:.1f}k", (b.get_x() + b.get_width() / 2, y), textcoords="offset points",
                xytext=(0, 6), ha="center", fontweight="bold", color=ACCENT)
ax.set_xlabel("numero di shard (nodi)"); ax.set_ylabel("scrittura (mila doc/s)")
ax.set_title("Scrittura — throughput di ingestione distribuita\npiù nodi → più scritture in parallelo", fontweight="bold")
ax.set_ylim(0, max(w) * 1.18)
fig.tight_layout(); fig.savefig(f"{OUT}/shard-write-throughput.png"); plt.close(fig)

print("✓ grafici salvati in", OUT)
for r in rows:
    print(f"  {r['shards']} shard | scrittura {r['writeDocsPerSec']/1000:.1f}k doc/s | "
          f"agg {r['aggP50']:.0f} ms | puntuale {r['pointP50']:.2f} ms")
