import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-[13.5px] font-medium leading-none tracking-[-0.006em] transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-accent text-accent-foreground shadow-card hover:bg-accent-hover",
        cta: "bg-accent text-accent-foreground shadow-card hover:bg-accent-hover",
        destructive:
          "bg-destructive text-destructive-foreground shadow-card hover:bg-destructive/90",
        outline:
          "bg-card text-text-primary shadow-card ring-1 ring-inset ring-border-strong hover:bg-bg-subtle",
        secondary:
          "bg-bg-muted text-text-primary hover:bg-bg-muted/70 ring-1 ring-inset ring-border",
        ghost: "text-text-secondary hover:bg-bg-muted hover:text-text-primary",
        link: "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 px-3 text-[13px] [&_svg]:size-3.5",
        lg: "h-10 px-5",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
