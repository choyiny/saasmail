import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

const link =
  "rounded-md px-1.5 py-0.5 text-chrome-dim transition-colors hover:bg-chrome-hover hover:text-chrome-fg";

/**
 * One-row footer for public screens (auth, legal, unsubscribe). Drawn on
 * the navy chrome, under the paper or auth card.
 */
export default function Footer() {
  return (
    <footer className="w-full">
      <div
        className="mx-auto flex w-full max-w-[1200px] flex-col items-center gap-2 px-4 py-4 text-[12px] text-chrome-dim sm:flex-row sm:justify-between md:px-6"
        style={{
          paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
        }}
      >
        <nav className="flex items-center gap-1" aria-label="Legal">
          <Link to="/privacy" className={link}>
            Privacy
          </Link>
          <span aria-hidden className="opacity-50">
            ·
          </span>
          <Link to="/terms" className={link}>
            Terms
          </Link>
        </nav>

        <div className="tabular">© {new Date().getFullYear()} saasmail</div>

        <div className="flex items-center gap-1">
          <span>Sponsored by</span>
          <a
            href="https://givefeedback.dev/saas"
            target="_blank"
            rel="noreferrer"
            className={cn(link, "font-medium text-chrome-fg-2")}
          >
            givefeedback.dev
          </a>
        </div>
      </div>
    </footer>
  );
}
