import DOMPurify from "dompurify";
import { marked } from "marked";

const AGENT_MARKDOWN_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "a",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

function allowedLink(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href.trim());
}

export function renderAgentMarkdown(markdown: string): string {
  const parsed = marked.parse(markdown, { async: false });
  const sanitized = DOMPurify.sanitize(parsed, {
    ALLOWED_TAGS: AGENT_MARKDOWN_TAGS,
    ALLOWED_ATTR: ["href", "title", "target", "rel"],
  });

  const template = document.createElement("template");
  template.innerHTML = sanitized;

  for (const anchor of template.content.querySelectorAll("a")) {
    const href = anchor.getAttribute("href");
    if (!href || !allowedLink(href)) {
      anchor.removeAttribute("href");
      anchor.removeAttribute("target");
      anchor.removeAttribute("rel");
      continue;
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer");
  }

  return template.innerHTML;
}

export function AgentMarkdown({ text }: { text: string }) {
  return (
    <div
      className="space-y-2 break-words text-sm leading-6 text-text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-bg-muted [&_code]:px-1 [&_pre]:overflow-x-auto [&_pre]:rounded-[6px] [&_pre]:bg-bg-muted [&_pre]:p-2"
      dangerouslySetInnerHTML={{ __html: renderAgentMarkdown(text) }}
    />
  );
}
