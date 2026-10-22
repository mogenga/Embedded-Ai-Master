import { describe, it, expect } from "vitest";
import { resolveKeil, selectionFromEnv } from "../resolve.js";

const saved = {
  project: "G:\\proj\\USER\\TOUCH.uvprojx",
  targetName: "TOUCH",
  backend: "simulator" as const,
  port: 4825,
  projectPort: 4826,
};

it("an explicit argument wins over the Board pane's selection", () => {
  const resolved = resolveKeil({ project: "D:\\other\\APP.uvprojx", backend: "hardware", port: 4900 }, saved);
  expect(resolved.project).toBe("D:\\other\\APP.uvprojx");
  expect(resolved.backend).toBe("hardware");
  expect(resolved.debugPort).toBe(4900);
});

it("with no argument the selection is used, so the caller does not restate it", () => {
  const resolved = resolveKeil({}, saved);
  expect(resolved.project).toBe("G:\\proj\\USER\\TOUCH.uvprojx");
  expect(resolved.backend).toBe("simulator");
  expect(resolved.targetName).toBe("TOUCH");
  expect(resolved.debugPort).toBe(4825);
  expect(resolved.projectPort).toBe(4826);
});

it("with neither, the defaults are the documented ports", () => {
  const resolved = resolveKeil({}, undefined);
  expect(resolved.project).toBe(undefined);
  expect(resolved.backend).toBe("hardware");
  expect(resolved.debugPort).toBe(4823);
  expect(resolved.projectPort).toBe(4824);
});

it("target names the backend and target_name names the Keil target", () => {
  // The two used to be one field, which is how "hardware" reached UV4's `-t`.
  const resolved = resolveKeil({ target: "simulator", target_name: "Release" }, saved);
  expect(resolved.backend).toBe("simulator");
  expect(resolved.targetName).toBe("Release");
});

it("a connect-only session takes the project port, a debug session the debug port", () => {
  const debug = resolveKeil({}, saved, {});
  const project = resolveKeil({}, saved, { connectOnly: true });
  expect(debug.port).toBe(4825);
  expect(project.port).toBe(4826);
  expect(debug.debugPort).toBe(4825);
  expect(project.projectPort).toBe(4826);
});

it("an explicit port overrides both", () => {
  const resolved = resolveKeil({ port: 5000 }, saved, { connectOnly: true });
  expect(resolved.port).toBe(5000);
  expect(resolved.projectPort).toBe(5000);
});

it("the service-level selection comes from KEIL_SELECTION_JSON", () => {
  const env = { KEIL_SELECTION_JSON: JSON.stringify({ project: "G:\p\P.uvprojx", backend: "simulator", port: 4850 }) };
  const selection = selectionFromEnv(env);
  expect(selection?.backend).toBe("simulator");
  const resolved = resolveKeil({}, selection);
  expect(resolved.project).toBe("G:\p\P.uvprojx");
  expect(resolved.debugPort).toBe(4850);
  expect(resolved.projectPort).toBe(4824);
});

it("a malformed selection is ignored as a whole, not half-applied", () => {
  expect(selectionFromEnv({ KEIL_SELECTION_JSON: "{not json" })).toBe(undefined);
  expect(selectionFromEnv({ KEIL_SELECTION_JSON: JSON.stringify({ port: 80 }) })).toBe(undefined);
  expect(selectionFromEnv({})).toBe(undefined);
});
