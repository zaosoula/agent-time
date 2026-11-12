interface ScrollPosition { element: HTMLElement; top: number; left: number; }
/** Only mounted, visited pages retain their own DOM nodes; no history snapshots. */
export function capturePageScroll(root: HTMLElement): ScrollPosition[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
    .filter(element => element.scrollTop !== 0 || element.scrollLeft !== 0)
    .map(element => ({ element, top: element.scrollTop, left: element.scrollLeft }));
}
export function restorePageScroll(root: HTMLElement, positions: ScrollPosition[]) {
  for (const { element, top, left } of positions) if (element === root || root.contains(element)) {
    element.scrollTop = top;
    element.scrollLeft = left;
  }
}
