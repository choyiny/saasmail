import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent/40",
  {
    variants: {
      variant: {
        default: "bg-accent-subtle text-accent-subtle-fg",
        secondary: "bg-bg-muted text-text-secondary",
        destructive: "bg-destructive-subtle text-destructive",
        success: "bg-emerald-50 text-emerald-700",
        warning: "bg-warning-bg text-warning-text",
        outline: "text-text-primary ring-1 ring-gray-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
