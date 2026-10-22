import { z } from "zod";

/**
 * Resolve what a Keil call should use, without the caller restating it.
 *
 * Explicit arguments win, then the selection the user made in the Board pane,
 * then the defaults. This is the same precedence `selectedBoard` applies to
 * `embed_flash`, and it exists for the same reason: fifty-odd actions that each
 * need the project path would otherwise make the model repeat it every turn.
 *
 * A 侧的 KeilSelection 来自全局 `Config.keil`；B 侧没有 Config，选择项来源改为
 * 每次调用的显式参数，其次服务级选中项（`KEIL_SELECTION_JSON`），最后默认值。
 */

export const keilSelectionSchema = z.object({
  project: z.string().optional(),
  backend: z.enum(["hardware", "simulator"]).optional(),
  targetName: z.string().optional(),
  // 默认端口 4823/4824 见下方 resolveKeil；schema 只校验范围。
  port: z.number().int().min(1024).max(65535).optional(),
  projectPort: z.number().int().min(1024).max(65535).optional(),
});

export type KeilSelection = z.infer<typeof keilSelectionSchema>;

/**
 * The service-level selection, from `KEIL_SELECTION_JSON`.
 *
 * Fail-closed: a malformed value is ignored as a whole rather than half-applied,
 * because a half-read selection would silently mix two projects' ports.
 */
export function selectionFromEnv(env: NodeJS.ProcessEnv = process.env): KeilSelection | undefined {
  const raw = env.KEIL_SELECTION_JSON;
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = keilSelectionSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

export interface ResolvedKeil {
  project?: string;
  backend: "hardware" | "simulator";
  /** The port a debug session uses. */
  debugPort: number;
  /** The port a plain project session uses. */
  projectPort: number;
  /** The port this call should use, given what kind of session it needs. */
  port: number;
  targetName?: string;
}

export function resolveKeil(
  input: Record<string, unknown>,
  keil: KeilSelection | undefined,
  options: { connectOnly?: boolean } = {},
): ResolvedKeil {
  const project = input.project ? String(input.project) : keil?.project;
  // `backend` chooses the simulator or the board; `targetName` chooses a
  // `<Target>` block. They used to share one field, which is why a multi-target
  // project could not be named and why `-t` received `hardware`.
  const explicitBackend = input.backend ?? input.target;
  const backend =
    explicitBackend === "hardware" || explicitBackend === "simulator"
      ? explicitBackend
      : keil?.backend ?? "hardware";
  const targetName = input.target_name ? String(input.target_name) : keil?.targetName;
  const explicitPort = input.port !== undefined ? Number(input.port) : undefined;
  const debugPort = explicitPort ?? keil?.port ?? 4823;
  const projectPort = explicitPort ?? keil?.projectPort ?? 4824;
  return {
    ...(project ? { project } : {}),
    backend,
    debugPort,
    projectPort,
    port: options.connectOnly ? projectPort : debugPort,
    ...(targetName ? { targetName } : {}),
  };
}