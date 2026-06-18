"use client";

import { useRef, useState } from "react";
import { ArrowRight, Square } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  isLoading: boolean;
  placeholder?: string;
}

export function ChatInput({ onSubmit, onCancel, isLoading, placeholder }: Props) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  const submit = () => {
    const query = value.trim();
    if (!query || isLoading) return;
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    onSubmit(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="w-full">
      <div className="rounded-[22px] border border-white/65 bg-white/60 shadow-[0_4px_10px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.85),inset_0_-6px_14px_rgba(255,255,255,0.18)] backdrop-blur-2xl dark:border-white/10 dark:bg-zinc-800/60">
        <div className="px-4 pt-4">
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={placeholder ?? "Scrivi un messaggio…"}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              grow(e.target);
            }}
            onKeyDown={handleKeyDown}
            className="w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-base leading-6 outline-none placeholder:text-zinc-400 dark:text-zinc-100 max-h-48"
          />
        </div>

        <div className="flex items-center justify-end p-2.5">
          <button
            type="button"
            onClick={() => (isLoading ? onCancel() : submit())}
            disabled={!isLoading && !value.trim()}
            className={cn(
              "relative flex h-8 w-8 items-center justify-center rounded-[10px] border border-white/30 bg-gradient-to-b from-neutral-700 to-black text-white shadow-[0_5px_14px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.24)] backdrop-blur-xl transition-all duration-150 active:enabled:scale-95",
              "cursor-pointer disabled:cursor-default disabled:from-neutral-600 disabled:to-black disabled:opacity-60"
            )}
            aria-label={isLoading ? "Interrompi" : "Invia"}
          >
            {isLoading ? (
              <Square className="h-4 w-4" fill="currentColor" strokeWidth={0} />
            ) : (
              <ArrowRight className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
