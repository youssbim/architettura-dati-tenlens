#!/usr/bin/env python3
"""Grafici ricerca vettoriale — MongoDB brute-force vs Elasticsearch HNSW."""
import json, os
import matplotlib
matplotlib.use("Agg"); import matplotlib.pyplot as plt

OUT = "../benchmarks"
mongo = [json.loads(l) for l in open(f"{OUT}/search-mongo.jsonl") if l.strip()]
es = [json.loads(l) for l in open(f"{OUT}/search-es.jsonl") if l.strip()]
mongo.sort(key=lambda r: r["N"]); es.sort(key=lambda r: r["N"])
N = [r["N"]/1000 for r in mongo]
MONGO = "#c2410c"; ES = "#4b2fd6"
plt.rcParams.update({"font.size":13,"axes.spines.top":False,"axes.spines.right":False,"axes.grid":True,"grid.alpha":0.25,"figure.dpi":130})

# 1) latenza: Mongo lineare vs ES sublineare
fig, ax = plt.subplots(figsize=(6.8,4.4))
ax.plot(N,[r["p50"] for r in mongo],"-o",color=MONGO,lw=2.6,ms=8,label="MongoDB brute-force (esatto)")
ax.plot(N,[r["p50"] for r in es],"-s",color=ES,lw=2.6,ms=8,label="Elasticsearch HNSW (approx)")
for r,y in zip(mongo,[r["p50"] for r in mongo]): ax.annotate(f"{y:.0f}",(r['N']/1000,y),textcoords="offset points",xytext=(0,9),ha="center",fontweight="bold",color=MONGO,fontsize=11)
for r,y in zip(es,[r["p50"] for r in es]): ax.annotate(f"{y:.0f}",(r['N']/1000,y),textcoords="offset points",xytext=(0,-16),ha="center",fontweight="bold",color=ES,fontsize=11)
ax.set_xlabel("N vettori (migliaia)"); ax.set_ylabel("latenza p50 (ms)")
ax.set_title("Ricerca vettoriale — latenza vs scala\nMongo O(N) lineare · ES sublineare (forbice si allarga)",fontweight="bold")
ax.set_ylim(bottom=0); ax.legend()
fig.tight_layout(); fig.savefig(f"{OUT}/search-latency.png"); plt.close(fig)

# 2) recall ES (il prezzo di HNSW)
fig, ax = plt.subplots(figsize=(6.8,4.4))
rc=[r["recall"] for r in es]
ax.plot(N,rc,"-s",color=ES,lw=2.6,ms=9)
for r,y in zip(es,rc): ax.annotate(f"{y:.1f}%",(r['N']/1000,y),textcoords="offset points",xytext=(0,10),ha="center",fontweight="bold",color=ES)
ax.axhline(100,ls="--",color=MONGO,lw=2,label="MongoDB = 100% (esatto)")
ax.set_xlabel("N vettori (migliaia)"); ax.set_ylabel("recall@10 (%)")
ax.set_title("Il prezzo di ES — recall scende con N\n(HNSW approssimato, num_candidates fisso)",fontweight="bold")
ax.set_ylim(80,101); ax.legend()
fig.tight_layout(); fig.savefig(f"{OUT}/search-recall.png"); plt.close(fig)

# 3) throughput q/s — Mongo crolla vs ES piatto
fig, ax = plt.subplots(figsize=(6.8,4.4))
ax.plot(N,[r["qps"] for r in mongo],"-o",color=MONGO,lw=2.6,ms=8,label="MongoDB brute-force")
ax.plot(N,[r["qps"] for r in es],"-s",color=ES,lw=2.6,ms=8,label="Elasticsearch HNSW")
for r in mongo: ax.annotate(f"{r['qps']}",(r['N']/1000,r['qps']),textcoords="offset points",xytext=(0,-16),ha="center",fontweight="bold",color=MONGO,fontsize=11)
for r in es: ax.annotate(f"{r['qps']}",(r['N']/1000,r['qps']),textcoords="offset points",xytext=(0,9),ha="center",fontweight="bold",color=ES,fontsize=11)
ax.set_xlabel("N vettori (migliaia)"); ax.set_ylabel("throughput (query/secondo)")
ax.set_title("Ricerca vettoriale — throughput vs scala\nMongo crolla (O(N)) · ES regge (forbice si allarga)",fontweight="bold")
ax.set_ylim(bottom=0); ax.legend()
fig.tight_layout(); fig.savefig(f"{OUT}/search-throughput.png"); plt.close(fig)

print("✓ grafici ricerca salvati")
for m,e in zip(mongo,es): print(f"  {m['N']:>7} | Mongo {m['p50']:>6.1f} ms | ES {e['p50']:>5.1f} ms ({e['recall']}% recall) | {m['p50']/e['p50']:.1f}× ES più veloce")
