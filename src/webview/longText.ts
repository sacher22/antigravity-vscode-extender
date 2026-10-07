// Bounded layout units keep appending to a very long answer from laying out its
// entire prefix again. Text remains in the DOM, including offscreen segments.
export const TEXT_SEGMENT_SIZE = 8192;
export const LONG_TEXT_THRESHOLD = TEXT_SEGMENT_SIZE * 4;
// Completed rich paragraphs can each fall below the streaming threshold.
export const MARKDOWN_TEXT_SEGMENT_THRESHOLD = TEXT_SEGMENT_SIZE * 2;

function endOfSegment(text: string, start: number): number {
  let end = Math.min(start + TEXT_SEGMENT_SIZE, text.length);
  if (end < text.length) {
    // Prefer a natural wrap opportunity without producing tiny segments.
    const minimum = start + TEXT_SEGMENT_SIZE / 2;
    for (let at = end; at >= minimum; at--) {
      if (/\s/.test(text[at - 1])) {
        end = at;
        break;
      }
    }
    // Never separate a UTF-16 surrogate pair.
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return end;
}

function appendSegments(element: HTMLElement, text: string, preserveBoundaryWhitespace = false) {
  const fragment = element.ownerDocument.createDocumentFragment();
  for (let start = 0; start < text.length;) {
    const end = endOfSegment(text, start);
    const part = text.slice(start, end);
    const boundary = preserveBoundaryWhitespace ? /^([ \t\r\n\f]*)([\s\S]*?)([ \t\r\n\f]*)$/.exec(part)! : [part, "", part, ""];
    // Collapsible spaces belong to the surrounding inline flow. Putting them
    // inside an inline-block would strip separators when copying prose.
    if (boundary[1]) fragment.appendChild(element.ownerDocument.createTextNode(boundary[1]));
    if (boundary[2]) {
      const segment = element.ownerDocument.createElement("span");
      segment.className = "text-segment";
      segment.textContent = boundary[2];
      fragment.appendChild(segment);
    }
    if (boundary[3]) fragment.appendChild(element.ownerDocument.createTextNode(boundary[3]));
    start = end;
  }
  element.appendChild(fragment);
}

export function updateStreamText(
  element: HTMLElement,
  text: string,
  previous: string,
) {
  const append = text.startsWith(previous);
  if (!append || !element.firstChild) {
    element.textContent = "";
    if (text.length >= LONG_TEXT_THRESHOLD) appendSegments(element, text);
    else element.textContent = text;
    return;
  }
  if (element.firstChild.nodeType === 3) {
    if (text.length < LONG_TEXT_THRESHOLD) {
      (element.firstChild as Text).appendData(text.slice(previous.length));
    } else {
      element.textContent = "";
      appendSegments(element, text);
    }
    return;
  }
  let delta = text.slice(previous.length);
  const last = element.lastElementChild as HTMLElement | null;
  if (last && last.textContent!.length < TEXT_SEGMENT_SIZE) {
    let take = Math.min(
      TEXT_SEGMENT_SIZE - last.textContent!.length,
      delta.length,
    );
    const end = delta.charCodeAt(take - 1);
    if (take < delta.length && end >= 0xd800 && end <= 0xdbff) take--;
    (last.firstChild as Text).appendData(delta.slice(0, take));
    delta = delta.slice(take);
  }
  if (delta) appendSegments(element, delta);
}

/** Preserve Markdown structure; only segment large plain paragraph/code leaves. */
export function segmentLongMarkdown(element: HTMLElement) {
  for (const leaf of Array.from(
    element.querySelectorAll<HTMLElement>("p, pre > code"),
  )) {
    const walker = element.ownerDocument.createTreeWalker(leaf, 4);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (
        node.length >= MARKDOWN_TEXT_SEGMENT_THRESHOLD &&
        !node.parentElement?.closest(".text-segment")
      )
        nodes.push(node);
    }
    for (const node of nodes) {
      const staging = element.ownerDocument.createElement("div");
      appendSegments(staging, node.data, !leaf.closest("pre"));
      const fragment = element.ownerDocument.createDocumentFragment();
      while (staging.firstChild) fragment.appendChild(staging.firstChild);
      node.replaceWith(fragment);
    }
  }
}
