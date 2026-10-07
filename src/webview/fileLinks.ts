// Run once on completed Markdown, never on streaming deltas or fenced code.
export function linkFileReferences(container: HTMLElement): void {
  for (const anchor of Array.from(
    container.querySelectorAll<HTMLAnchorElement>("a[data-file-reference]"),
  )) {
    anchor.setAttribute("href", anchor.dataset.fileReference!);
    anchor.removeAttribute("data-file-reference");
  }
  // Inline code can unambiguously delimit paths containing spaces.
  for (const code of Array.from(container.querySelectorAll("code"))) {
    if (code.closest("pre, a")) continue;
    const reference = code.textContent?.trim() || "";
    if (
      /^(?:\/|~\/|file:\/\/\/|[A-Za-z]:[\\/])/.test(reference) &&
      !/[\n\r<>]/.test(reference)
    ) {
      const link = document.createElement("a");
      link.setAttribute("href", reference);
      link.title = `在 VS Code 打开：${reference}`;
      code.replaceWith(link);
      link.append(code);
    }
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("a, pre, script, style")) nodes.push(node);
  }
  // Relative references need a filename extension; absolute references may name directories.
  const pattern =
    /(?<![\w@:/\\.-])(?:(?:file:\/\/\/|\/|~\/|[A-Za-z]:[\\/])[^\s<>"'`，。；！？（）【】]+|(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][\w-]*(?:(?::\d+(?::\d+)?)|(?:#L\d+(?:C\d+)?))?)/g;
  for (const node of nodes) {
    pattern.lastIndex = 0;
    const value = node.data;
    let cursor = 0;
    const fragment = document.createDocumentFragment();
    for (const match of value.matchAll(pattern)) {
      const start = match.index!;
      // Do not link a substring of a URL, identifier, or email.
      if (start > 0 && /[\w@:/\\.-]/.test(value[start - 1])) continue;
      const reference = match[0].replace(/[.,;:!?\)\]\}]+$/, "");
      if (!reference || reference === "/") continue;
      fragment.append(value.slice(cursor, start));
      const link = document.createElement("a");
      link.setAttribute("href", reference);
      link.title = `在 VS Code 打开：${reference}`;
      link.textContent = reference;
      fragment.append(link);
      cursor = start + reference.length;
    }
    if (cursor) {
      fragment.append(value.slice(cursor));
      node.replaceWith(fragment);
    }
  }
}
