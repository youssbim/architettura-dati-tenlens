"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Row = Record<string, unknown>;

const COLORS = [
  "#4b2fd6", "#007a5e", "#d6822f", "#2f9bd6", "#c0392b",
  "#8e44ad", "#16a085", "#e67e22", "#2c3e50", "#27ae60",
];

const fmt = (v: number) =>
  Math.abs(v) >= 1000
    ? new Intl.NumberFormat("it-IT", { notation: "compact", maximumFractionDigits: 1 }).format(v)
    : String(v);

function pickKeys(rows: Row[]): { labelKey: string; valueKey: string } | null {
  if (!rows.length) return null;
  const keys = Object.keys(rows[0]);
  const valueKey = keys.find((k) => rows.every((r) => typeof r[k] === "number"));
  const labelKey = keys.find((k) => k !== valueKey);
  if (!valueKey || !labelKey) return null;
  return { labelKey, valueKey };
}

export function ChartCard({
  titolo,
  tipo,
  rows,
}: {
  titolo?: string;
  tipo?: string;
  rows: Row[];
}) {
  const picked = pickKeys(rows);
  if (!picked) return null;
  const { labelKey, valueKey } = picked;

  const data = rows.slice(0, 20).map((r) => ({
    label: String(r[labelKey] ?? "—"),
    value: Number(r[valueKey] ?? 0),
  }));

  const chartType = tipo === "line" ? "line" : tipo === "pie" ? "pie" : "bar";

  return (
    <div className="my-2 w-full max-w-xl rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      {titolo && (
        <p className="mb-3 text-sm font-medium text-zinc-700 dark:text-zinc-200">{titolo}</p>
      )}
      <ResponsiveContainer width="100%" height={chartType === "pie" ? 260 : 240}>
        {chartType === "bar" ? (
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={0} angle={-25} textAnchor="end" height={64} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={fmt} width={44} />
            <Tooltip formatter={((v: number) => fmt(Number(v))) as never} />
            <Bar dataKey="value" fill="#4b2fd6" radius={[3, 3, 0, 0]} />
          </BarChart>
        ) : chartType === "line" ? (
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" height={40} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={fmt} width={44} />
            <Tooltip formatter={((v: number) => fmt(Number(v))) as never} />
            <Line type="monotone" dataKey="value" stroke="#4b2fd6" strokeWidth={2} dot={false} />
          </LineChart>
        ) : (
          <PieChart>
            <Tooltip formatter={((v: number) => fmt(Number(v))) as never} />
            <Pie data={data} dataKey="value" nameKey="label" outerRadius={95} label>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
          </PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
