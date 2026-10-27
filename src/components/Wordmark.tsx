import { Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBranding } from "@/lib/branding";

interface WordmarkProps {
  className?: string;
}

/**
 * Brand mark + uppercase wordmark (Inter Tight 900) for the auth and
 * onboarding screens. Sits above the auth card on the navy chrome.
 */
export function WordmarkLarge({ className }: WordmarkProps) {
  const { brandName } = useBranding();
  return (
    <div className={cn("flex items-center justify-center gap-2.5", className)}>
      <span className="brand-mark !h-8 !w-8 !rounded-[9px]" aria-hidden>
        <Mail size={16} strokeWidth={2.4} />
      </span>
      <span className="brand-wordmark !text-[21px]">{brandName}</span>
    </div>
  );
}

/** Compact brand row used in page headers on the chrome (legal pages). */
export function WordmarkSmall({ className }: WordmarkProps) {
  const { brandName } = useBranding();
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <span className="brand-mark" aria-hidden>
        <Mail size={14} strokeWidth={2.4} />
      </span>
      <span className="brand-wordmark">{brandName}</span>
    </span>
  );
}

interface AuthCardProps {
  /** Card heading, sentence case. */
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  /** Wider card for multi-field forms (consent, onboarding). */
  wide?: boolean;
  className?: string;
}

/**
 * The portal sign-in frame: wordmark on the navy chrome, then one light
 * card (18px radius) holding the form.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  wide,
  className,
}: AuthCardProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center gap-7",
        wide ? "max-w-[480px]" : "max-w-[420px]",
      )}
    >
      <WordmarkLarge />
      <div className={cn("pt-auth-card", wide && "!max-w-[480px]", className)}>
        {(title || subtitle) && (
          <div className="mb-6">
            {title && (
              <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
                {title}
              </h1>
            )}
            {subtitle && (
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-secondary">
                {subtitle}
              </p>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/** Inline error banner for auth forms. */
export function AuthError({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="mb-4 rounded-lg border border-destructive/25 bg-destructive-subtle px-3 py-2 text-[13px] text-destructive"
    >
      {children}
    </p>
  );
}
