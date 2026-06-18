#!/usr/bin/env python3
"""Grafici asse ① (Condizione 1 del prof): latenza al variare del dataset 25→100%."""
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

SRC = "../benchmarks/query-scale.jsonl"
OUT = "../benchmarks"
os.makedirs(OUT, exist_ok=True)

rows = [json.loads(l) for l in open(SRC) if l.strip()]
rows.sort(key=lambda r: r["pct"])
pct = [r["pct"] for r in rows]

ACCENT = "#4b2fd6"; ACCENT2 = "#007a5e"; ORANGE = "#c2410c"
plt.rcParams.update({"font.size": 13, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.grid": True, "grid.alpha": 0.25, "figure.dpi": 130})

# 1) AGGREGAZIONE full-scan → cresce lineare col dataset (il muro)
fig, ax = plt.subplots(figsize=(6.4, 4.2))
agg = [r["aggP50"] for r in rows]
ax.plot(pct, agg, "-o", color=ORANGE, lw=2.6, ms=9)
for x, y in zip(pct, agg):
    ax.annotate(f"{y:.0f} ms", (x, y), textcoords="offset points", xytext=(0, 10), ha="center", fontweight="bold", color=ORANGE)
ax.set_xlabel("% del dataset"); ax.set_ylabel("latenza p50 (ms)")
ax.set_title("Aggregazione full-scan vs dimensione dataset\ncresce ~lineare → sbatte contro il muro su 1 nodo", fontweight="bold")
ax.set_xticks(pct); ax.set_xticklabels([f"{p:.0f}%" for p in pct]); ax.set_ylim(0, max(agg) * 1.2)
fig.tight_layout(); fig.savefig(f"{OUT}/query-scale-aggregation.png"); plt.close(fig)

# 2) LOOKUP/FILTRO su indice → ~costanti (O(log n))
fig, ax = plt.subplots(figsize=(6.4, 4.2))
lk = [r["lookupP50"] for r in rows]; fl = [r["filtroP50"] for r in rows]
ax.plot(pct, lk, "-o", color=ACCENT, lw=2.6, ms=9, label="lookup per CIG (indice _id)")
ax.plot(pct, fl, "-s", color=ACCENT2, lw=2.6, ms=8, label="filtro per stazione (indice)")
ax.set_xlabel("% del dataset"); ax.set_ylabel("latenza p50 (ms)")
ax.set_title("Query su indice vs dimensione dataset\nrestano basse al crescere dei dati — O(log n)", fontweight="bold")
ax.set_xticks(pct); ax.set_xticklabels([f"{p:.0f}%" for p in pct]); ax.set_ylim(0, max(fl) * 1.5); ax.legend()
fig.tight_layout(); fig.savefig(f"{OUT}/query-scale-index.png"); plt.close(fig)

print("✓ grafici asse ① salvati in", OUT)
for r in rows:
    print(f"  {r['pct']:.0f}% ({r['lotti']:,}) | lookup {r['lookupP50']} ms | filtro {r['filtroP50']} ms | agg {r['aggP50']:.0f} ms")
