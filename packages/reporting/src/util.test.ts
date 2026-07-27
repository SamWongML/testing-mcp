import { describe, expect, it } from "vitest";

import { ms } from "./util";

describe("ms", () => {
  it("renders unknown timings as an em dash", () => {
    expect(ms(undefined)).toBe("—");
  });

  it("rounds the performance.now() noise out of a sub-millisecond timing", () => {
    // A real report rendered `0.9669160000048578ms` before this was rounded.
    expect(ms(0.9669160000048578)).toBe("1ms");
    expect(ms(4.561500000003434)).toBe("4.6ms");
  });

  it("renders whole milliseconds above 10ms", () => {
    expect(ms(265.4)).toBe("265ms");
    expect(ms(620)).toBe("620ms");
  });

  it("keeps zero meaningful", () => {
    expect(ms(0)).toBe("0ms");
  });
});
