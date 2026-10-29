import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { avatarSlot, initials } from "./lib";

/** Fluent persona avatar: coloured circle with initials. */
export function Avatar({
  name,
  seed,
  size = 32,
  className,
}: {
  name: string | null | undefined;
  seed: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("ol-avatar", className)}
      data-c={avatarSlot(seed)}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials(name || seed)}
    </span>
  );
}

/** Square icon button with a required accessible name. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    label: string;
    children: ReactNode;
    size?: "sm" | "md" | "lg";
  }
>(function IconButton(
  { label, children, className, size = "md", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "ol-icon-btn",
        size === "sm" && "ol-icon-btn-sm",
        size === "lg" && "ol-icon-btn-lg",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});

/** Red Outlook flag glyph (filled when flagged). */
export function FlagGlyph({
  filled,
  size = 16,
}: {
  filled?: boolean;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      aria-hidden
      className={filled ? "text-star" : undefined}
    >
      <path
        d="M4 2.5a.5.5 0 0 1 .5-.5h11.2a.5.5 0 0 1 .4.8L13.3 7l2.8 4.2a.5.5 0 0 1-.4.8H5v5.5a.5.5 0 0 1-1 0V2.5Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={filled ? 0 : 1.1}
        strokeLinejoin="round"
      />
    </svg>
  );
}
