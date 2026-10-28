import { Link } from "react-router-dom";
import Footer from "@/components/Footer";
import { WordmarkSmall } from "@/components/Wordmark";

interface LegalLayoutProps {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}

/**
 * Public, readable layout for legal pages (Terms, Privacy): navy chrome
 * with a light paper panel holding a comfortable reading column.
 */
export default function LegalLayout({
  title,
  lastUpdated,
  children,
}: LegalLayoutProps) {
  return (
    <div className="pt-auth">
      <header className="mx-auto flex w-full max-w-[1000px] items-center justify-between px-4 py-4 md:px-6">
        <Link to="/" className="transition-opacity hover:opacity-85">
          <WordmarkSmall />
        </Link>
        <Link
          to="/login"
          className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-chrome-fg-2 transition-colors hover:bg-chrome-hover hover:text-chrome-fg"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto w-full max-w-[1000px] flex-1 px-0 sm:px-4 md:px-6">
        <article className="border-chrome-edge bg-background px-5 py-10 text-text-primary shadow-raised sm:rounded-[18px] sm:border sm:px-12 sm:py-14">
          <div className="mx-auto max-w-[680px]">
            <header className="mb-8 border-b border-border pb-6">
              <p className="font-label text-text-tertiary">Legal</p>
              <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.02em] text-text-primary sm:text-[32px]">
                {title}
              </h1>
              <p className="mt-2 text-[13px] text-text-tertiary">
                Last updated · {lastUpdated}
              </p>
            </header>

            <div className="max-w-none [&_a]:font-medium [&_a]:text-accent [&_a:hover]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-text-secondary [&_code]:rounded [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-[-0.015em] [&_h2]:text-text-primary [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-text-primary [&_li]:my-1 [&_li]:text-[15px] [&_li]:leading-relaxed [&_li]:text-text-secondary [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-3 [&_p]:text-[15px] [&_p]:leading-relaxed [&_p]:text-text-secondary [&_strong]:font-semibold [&_strong]:text-text-primary [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6">
              {children}
            </div>
          </div>
        </article>
      </main>

      <Footer />
    </div>
  );
}
