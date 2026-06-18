"use client";

type Vicino = { label: string; peso: number; cf?: string | null };

/** Ego-network radiale: centro + vicini su un cerchio, spessore arco ~ peso. */
export function NetworkCard({
  centro,
  tipo,
  vicini,
}: {
  centro: string;
  tipo?: string;
  vicini: Vicino[];
}) {
  const W = 520;
  const H = 380;
  const cx = W / 2;
  const cy = H / 2;
  const R = 140;
  const v = vicini.slice(0, 12);
  const maxPeso = Math.max(1, ...v.map((n) => n.peso));

  const pts = v.map((n, i) => {
    const a = (2 * Math.PI * i) / v.length - Math.PI / 2;
    return { ...n, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });

  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  return (
    <div className="my-2 w-full max-w-xl overflow-hidden rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-1 px-1 text-sm font-medium text-zinc-700 dark:text-zinc-200">
        Rete di {tipo === "impresa" ? "committenti" : "aggiudicatari"} · {trunc(centro, 48)}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
        {/* archi */}
        {pts.map((p, i) => (
          <line
            key={`l${i}`}
            x1={cx} y1={cy} x2={p.x} y2={p.y}
            stroke="#c8c2ee"
            strokeWidth={1 + (p.peso / maxPeso) * 5}
            strokeLinecap="round"
          />
        ))}
        {/* nodi vicini */}
        {pts.map((p, i) => (
          <g key={`n${i}`}>
            <circle cx={p.x} cy={p.y} r={7 + (p.peso / maxPeso) * 7} fill="#4b2fd6" opacity={0.85} />
            <text
              x={p.x}
              y={p.y - 14}
              textAnchor="middle"
              fontSize="10"
              fill="#3f3f46"
              className="dark:fill-zinc-300"
            >
              {trunc(p.label, 22)}
            </text>
            <text x={p.x} y={p.y + 3} textAnchor="middle" fontSize="9" fill="#fff" fontWeight="600">
              {p.peso}
            </text>
          </g>
        ))}
        {/* centro */}
        <circle cx={cx} cy={cy} r={26} fill="#111418" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize="10" fill="#fff" fontWeight="700">
          {trunc(centro.split(" ")[0], 12)}
        </text>
      </svg>
    </div>
  );
}
