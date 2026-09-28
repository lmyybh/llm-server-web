import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom does not implement the pointer capture and scrolling methods used by Radix Select.
Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Testing Library only auto-registers its cleanup when Vitest runs with
// `globals: true`. This project imports explicitly, so the DOM has to be torn
// down by hand — otherwise a second test sees the first test's markup.
afterEach(cleanup);
