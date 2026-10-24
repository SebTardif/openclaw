/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { rasterizeSvg } from "./svg-icon-rasterizer.ts";

function svgBlob(transform: string): Blob {
  return new Blob(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1 L2 2" transform="${transform}"/></svg>`,
    ],
    { type: "image/svg+xml" },
  );
}

function installRasterStubs(): void {
  class ImmediateImage extends EventTarget {
    decoding = "async";
    set src(_value: string) {
      queueMicrotask(() => {
        this.dispatchEvent(new Event("load"));
      });
    }
  }
  vi.stubGlobal("Image", ImmediateImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    callback?.(new Blob([Uint8Array.from([137])], { type: "image/png" }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("rasterizes an ordinary plugin icon transform", async () => {
  installRasterStubs();
  const png = await rasterizeSvg(svgBlob("translate(1 2) scale(1.5)"));
  expect(png?.type).toBe("image/png");
});

it("rasterizes a shipped icon rotation", async () => {
  installRasterStubs();
  const png = await rasterizeSvg(svgBlob("rotate(-10 8.6 11)"));
  expect(png?.type).toBe("image/png");
});

it("rejects a transform longer than the icon cap", async () => {
  const png = await rasterizeSvg(svgBlob("scale(1) ".repeat(40)));
  expect(png).toBeNull();
});

it("rejects an unclosed transform without stalling the page", async () => {
  const started = performance.now();
  const png = await rasterizeSvg(svgBlob(`scale(${"\t\t)scale(".repeat(30)}`));
  expect(png).toBeNull();
  expect(performance.now() - started).toBeLessThan(50);
});
