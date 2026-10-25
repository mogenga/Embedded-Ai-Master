import { describe, expect, it } from "vitest";
import { classifyOutput, diagnoseFlashFailure } from "../flash.js";

/**
 * A flasher's raw failure line is accurate and useless: "Target DLL has been
 * cancelled" never says a second program holds the probe. An agent reading it
 * (session 16c03283) spent ten shell calls listing processes to guess, so the
 * adapter now names the cause. These tests pin the mapping — and equally the
 * cases that must NOT get a hint, because a wrong diagnosis is worse than none.
 */
describe("diagnoseFlashFailure", () => {
  it("names the probe conflict behind Keil's cancelled download", () => {
    const hint = diagnoseFlashFailure("keil", "Error: Flash Download failed  -  Target DLL has been cancelled");
    expect(hint).toContain("held by another program");
    expect(hint).toContain("retry");
  });

  it("treats Cannot access target the same way", () => {
    expect(diagnoseFlashFailure("keil", "Cannot access target.")).toContain("held by another program");
  });

  it("distinguishes a missing debugger from a busy one", () => {
    const hint = diagnoseFlashFailure("keil", "No ULINK Device found");
    expect(hint).toContain("no debugger is attached");
    expect(hint).not.toContain("held by another program");
  });

  it("diagnoses OpenOCD's libusb access error as probe contention", () => {
    expect(diagnoseFlashFailure("openocd", "Error: libusb_open() failed with LIBUSB_ERROR_ACCESS"))
      .toContain("another process holds the USB probe");
  });

  it("returns nothing for a successful download", () => {
    // "Flash Download failed" is a FAILURE marker, so a success log that
    // merely contains the word "flash" must not be diagnosed.
    expect(diagnoseFlashFailure("keil", "Flashed OK\nVerify OK")).toBeUndefined();
  });

  it("returns nothing for an unrecognized failure", () => {
    expect(diagnoseFlashFailure("keil", "some entirely new failure mode")).toBeUndefined();
  });

  it("agrees with classifyOutput on what counts as a failure", () => {
    const log = "Error: Flash Download failed  -  Target DLL has been cancelled";
    expect(classifyOutput("keil", log, 1).ok).toBe(false);
    expect(diagnoseFlashFailure("keil", log)).toBeDefined();
  });
});
