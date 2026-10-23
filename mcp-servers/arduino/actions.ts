import { z } from "zod";

/**
 * `arduino_build` 的 action 面。Arduino 路线没有调试动作：
 * 实测 `arduino-cli debug check -b arduino:avr:uno` = 不支持（AVR 无调试
 * 硬件），诚实不做，而不是做一个假调试面。SAMD/ESP32 核心装了以后这里
 * 也不加——那是另一条 gdb 链路，按需再评估。
 */

export const ARDUINO_ACTIONS = [
  "info",
  "boards",          // 已装核心与板卡（core list）
  "search_board",    // board listall 过滤
  "libs",            // 已装库列表
  "compile",         // 编译 sketch
  "upload",          // 烧录（avrdude 等）
  "version",
  "capabilities",
] as const;

export type ArduinoAction = (typeof ARDUINO_ACTIONS)[number];

export const ARDUINO_EVIDENCE_ACTIONS: ReadonlySet<string> = new Set([
  "info", "boards", "search_board", "libs", "version", "capabilities", "compile",
]);

export const ARDUINO_DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  "upload",
]);

export const arduinoInputSchema = z
  .object({
    action: z.enum(ARDUINO_ACTIONS),
    /** sketch 目录（含与目录同名的 .ino）或其父目录。 */
    project: z.string().optional(),
    /** FQBN，如 arduino:avr:uno。 */
    fqbn: z.string().optional(),
    port: z.string().optional(),
    /** 上传后校验（默认开）。 */
    verify: z.boolean().optional(),
    /** search_board / libs 的过滤词。 */
    query: z.string().optional(),
  })
  .strict();

export const DESCRIPTION =
  "Build and upload Arduino sketches with the machine's own Arduino CLI (bundled with the Arduino IDE if installed): compile a sketch directory (the folder whose name matches its .ino) for a fully-qualified board name like arduino:avr:uno, and upload to a serial port with verification. No debug actions: AVR boards have no debug hardware (`arduino-cli debug check` reports unsupported), and this tool does not pretend otherwise. Board/package discovery is live (`boards` lists installed cores) — installing a new core via `arduino-cli core install` immediately widens what this can compile.";
