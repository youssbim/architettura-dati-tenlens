"use client";

import { ArrowUpRight } from "lucide-react";

const PROMPTS = [
  "Chi sono i maggiori aggiudicatari di appalti pubblici in Italia?",
  "Cos'è un CIG e a cosa serve negli appalti?",
  "Spiegami il record linkage tra imprese e stazioni appaltanti",
  "Come si individuano concentrazioni di mercato sospette?",
];

export function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
      {PROMPTS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          className="group flex items-start justify-between gap-2 rounded-xl border border-zinc-200/80 bg-white/60 px-4 py-3 text-left text-sm text-zinc-600 shadow-sm backdrop-blur-xl transition-all hover:border-zinc-300 hover:bg-white hover:text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300 dark:hover:bg-zinc-900"
        >
          <span>{p}</span>
          <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500" />
        </button>
      ))}
    </div>
  );
}
