import { describe, expect, it } from "vitest";
import { parseTheme } from "./theme";

describe("parseTheme", () => {
  it("defaults to dark", () => {
    expect(parseTheme(null)).toBe("dark");
    expect(parseTheme("garbage")).toBe("dark");
  });
  it("honours a stored light choice", () => {
    expect(parseTheme("light")).toBe("light");
  });
});
