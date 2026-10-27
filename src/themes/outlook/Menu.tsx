import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Fluent-style menus (white surface, 4px radius, 32px items, overlay
 * shadow). Thin wrappers over Radix so keyboard and focus handling come
 * for free.
 */

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuSub = DM.Sub;
export const MenuGroup = DM.Group;
export const MenuRadioGroup = DM.RadioGroup;

export const MenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.Content>
>(function MenuContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <DM.Portal>
      <DM.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn("ol-menu", className)}
        {...props}
      />
    </DM.Portal>
  );
});

export const MenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.Item> & {
    icon?: ReactNode;
    shortcut?: string;
    danger?: boolean;
  }
>(function MenuItem(
  { className, icon, shortcut, danger, children, ...props },
  ref,
) {
  return (
    <DM.Item
      ref={ref}
      className={cn("ol-menu-item", danger && "ol-menu-item-danger", className)}
      {...props}
    >
      <span className="ol-menu-icon" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="ol-menu-shortcut">{shortcut}</span>}
    </DM.Item>
  );
});

export const MenuRadioItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.RadioItem>
>(function MenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DM.RadioItem
      ref={ref}
      className={cn("ol-menu-item", className)}
      {...props}
    >
      <span className="ol-menu-icon" aria-hidden>
        <DM.ItemIndicator>
          <Check size={14} />
        </DM.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </DM.RadioItem>
  );
});

export const MenuCheckboxItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.CheckboxItem>
>(function MenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DM.CheckboxItem
      ref={ref}
      className={cn("ol-menu-item", className)}
      {...props}
    >
      <span className="ol-menu-icon" aria-hidden>
        <DM.ItemIndicator>
          <Check size={14} />
        </DM.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </DM.CheckboxItem>
  );
});

export function MenuSubTrigger({
  icon,
  children,
}: {
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DM.SubTrigger className="ol-menu-item">
      <span className="ol-menu-icon" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight size={14} className="text-text-secondary" aria-hidden />
    </DM.SubTrigger>
  );
}

export const MenuSubContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DM.SubContent>
>(function MenuSubContent({ className, ...props }, ref) {
  return (
    <DM.Portal>
      <DM.SubContent
        ref={ref}
        sideOffset={2}
        className={cn("ol-menu", className)}
        {...props}
      />
    </DM.Portal>
  );
});

export function MenuSeparator() {
  return <DM.Separator className="ol-menu-sep" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="ol-menu-label">{children}</DM.Label>;
}

/**
 * A menu opened at a screen point (right-click / Shift+F10 context menus).
 * Radix needs a trigger, so a zero-size fixed anchor sits at the point.
 */
export function PointMenu({
  point,
  onClose,
  children,
  label,
}: {
  point: { x: number; y: number } | null;
  onClose: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <DM.Root open={!!point} onOpenChange={(o) => !o && onClose()} modal={false}>
      <DM.Trigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: point?.x ?? 0,
            top: point?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content
          align="start"
          side="bottom"
          sideOffset={2}
          collisionPadding={8}
          aria-label={label}
          className="ol-menu"
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {children}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
