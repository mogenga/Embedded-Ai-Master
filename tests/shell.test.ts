import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isDangerousCommand, shellTool } from "../src/tools/shell.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const spawnMock = vi.mocked(childProcess.spawn);

const tempDirs: string[] = [];

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-shell-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(workdir: string): ToolCtx {
  return { sessionId: "test", cwd: workdir };
}

function nodeCommand(script: string): string {
  const executable = /\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath;
  return `${executable} -e "${script}"`;
}

function run(workdir: string, command: string, cwd?: string, signal?: AbortSignal) {
  const input = cwd === undefined ? { command } : { command, cwd };
  return shellTool.execute(input, makeCtx(workdir), signal ?? new AbortController().signal);
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter() });
  return child;
}

async function waitForPid(file: string, timeoutMs = 10000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = Number(readFileSync(file, "utf8"));
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      void 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`pid file not created: ${file}`);
}

async function waitForExit(pid: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} still running`);
}

afterEach(() => {
  spawnMock.mockReset();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("shellTool 元数据与 schema", () => {
  it("名称与注解", () => {
    expect(shellTool.name).toBe("shell");
    expect(shellTool.annotations).toEqual({ readOnly: false, destructive: true });
  });

  it.each([{}, { command: "" }, { command: "x", cwd: 1 }])("拒绝非法输入 %j", (input) => {
    expect(shellTool.schema.safeParse(input).success).toBe(false);
  });

  it("接受最小输入与可选 cwd", () => {
    expect(shellTool.schema.safeParse({ command: "x" }).success).toBe(true);
    expect(shellTool.schema.safeParse({ command: "x", cwd: "sub" }).success).toBe(true);
  });
});

describe("isDangerousCommand 正例", () => {
  it.each([
    "rm -rf /",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf ~/",
    "rm -rf $HOME",
    "rm -rf ${HOME}",
    "rm -rf ..",
    "rm -rf ../",
    "rm -rf ../..",
    "rm -rf ../*",
    "rm -rf ../../*",
    "rm -rf ~/..",
    "rm -rf $HOME/..",
    "rm -rf ${HOME}/..",
    "rm -rf /..",
    "rm -rf /.",
    "rm -rf /tmp/../*",
    "rm -rf C:",
    "rm -rf C:\\",
    "rm -rf C:\\*",
    "rm -rf C:\\*.*",
    "rm -rf C:/..",
    "rm -rf C:/*",
    "rm -rf C:\\..\\*",
    "rm -fr /",
    "rm -r -f /",
    "rm --recursive --force /",
    "rm -rf -- /",
    "rm -rf --one-file-system /",
    "sudo rm -rf /",
    "sudo -u root rm -rf /",
    "sudo -g wheel rm -rf ~",
    "sudo --user=root rm -rf /",
    "cd /tmp && rm -rf /",
    "cd / && rm -rf *",
    "cd / && rm -rf ./*",
    "cd ~ && rm -rf *",
    "cd $HOME && rm -rf *",
    "cd ${HOME} && rm -rf *",
    "cd .. && rm -rf *",
    "cd /tmp/.. && rm -rf *",
    "pushd / && rm -rf *",
    "cd C:\\ && del /s /q *",
    "cd C:\\ && rd /s /q *",
    "Set-Location C:\\ && del /s /q *",
    'rm -rf "/"',
    "rm -r ~",
    "rm -R ~",
    "rm --recursive ~",
    "rm -f /",
    "rm --force /",
    "rm -r ../*",
    "rm -f /*",
    "rm -f C:/",
    "rm -f C:\\",
    "cd / && rm -r *",
    "cd / && rm -f *",
    "cd / && rm -rf .",
    "cd / && rm -r .",
    "rm --no-preserve-root -rf /",
    "rm --no-preserve-root -r build",
    'rm -rf "/"*',
    'rm -rf "$HOME"/*',
    'rm -rf "$HOME"/',
    'rm -rf "~"/*',
    'del /s /q "C:\\"*',
    'cd "$HOME"/ && rm -rf *',
    '"rm" -rf /',
    "chdir / && rm -rf *",
    "pushd && rm -rf *",
    "mkfs /dev/sda",
    "mkfs.ext4 /dev/sda",
    "mkfs -t ext4 /dev/sda",
    "format C:",
    "format C:\\",
    "format X: /fs:NTFS",
    "diskpart",
    "diskpart /s script.txt",
    "shutdown -h now",
    "sudo shutdown -r now",
    "reboot",
    "poweroff",
    "halt",
    "dd if=/dev/zero of=/dev/sda",
    "dd if=/dev/zero of=/dev/sda bs=1M",
    ":(){ :|:& };:",
    "del /s /q C:\\",
    "del /s /q C:\\*.*",
    "del C:\\* /s /q",
    "rd /s /q C:\\",
    "rd /s /q D:\\*",
    "rmdir /s /q D:\\",
    "reg delete HKLM /f",
    "reg delete HKLM\\Software\\Foo /f",
    "bcdedit /set {default} safeboot minimal",
    "cipher /w",
    "cipher /w:C:\\",
    "echo safe; shutdown -h now",
  ])("识别 %s", (command) => {
    expect(isDangerousCommand(command)).toBe(true);
  });
});

describe("isDangerousCommand 反例", () => {
  it.each([
    "rm -rf ./build",
    "rm -rf build",
    "rm -r build",
    "rm -R ./build",
    "rm --recursive build",
    "rm -f build/*",
    "rm -r ../build",
    "rm -f C:/temp/*",
    "cd \"$HOME\"/build && rm -rf *",
    "chdir build && rm -rf *",
    "pushd build && rm -rf *",
    "cd build && rm -rf .",
    "rm -rf /tmp/build",
    "rm -rf ../build",
    "rm -rf ../../build",
    "rm -rf $HOME/build",
    "rm -rf C:/temp",
    "rm -rf C:/temp/*",
    "rm -rf *",
    "cd /tmp && rm -rf *",
    "cd build && rm -rf *",
    "cd ~/project && rm -rf *",
    "cd $HOME/build && rm -rf *",
    "pushd src && rm -rf *",
    "del /s /q *",
    "del /s /q *.txt",
    "cd /tmp && del /s /q *",
    "rm -rf $HOME/build",
    "rm -rf ${HOME}/build",
    "rm -rf C:\\temp",
    "rm file.txt",
    "rm -f file.txt",
    "npm test",
    "node -e \"console.log(42)\"",
    "git commit -m \"fix reboot\"",
    "echo shutdown",
    "grep halt README.md",
    "format document",
    "npm run format",
    "ls /",
    "cat /etc/hosts",
    "dd if=/dev/zero of=./disk.img",
    "reg query HKLM\\Software",
    "cipher /d secret.txt",
    "del /s /q build",
    "del /s /q C:\\Users\\me",
    "del /s /q *.txt",
    "rd /s /q build",
    "rd /s /q D:\\temp",
    "mkfslike /dev/sda",
    ";;;",
  ])("放行 %s", (command) => {
    expect(isDangerousCommand(command)).toBe(false);
  });
});

describe("shellTool 危险命令", () => {
  it.each([
    "rm -rf /",
    "mkfs.ext4 /dev/sda",
    "shutdown -h now",
    "dd if=x of=/dev/sda",
    "rm -rf $HOME",
    "rm -rf ..",
    "rm -rf C:\\",
    "rm -rf ../*",
    "rm -rf C:/*",
    "sudo -u root rm -rf /",
    "cd / && rm -rf *",
    "cd ~ && rm -rf *",
    "cd C:\\ && del /s /q *",
    "pushd / && rm -rf *",
    "del /s /q C:\\*.*",
    "format C:\\",
    "rd /s /q D:\\*",
    "rm -r ~",
    "rm -f /*",
    'rm -rf "/"*',
    'rm -rf "$HOME"/*',
    'del /s /q "C:\\"*',
    "chdir / && rm -rf *",
    "cd / && rm -rf .",
    "pushd && rm -rf *",
    "rm --no-preserve-root -r build",
  ])("不执行 %s", async (command) => {
    expect(isDangerousCommand(command)).toBe(true);
    const workdir = makeWorkdir();
    spawnMock.mockClear();

    const r = await run(workdir, command);

    expect(r.isError).toBe(true);
    expect(r.code).toBe("dangerous_command");
    expect(r.text).toContain("dangerous command blocked");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("message 与 text 中的命令截断到 200 字符", async () => {
    const command = `rm -rf / ${"x".repeat(500)}`;
    expect(isDangerousCommand(command)).toBe(true);
    const workdir = makeWorkdir();
    spawnMock.mockClear();

    const r = await run(workdir, command);

    expect(r.code).toBe("dangerous_command");
    expect(r.message.length).toBeLessThan(240);
    expect(r.message).not.toContain("x".repeat(300));
    expect(r.message.endsWith("...")).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("shellTool 执行", () => {
  it("正常命令返回 exit=0 与 stdout", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, nodeCommand("console.log(42)"));

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.detail).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: expect.stringContaining("42"),
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const detail = r.detail as { stdout: string; stderr: string; stdoutBytes: number; stderrBytes: number };
    expect(detail.stdoutBytes).toBe(Buffer.byteLength(detail.stdout, "utf8"));
    expect(detail.stderrBytes).toBe(0);
    expect(r.text).toContain("exit=0");
    expect(r.text).toContain("42");
  });

  it("非零退出码不算错误", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, nodeCommand("process.exit(3)"));

    expect(r.isError).toBe(false);
    expect((r.detail as { exitCode: number }).exitCode).toBe(3);
    expect(r.text).toContain("exit=3");
  });

  it("stderr 进入 text 与 detail", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, nodeCommand("console.error('boom')"));

    expect(r.isError).toBe(false);
    expect((r.detail as { stderr: string }).stderr).toContain("boom");
    expect(r.text).toContain("boom");
  });

  it("detail 只保留 4096 字符摘要，text 保留完整输出", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, nodeCommand("process.stdout.write('y'.repeat(10000))"));

    const detail = r.detail as { stdout: string; stdoutBytes: number };
    expect(r.isError).toBe(false);
    expect(detail.stdout).toHaveLength(4096);
    expect(detail.stdoutBytes).toBe(10000);
    expect(r.text).toContain("y".repeat(10000));
  });

  it("cwd 生效", async () => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "sub"));

    const r = await run(workdir, nodeCommand("console.log(process.cwd())"), "sub");

    const reported = (r.detail as { stdout: string }).stdout.trim();
    expect(r.isError).toBe(false);
    expect(realpathSync(reported)).toBe(realpathSync(path.join(workdir, "sub")));
  });

  it("cwd 越界 → cwd_invalid", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, nodeCommand("console.log(1)"), "../");

    expect(r.isError).toBe(true);
    expect(r.code).toBe("cwd_invalid");
  });

  it("cwd 不存在 → cwd_invalid", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, nodeCommand("console.log(1)"), "missing");

    expect(r.isError).toBe(true);
    expect(r.code).toBe("cwd_invalid");
  });

  it("cwd 是文件 → cwd_invalid", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "file.txt"), "x", "utf8");

    const r = await run(workdir, nodeCommand("console.log(1)"), "file.txt");

    expect(r.isError).toBe(true);
    expect(r.code).toBe("cwd_invalid");
  });

  it(
    "stdout 超过 1 MiB 截断并标记",
    async () => {
      const workdir = makeWorkdir();

      const r = await run(workdir, nodeCommand("process.stdout.write('x'.repeat(2000000))"));

      const detail = r.detail as { stdout: string; stdoutBytes: number; stdoutTruncated: boolean };
      expect(r.isError).toBe(false);
      expect(detail.stdoutTruncated).toBe(true);
      expect(detail.stdout).toHaveLength(4096);
      expect(detail.stdoutBytes).toBe(1024 * 1024);
      expect(r.text).toContain("stdout truncated");
    },
    20000,
  );

  it("命令不存在返回非零退出码而非 spawn_failed", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, "eam-command-that-does-not-exist");

    expect(r.isError).toBe(false);
    expect((r.detail as { exitCode: number }).exitCode).not.toBe(0);
  });

  it("spawn 同步抛错 → shell_spawn_failed", async () => {
    const workdir = makeWorkdir();
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });

    const r = await run(workdir, "echo hi");

    expect(r.isError).toBe(true);
    expect(r.code).toBe("shell_spawn_failed");
    expect(r.text).toContain("spawn boom");
  });

  it("已中止 signal → shell_aborted", async () => {
    const workdir = makeWorkdir();
    const controller = new AbortController();
    controller.abort();

    const r = await run(workdir, nodeCommand("setTimeout(() => {}, 1000)"), undefined, controller.signal);

    expect(r.isError).toBe(true);
    expect(r.code).toBe("shell_aborted");
  });

  it(
    "运行中 abort → shell_aborted 且子进程结束",
    async () => {
      const workdir = makeWorkdir();
      const pidFile = path.join(workdir, "pid.txt");
      const controller = new AbortController();
      const pending = run(
        workdir,
        nodeCommand(
          "require('node:fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => {}, 30000)",
        ),
        undefined,
        controller.signal,
      );
      let pid: number | undefined;
      try {
        pid = await waitForPid(pidFile);
        controller.abort();
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(r.code).toBe("shell_aborted");
        await waitForExit(pid);
      } finally {
        controller.abort();
        await pending;
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            void 0;
          }
        }
      }
    },
    25000,
  );

  it(
    "stderr 超过 1 MiB 截断并标记",
    async () => {
      const workdir = makeWorkdir();

      const r = await run(workdir, nodeCommand("process.stderr.write('e'.repeat(2000000))"));

      const detail = r.detail as { stderr: string; stderrBytes: number; stderrTruncated: boolean };
      expect(r.isError).toBe(false);
      expect(detail.stderrTruncated).toBe(true);
      expect(detail.stderr).toHaveLength(4096);
      expect(detail.stderrBytes).toBe(1024 * 1024);
      expect(r.text).toContain("stderr truncated");
    },
    20000,
  );

  it("异步 spawn error → shell_spawn_failed", async () => {
    const workdir = makeWorkdir();
    const child = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      process.nextTick(() => child.emit("error", new Error("async spawn boom")));
      return child;
    });

    const r = await run(workdir, "echo hi");

    expect(r.isError).toBe(true);
    expect(r.code).toBe("shell_spawn_failed");
    expect(r.text).toContain("async spawn boom");
  });

  it("被信号终止 → shell_terminated", async () => {
    const workdir = makeWorkdir();
    const child = fakeChild();
    spawnMock.mockImplementationOnce(() => {
      process.nextTick(() => child.emit("close", null, "SIGTERM"));
      return child;
    });

    const r = await run(workdir, "echo hi");

    expect(r.isError).toBe(true);
    expect(r.code).toBe("shell_terminated");
    expect(r.detail).toMatchObject({ exitCode: null, signal: "SIGTERM" });
    expect(r.message).toContain("SIGTERM");
    expect(r.text).toContain("SIGTERM");
  });

  it("stdout 截断落在多字节字符中间时按字符边界裁剪", async () => {
    const workdir = makeWorkdir();
    const child = fakeChild();
    const payload = Buffer.concat([Buffer.alloc(1024 * 1024 - 2, 0x61), Buffer.from("中", "utf8")]);
    spawnMock.mockImplementationOnce(() => {
      process.nextTick(() => {
        child.stdout?.emit("data", payload);
        child.emit("close", 0, null);
      });
      return child;
    });

    const r = await run(workdir, "echo hi");

    const detail = r.detail as { stdout: string; stdoutBytes: number; stdoutTruncated: boolean };
    expect(r.isError).toBe(false);
    expect(detail.stdoutTruncated).toBe(true);
    expect(detail.stdout).toHaveLength(4096);
    expect(detail.stdout).not.toContain("\uFFFD");
    expect(detail.stdoutBytes).toBe(1024 * 1024);
    expect(r.text).not.toContain("\uFFFD");
    expect(r.text).toContain("a".repeat(1024 * 1024 - 2));
    expect(r.text).toContain("[stdout truncated at 1 MiB]");
  });

  it("stdout 截断落在 4 字节字符中间时按字符边界裁剪", async () => {
    const workdir = makeWorkdir();
    const child = fakeChild();
    const payload = Buffer.concat([
      Buffer.alloc(1024 * 1024 - 3, 0x61),
      Buffer.from("😀", "utf8"),
    ]);
    spawnMock.mockImplementationOnce(() => {
      process.nextTick(() => {
        child.stdout?.emit("data", payload);
        child.emit("close", 0, null);
      });
      return child;
    });

    const r = await run(workdir, "echo hi");

    const detail = r.detail as { stdout: string; stdoutBytes: number; stdoutTruncated: boolean };
    expect(r.isError).toBe(false);
    expect(detail.stdoutTruncated).toBe(true);
    expect(detail.stdout).not.toContain("\uFFFD");
    expect(r.text).not.toContain("\uFFFD");
    expect(r.text).toContain("a".repeat(1024 * 1024 - 3));
    expect(r.text).toContain("[stdout truncated at 1 MiB]");
  });

  it("detail 摘要不切断代理对", async () => {
    const workdir = makeWorkdir();
    const child = fakeChild();
    const payload = Buffer.from(`a${"a".repeat(4094)}😀${"b".repeat(100)}`, "utf8");
    spawnMock.mockImplementationOnce(() => {
      process.nextTick(() => {
        child.stdout?.emit("data", payload);
        child.emit("close", 0, null);
      });
      return child;
    });

    const r = await run(workdir, "echo hi");

    const detail = r.detail as { stdout: string };
    expect(r.isError).toBe(false);
    expect(detail.stdout).toHaveLength(4095);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(detail.stdout)).toBe(false);
    expect(detail.stdout).not.toContain("\uFFFD");
  });

  it("spawn 同步抛 AbortError → shell_aborted", async () => {
    const workdir = makeWorkdir();
    spawnMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("spawn aborted"), { name: "AbortError" });
    });

    const r = await run(workdir, "echo hi");

    expect(r.isError).toBe(true);
    expect(r.code).toBe("shell_aborted");
    expect(r.text).toContain("spawn aborted");
  });
});