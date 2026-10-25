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
  it("lists the causes behind Keil's cancelled download, not just one", () => {
    // The message is identical whether a program holds the probe, the cable is
    // out, or the dongle is wedged. Naming only the first sent an agent
    // hunting for a process that did not exist (session 16c03283 follow-up).
    const hint = diagnoseFlashFailure("keil", "Error: Flash Download failed  -  Target DLL has been cancelled")!;
    expect(hint).toContain("another program holds the probe");
    expect(hint).toContain("probe itself is at fault");
    expect(hint).toContain("unplug and replug");
  });

  it("treats Cannot access target the same way", () => {
    expect(diagnoseFlashFailure("keil", "Cannot access target.")).toContain("debugger could not be opened");
  });

  it("does not blame a phantom process for a wedged dongle", () => {
    // Observed live: no OpenOCD/UV4 process existed, yet libusb reported
    // ACCESS and the dongle identified itself as 0000:0000.
    const access = diagnoseFlashFailure("openocd", "Error: libusb_open() failed with LIBUSB_ERROR_ACCESS")!;
    expect(access).toContain("wedged");
    expect(access).toContain("0000:0000");
    const unidentified = diagnoseFlashFailure(
      "openocd",
      ["Info : STLINK V0J8S0 (API v0) VID:PID 0000:0000", "Error: init mode failed"].join(String.fromCharCode(10)),
    )!;
    expect(unidentified).toContain("could not be identified");
  });

  it("distinguishes a missing debugger from a busy one", () => {
    const hint = diagnoseFlashFailure("keil", "No ULINK Device found");
    expect(hint).toContain("no debugger is attached");
    expect(hint).not.toContain("held by another program");
  });

  it("diagnoses OpenOCD's libusb access error as probe contention or a wedged dongle", () => {
    const hint = diagnoseFlashFailure("openocd", "Error: libusb_open() failed with LIBUSB_ERROR_ACCESS")!;
    expect(hint).toContain("libusb could not open the probe");
    // Both causes must be present: only the first one was true here.
    expect(hint).toMatch(/may hold it/);
    expect(hint).toContain("wedged");
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
