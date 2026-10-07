import { marked } from "marked";
import DOMPurify from "dompurify";
import { linkFileReferences } from "./fileLinks";
import { segmentLongMarkdown } from "./longText";

/** One completed block; diagnostics contain timings only, never conversational text. */
export function renderMarkdown(text: string, element: HTMLElement) {
  const renderer = new marked.Renderer();
  const renderLink = renderer.link.bind(renderer);
  renderer.link = function (token) {
    if (/^file:\/\//i.test(token.href)) {
      const safe = token.href
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;");
      return `<a data-file-reference="${safe}">${this.parser.parseInline(token.tokens)}</a>`;
    }
    return renderLink(token);
  };
  const started = performance.now();
  const html = marked.parse(text, { async: false, renderer }) as string;
  const parsed = performance.now();
  const sanitized = DOMPurify.sanitize(html);
  const cleaned = performance.now();
  element.innerHTML = sanitized;
  segmentLongMarkdown(element);
  const applied = performance.now();
  linkFileReferences(element);
  const linked = performance.now();
  return {
    parseMs: parsed - started,
    sanitizeMs: cleaned - parsed,
    domMs: applied - cleaned,
    fileLinksMs: linked - applied,
  };
}
