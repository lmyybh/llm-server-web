import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Testing Library only auto-registers its cleanup when Vitest runs with
// `globals: true`. This project imports explicitly, so the DOM has to be torn
// down by hand — otherwise a second test sees the first test's markup.
afterEach(cleanup);
