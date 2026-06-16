import "@testing-library/jest-dom/vitest";
import { mockResizeObserver } from "jsdom-testing-mocks";

// tldraw relies on browser APIs jsdom does not implement. Polyfill the ones it
// touches during Editor construction and store operations.
mockResizeObserver();

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (!HTMLCanvasElement.prototype.getContext) {
  // Minimal 2d context stub for tldraw's text measurement paths.
  HTMLCanvasElement.prototype.getContext = (() => ({
    measureText: () => ({ width: 0 }),
    fillRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data: [] }),
    putImageData: () => {},
    createImageData: () => [],
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    fill: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    fillText: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
}

const doc = document as unknown as { fonts?: unknown };
if (!doc.fonts) {
  doc.fonts = {
    ready: Promise.resolve(),
    check: () => true,
    load: () => Promise.resolve([]),
    addEventListener: () => {},
    removeEventListener: () => {},
    forEach: () => {},
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
