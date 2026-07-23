import { describe, expect, it } from "vitest";

import { passingTest } from "./fixtures";
import { renderMarkdown } from "./markdown";
import { REPORT_FORMATS, renderReport, reportExtension } from "./report";

describe("renderReport (format dispatch)", () => {
  it("advertises the supported formats", () => {
    expect(REPORT_FORMATS).toContain("md");
    expect(REPORT_FORMATS).toContain("html");
    expect(REPORT_FORMATS).toContain("junit");
    expect(REPORT_FORMATS).toContain("json");
    expect(REPORT_FORMATS).toContain("summary");
  });

  it("dispatches md to the markdown renderer", () => {
    expect(renderReport(passingTest, "md")).toBe(renderMarkdown(passingTest));
  });

  it("maps each format to a file extension", () => {
    expect(reportExtension("md")).toBe("md");
    expect(reportExtension("html")).toBe("html");
    expect(reportExtension("junit")).toBe("xml");
    expect(reportExtension("json")).toBe("json");
    expect(reportExtension("summary")).toBe("txt");
  });

  it("throws on an unknown format", () => {
    // @ts-expect-error — exercising the runtime guard with an invalid token.
    expect(() => renderReport(passingTest, "pdf")).toThrow();
  });
});
