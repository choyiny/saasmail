import { PenSquare } from "lucide-react";

interface ComposeFabProps {
  onClick: () => void;
}

/**
 * Mobile-only floating action button for Compose.
 * Hidden on sm+ where the header has an inline Compose button.
 * Sits bottom-right with safe-area-aware spacing so it clears the
 * iOS home indicator and footer.
 */
export default function ComposeFab({ onClick }: ComposeFabProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Compose new email"
      className="compose-fab fixed bottom-5 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent text-accent-foreground shadow-overlay transition-transform active:scale-95 sm:hidden"
      style={{
        bottom: "max(1.25rem, calc(env(safe-area-inset-bottom) + 0.75rem))",
      }}
    >
      <PenSquare className="h-5 w-5" strokeWidth={2.25} />
    </button>
  );
}
