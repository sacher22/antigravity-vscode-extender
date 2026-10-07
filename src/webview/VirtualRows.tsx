import React, { ReactNode, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HeightIndex } from "./heightIndex";

/** Viewport rows retain expanded details and selection endpoints while scrolling. */
export function VirtualRows<T>({items, itemKey, renderItem, estimate, threshold = 60, kind}: {
  items: T[];
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  estimate: number;
  threshold?: number;
  kind: "tool" | "message";
}) {
  const container = useRef<HTMLDivElement>(null);
  const measured = useRef(new Map<string, number>());
  const keys = items.map(itemKey);
  const signature = keys.join("\0");
  const heights = useMemo(() => new HeightIndex(keys.map(key => measured.current.get(key) || estimate)), [signature, estimate]);
  const [range, setRange] = useState({start: 0, end: 30});
  const [pins, setPins] = useState(new Set<string>());
  const [, resize] = useState(0);
  const restore = useRef<{key: string; offset: number} | undefined>(undefined);
  const virtual = items.length > threshold && typeof ResizeObserver !== "undefined";
  useLayoutEffect(() => {
    if (!virtual || kind !== "message" || !container.current) return;
    const root = container.current.closest(".messages") as HTMLElement | null;
    if (!root) return;
    const listener = (event: Event) => {
      const anchor = (event as CustomEvent).detail as {key: string; offset: number};
      const index = keys.indexOf(anchor.key);
      if (index < 0) return;
      restore.current = anchor;
      setRange({start: Math.max(0, index - 10), end: Math.min(items.length, index + 30)});
      resize(value => value + 1);
    };
    root.addEventListener("restore-virtual-anchor", listener);
    return () => root.removeEventListener("restore-virtual-anchor", listener);
  }, [heights, virtual, kind]);
  useLayoutEffect(() => {
    const anchor = restore.current;
    if (!anchor || !container.current) return;
    const root = container.current.closest(".messages") as HTMLElement | null;
    const row = Array.from(container.current.children).find(child => (child as HTMLElement).dataset.virtualKey === anchor.key);
    if (!root || !row) return;
    // Correct estimated prefix heights before restoring the DOM anchor. A scroll
    // lookup against old estimates could otherwise unmount the restored row.
    let changed = false;
    for (const child of Array.from(container.current.children)) {
      const element = child as HTMLElement;
      if (element.dataset.virtualIndex === undefined) continue;
      const index = Number(element.dataset.virtualIndex);
      const height = element.getBoundingClientRect().height;
      if (!keys[index] || height < 1) continue;
      measured.current.set(keys[index], height);
      if (Math.abs(heights.update(index, height)) > 0.5) changed = true;
    }
    if (changed) {resize(value => value + 1);return;}
    root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.offset;
    restore.current = undefined;
  });
  useLayoutEffect(() => {
    if (!virtual || !container.current) return;
    const element = container.current;
    const root = element.closest(".messages") as HTMLElement | null;
    if (!root) return;
    let frame = 0;
    const position = () => {
      frame = 0;
      if (restore.current) return;
      const localTop = root.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const start = Math.max(0, heights.locate(Math.max(0, localTop)) - 10);
      const end = Math.min(items.length, heights.locate(Math.max(0, localTop + root.clientHeight)) + 11);
      setRange(previous => previous.start === start && previous.end === end ? previous : {start, end});
    };
    const schedule = () => {if (!frame) frame = requestAnimationFrame(position);};
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    root.addEventListener("scroll", schedule, {passive: true});
    position();
    return () => {cancelAnimationFrame(frame);observer.disconnect();root.removeEventListener("scroll", schedule);};
  }, [heights, virtual]);
  useLayoutEffect(() => {
    if (!virtual || !container.current) return;
    const element = container.current;
    const root = element.closest(".messages") as HTMLElement | null;
    if (!root) return;
    const observer = new ResizeObserver(entries => {
      const localTop = root.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const anchor = heights.locate(Math.max(0, localTop));
      let changed = false, compensation = 0;
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        const index = Number(row.dataset.virtualIndex);
        const height = row.getBoundingClientRect().height;
        if (!keys[index] || height < 1) continue;
        measured.current.set(keys[index], height);
        const delta = heights.update(index, height);
        if (Math.abs(delta) > 0.5) {changed = true;if (index < anchor) compensation += delta;}
      }
      const owner = kind === "tool" ? element.closest(".virtual-row") : null;
      // A fully offscreen message is anchored by the outer message list; its
      // nested tool list must not compensate the same height change twice.
      if (owner && owner.getBoundingClientRect().bottom <= root.getBoundingClientRect().top) compensation = 0;
      if (compensation) root.scrollTop += compensation;
      if (changed) resize(value => value + 1);
    });
    for (const row of Array.from(element.children))
      if ((row as HTMLElement).dataset.virtualIndex !== undefined) observer.observe(row);
    return () => observer.disconnect();
  }, [heights, range.start, range.end, pins, virtual]);
  useLayoutEffect(() => {
    if (!virtual || !container.current) return;
    const element = container.current;
    const updatePins = () => {
      const next = new Set<string>();
      const containingRow = (node: Element | null | undefined) => {
        let row = node?.closest("[data-virtual-key]") as HTMLElement | null;
        while (row && row.parentElement !== element) row = row.parentElement?.closest("[data-virtual-key]") as HTMLElement | null;
        return row;
      };
      for (const details of Array.from(element.querySelectorAll("details[open]"))) {
        const row = containingRow(details);
        if (row && row.parentElement === element) next.add(row.dataset.virtualKey!);
      }
      const focused = containingRow(document.activeElement);
      if (focused && focused.parentElement === element) next.add(focused.dataset.virtualKey!);
      const selection = getSelection();
      const selectedIndices: number[] = [];
      for (const node of [selection?.anchorNode, selection?.focusNode]) {
        const parent = node?.nodeType === 1 ? node as Element : node?.parentElement;
        const row = containingRow(parent);
        if (row && row.parentElement === element && selection && !selection.isCollapsed) {
          next.add(row.dataset.virtualKey!);
          selectedIndices.push(Number(row.dataset.virtualIndex));
        }
      }
      if (selectedIndices.length === 2)
        for (let index = Math.min(...selectedIndices); index <= Math.max(...selectedIndices); index++) next.add(keys[index]);
      setPins(previous => previous.size === next.size && [...previous].every(key => next.has(key)) ? previous : next);
    };
    element.addEventListener("toggle", updatePins, true);
    element.addEventListener("focusin", updatePins);
    element.addEventListener("focusout", updatePins);
    document.addEventListener("selectionchange", updatePins);
    return () => {element.removeEventListener("toggle", updatePins, true);element.removeEventListener("focusin", updatePins);element.removeEventListener("focusout", updatePins);document.removeEventListener("selectionchange", updatePins);};
  }, [virtual, heights]);
  const rows: ReactNode[] = [];
  if (virtual) {
    const indices = new Set<number>();
    for (let index = range.start; index < Math.min(items.length, range.end); index++) indices.add(index);
    keys.forEach((key, index) => {if (pins.has(key)) indices.add(index);});
    let cursor = 0;
    for (const index of [...indices].sort((a, b) => a - b)) {
      if (index > cursor) rows.push(<div aria-hidden="true" key={`gap-${cursor}`} style={{height: heights.offset(index) - heights.offset(cursor)}} />);
      rows.push(<div className="virtual-row" key={`row:${keys[index]}`} data-virtual-key={keys[index]} data-virtual-index={index}>{renderItem(items[index])}</div>);
      cursor = index + 1;
    }
    if (cursor < items.length) rows.push(<div aria-hidden="true" key="gap-end" style={{height: heights.total - heights.offset(cursor)}} />);
  } else items.forEach((item, index) => rows.push(<React.Fragment key={keys[index]}>{renderItem(item)}</React.Fragment>));
  return <div ref={container} data-virtual-kind={kind} data-virtual-total={items.length} data-virtualized={virtual || undefined}>{rows}</div>;
}
