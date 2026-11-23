import { cn } from "@/lib/utils";

/**
 * The product's wordmark: "Growth", with "by Setups Works" beneath it.
 * Used beside the logo mark everywhere the brand is shown, so the lockup
 * cannot drift between the site, the app and the sign-in pages.
 */
export function BrandName({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("grid min-w-0 text-left leading-tight", className)}>
      <span className={cn("truncate font-semibold tracking-tight", compact ? "text-sm" : "text-base")}>Growth</span>
      <span className="truncate text-[11px] font-normal text-muted-foreground">by Setups Works</span>
    </span>
  );
}
