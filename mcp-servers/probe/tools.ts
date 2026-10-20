import { z } from "zod";
import { ProbeBackendError } from "./backend.js";
import type {
  DeviceStatus,
  ProbeBackend,
  ProbeBackendKind,
  ProbeErrorCode,
} from "./backend.js";

export interface ProbeToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface ProbeToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface ProbeToolSpec {
  name: string;
  description: string;
  inputSchema?: z.ZodTypeAny;
  annotations?: ProbeToolAnnotations;
  meta?: Record<string, unknown>;
  handler: (args: unknown) => Promise<ProbeToolResult>;
}

export interface ProbeBackends {
  renode: ProbeBackend;
  openocd?: ProbeBackend;
}

const EMPTY_STATUS: DeviceStatus = {
  backend: "none",
  probe: "detached",
  cpu: "unknown",
  serial: "closed",
};

const MAX_ADDRESS = 0xffff_ffff;
const MAX_MEMORY_LENGTH = 256;

const attachSchema = z.object({
  backend: z.enum(["renode", "openocd"]).optional(),
  platform: z.string().min(1).optional(),
  monitorPort: z.number().int().min(1).max(65535).optional(),
});

const memReadSchema = z.object({
  address: z.number().int().min(0).max(MAX_ADDRESS),
  length: z.number().int().min(1).max(MAX_MEMORY_LENGTH),
});

const memWriteSchema = z.object({
  address: z.number().int().min(0).max(MAX_ADDRESS),
  bytes: z.array(z.number().int().min(0).max(255)).min(1).max(MAX_MEMORY_LENGTH),
});

const serialOpenSchema = z.object({
  host: z.string().min(1).optional().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535),
});

const serialReadSchema = z.object({
  maxBytes: z.number().int().min(1).max(65536).default(256),
  timeoutMs: z.number().int().min(0).max(600_000).default(1000),
});

const serialWriteSchema = z.object({
  data: z.string().min(1),
});

function ok(structuredContent: unknown): ProbeToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function fail(code: ProbeErrorCode, message: string): ProbeToolResult {
  const structuredContent = { code, message };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function toFailure(error: unknown): ProbeToolResult {
  if (error instanceof ProbeBackendError) {
    return fail(error.code, error.message);
  }
  return fail("backend_error", errorMessage(error));
}

function invalidArgument(detail: string): ProbeToolResult {
  return fail("invalid_argument", detail);
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
    .join("; ");
}

function withSchema<T>(
  schema: z.ZodType<T>,
  run: (args: T) => Promise<ProbeToolResult>,
): (args: unknown) => Promise<ProbeToolResult> {
  return async (args: unknown): Promise<ProbeToolResult> => {
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) return invalidArgument(formatIssues(parsed.error));
    try {
      return await run(parsed.data);
    } catch (error) {
      return toFailure(error);
    }
  };
}

export function probeTools(backends: ProbeBackends): ProbeToolSpec[] {
  let active: ProbeBackend | undefined;

  const requireActive = (): ProbeBackend => {
    if (!active) {
      throw new ProbeBackendError("not_attached", "设备尚未 attach");
    }
    return active;
  };

  const deviceStatus = (): DeviceStatus => active?.status() ?? EMPTY_STATUS;

  const selectBackend = (kind: ProbeBackendKind): ProbeBackend => {
    const backend = kind === "openocd" ? backends.openocd : backends.renode;
    if (!backend) {
      throw new ProbeBackendError("backend_unavailable", `未配置 ${kind} backend`);
    }
    return backend;
  };

  return [
    {
      name: "device_list",
      description: "列出可用的探针后端及是否已配置",
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          return ok({
            backends: [
              { kind: "renode", available: true },
              { kind: "openocd", available: backends.openocd !== undefined },
            ],
          });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
    {
      name: "device_status",
      description: "查看当前探针、CPU 与串口状态",
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          return ok({ deviceStatus: deviceStatus() });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
    {
      name: "attach",
      description: "连接探针后端并准备目标设备",
      inputSchema: attachSchema,
      annotations: { readOnlyHint: true },
      handler: withSchema(attachSchema, async (args) => {
        const kind = args.backend ?? "renode";
        const backend = selectBackend(kind);
        if (active && active !== backend) {
          await active.detach();
          active = undefined;
        }
        const status = await backend.attach({
          backend: kind,
          platform: args.platform,
          monitorPort: args.monitorPort,
        });
        active = backend;
        return ok({ deviceStatus: status });
      }),
    },
    {
      name: "detach",
      description: "断开探针后端",
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          if (active) {
            await active.detach();
            active = undefined;
          }
          return ok({ deviceStatus: deviceStatus() });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
    {
      name: "halt",
      description: "暂停目标 CPU",
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          await requireActive().halt();
          return ok({ deviceStatus: deviceStatus() });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
    {
      name: "resume",
      description: "恢复目标 CPU 运行",
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          await requireActive().resume();
          return ok({ deviceStatus: deviceStatus() });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
    {
      name: "reset",
      description: "复位目标 CPU 与外设，返回操作声明",
      annotations: { destructiveHint: true },
      handler: async () => {
        try {
          const result = await requireActive().reset();
          return ok({ declaration: result.declaration, deviceStatus: deviceStatus() });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
    {
      name: "mem_read",
      description: "读取目标内存；全 0 只作为警告，不推断无故障",
      inputSchema: memReadSchema,
      annotations: { readOnlyHint: true },
      meta: { evidence: true },
      handler: withSchema(memReadSchema, async (args) => {
        const memory = await requireActive().readMemory(args.address, args.length);
        return ok({ memory, deviceStatus: deviceStatus() });
      }),
    },
    {
      name: "mem_write",
      description: "写入目标内存并回读校验，返回操作声明",
      inputSchema: memWriteSchema,
      annotations: { destructiveHint: true },
      handler: withSchema(memWriteSchema, async (args) => {
        const result = await requireActive().writeMemory(args.address, args.bytes);
        return ok({
          declaration: result.declaration,
          verified: result.verified,
          deviceStatus: deviceStatus(),
        });
      }),
    },
    {
      name: "serial_open",
      description: "打开目标串口通道",
      inputSchema: serialOpenSchema,
      annotations: { readOnlyHint: true },
      handler: withSchema(serialOpenSchema, async (args) => {
        const serialStatus = await requireActive().serialOpen(args.host, args.port);
        return ok({ serialStatus, deviceStatus: deviceStatus() });
      }),
    },
    {
      name: "serial_status",
      description: "查看串口通道状态",
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          return ok({ serialStatus: requireActive().serialStatus() });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
    {
      name: "serial_read",
      description: "读取串口数据；超时显式返回 timedOut",
      inputSchema: serialReadSchema,
      annotations: { readOnlyHint: true },
      meta: { evidence: true },
      handler: withSchema(serialReadSchema, async (args) => {
        const data = await requireActive().serialRead(args.maxBytes, args.timeoutMs);
        return ok({ data, deviceStatus: deviceStatus() });
      }),
    },
    {
      name: "serial_write",
      description: "向串口写入数据，返回操作声明",
      inputSchema: serialWriteSchema,
      annotations: { destructiveHint: true },
      handler: withSchema(serialWriteSchema, async (args) => {
        const result = await requireActive().serialWrite(Buffer.from(args.data, "utf8"));
        return ok({ declaration: result.declaration, bytesWritten: result.bytesWritten });
      }),
    },
    {
      name: "serial_close",
      description: "关闭串口通道",
      annotations: { readOnlyHint: true },
      handler: async () => {
        try {
          const serialStatus = await requireActive().serialClose();
          return ok({ serialStatus, deviceStatus: deviceStatus() });
        } catch (error) {
          return toFailure(error);
        }
      },
    },
  ];
}