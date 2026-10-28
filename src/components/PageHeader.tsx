import { cn } from "@/lib/utils";

interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  /** Tabs or a segmented control shown next to the title. */
  tabs?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/**
 * The portal's one-row module header: title (with an optional muted
 * subtitle), optional tabs, and actions pushed to the right. Wraps on
 * narrow screens.
 */
export default function PageHeader({
  title,
  subtitle,
  tabs,
  action,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("pt-head", className)}>
      <div className="flex min-w-0 flex-col">
        <h1>{title}</h1>
        {subtitle && <p className="pt-head-sub mt-0.5 max-w-2xl">{subtitle}</p>}
      </div>
      {tabs && <div className="pt-tabs min-w-0">{tabs}</div>}
      {action && <div className="pt-head-actions">{action}</div>}
    </div>
  );
}

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
  /** Narrower reading width for forms and settings. */
  narrow?: boolean;
}

/** Standard page frame inside the paper panel. */
export function PageContainer({
  children,
  className,
  narrow,
}: PageContainerProps) {
  return (
    <div className={cn("pt-page flex-1", narrow && "narrow", className)}>
      {children}
    </div>
  );
}
