import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  LOOK_BOOT_SCRIPT,
  LOOK_STORAGE_KEY,
  readLook,
  saveLook,
} from "@/lib/lookPreference";
import { FocusSunArc, sunPosition } from "@/components/FocusSunArc";

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe("look preference", () => {
  it("shows Neon when nothing is saved", () => {
    expect(readLook()).toBe("neon");
  });

  it("ignores a saved value that is not a look", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, "solarized");
    expect(readLook()).toBe("neon");
  });

  it("applies and remembers Dawn", () => {
    expect(saveLook("dawn")).toBe(true);
    expect(document.documentElement.dataset.theme).toBe("dawn");
    expect(readLook()).toBe("dawn");
  });

  it("still applies the look when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(saveLook("dawn")).toBe(false);
    expect(document.documentElement.dataset.theme).toBe("dawn");
  });

  it("falls back to Neon when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readLook()).toBe("neon");
  });

  it("boot script applies a saved look before React runs", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, "dawn");
    new Function(LOOK_BOOT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBe("dawn");
  });

  it("boot script leaves the page alone for an unknown value", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, "<img onerror=alert(1)>");
    new Function(LOOK_BOOT_SCRIPT)();
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });
});

describe("Focus sun arc", () => {
  it("rises on the left, peaks at half past, sets on the right", () => {
    const rise = sunPosition(0);
    const noon = sunPosition(0.5);
    const set = sunPosition(1);
    expect(rise.x).toBeLessThan(noon.x);
    expect(noon.x).toBeLessThan(set.x);
    expect(noon.y).toBeLessThan(rise.y);
    expect(rise.y).toBeCloseTo(set.y, 5);
  });

  it("names the minute and the hour for screen readers", () => {
    render(<FocusSunArc elapsedSeconds={3600 + 42 * 60 + 5} />);
    expect(screen.getByRole("img", { name: "Minute 42 of hour 2 on this task" })).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
    expect(screen.getByText("2h")).toBeInTheDocument();
  });

  it("labels the first hour from Start", () => {
    render(<FocusSunArc elapsedSeconds={10} />);
    expect(screen.getByText("Start")).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
  });
});
