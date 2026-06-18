import { cn } from "@/lib/utils";

const sizes = {
  sm: "text-xl",
  md: "text-2xl",
  lg: "text-4xl",
} as const;

export function SiteLogo({
  size = "md",
  className,
}: {
  size?: keyof typeof sizes;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "font-sans font-bold tracking-tight text-zinc-900 select-none dark:text-zinc-50",
        sizes[size],
        className
      )}
    >
      TenLens
    </span>
  );
}
