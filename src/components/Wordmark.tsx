import { Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding";

interface WordmarkProps {
  className?: string;
}

/**
 * Larger ✦ + uppercase wordmark for auth/onboarding hero. Mirrors
 * givefeedback.dev's auth treatment: bright lime sparkle, extrabold
 * uppercase brand line. Sits above the auth card on the dark backdrop.
 */
export function WordmarkLarge({ className }: WordmarkProps) {
  const { brandName } = useBranding();
  return (
    <div
      className={cn("flex flex-col items-center gap-3 text-white", className)}
    >
      <Mail
        className="h-12 w-12"
        strokeWidth={2}
        style={{ color: "#BFFF00" }}
        aria-hidden
      />
      <h1 className="text-2xl font-extrabold uppercase tracking-tight">
        {brandName}
      </h1>
    </div>
  );
}
