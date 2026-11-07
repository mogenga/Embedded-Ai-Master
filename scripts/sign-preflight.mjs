#!/usr/bin/env node
/**
 * 签名前置检查：这台机器现在能不能签 Windows 安装包，能用哪张证书签，该传什么参数。
 *
 * **为什么需要它**：没有证书时 electron-builder 只打印一行
 * `no signing info identified, signing is skipped`（`DEBUG` 才看得到），构建照样退出 0、
 * 安装包照样产出——**签名被静默跳过，而日志里仍有 `signing with signtool.exe` 那行**
 * （见 `docs/operations/code-signing.md` §7）。令牌没插、证书过期、指纹填错，全都表现为「打包成功、
 * 产物未签名」，要等 SmartScreen 警告或自动更新报 `ERR_UPDATER_INVALID_SIGNATURE` 才发现。
 * 本脚本把这一步提前成一条命令：**先问「现在能签吗」，再打包**。
 *
 * **查的是同一件事**：electron-builder 26 用
 *
 *   Get-ChildItem -Recurse Cert: -CodeSigningCert |
 *     Select-Object -Property Subject,PSParentPath,Thumbprint | ConvertTo-Json -Compress
 *
 * 从证书存储里挑证书（`windowsSignToolManager.js` 的 `getCertificateFromStoreInfo`），
 * 再用 `certificateSubjectName`（`Subject.includes` 子串匹配）或 `certificateSha1`
 * （指纹逐字符比，忽略大小写）筛。这里跑**同一条查询**并多取两个字段
 * （`HasPrivateKey` / `NotAfter`）——多取的字段只用于判断「这张证书能不能真签」，
 * 不改变匹配规则，所以「本脚本说能签」与「electron-builder 会选中它」是同一件事。
 *
 * **不签任何东西、不写任何文件、不改配置**。它只读证书存储、读文件系统上有没有
 * `signtool.exe`，默认不触网（`--check-timestamp` 才探测时间戳服务器）。
 *
 * 用法：
 *   node scripts/sign-preflight.mjs
 *   node scripts/sign-preflight.mjs --subject "Your Name"      # 模拟 certificateSubjectName
 *   node scripts/sign-preflight.mjs --sha1 ABCD...             # 模拟 certificateSha1
 *   node scripts/sign-preflight.mjs --check-timestamp          # 额外探测时间戳服务器
 *   node scripts/sign-preflight.mjs --json                     # 机器可读输出
 *
 * 退出码：0 = 可以签（有可用证书）；1 = 不能签（没有证书 / 选不中 / 无私钥 / 已过期）；
 * 2 = 无法检查（不是 Windows、PowerShell 调用失败、参数错误）。
 *
 * 无依赖，只用 `node:*`。
 */

import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const USAGE = `用法: node scripts/sign-preflight.mjs [选项]

检查这台机器现在能不能给 Windows 安装包签名。

  --subject <名称>    按 certificateSubjectName 的规则（Subject 子串匹配）挑证书
  --sha1 <指纹>       按 certificateSha1 的规则（忽略大小写逐字符比）挑证书
  --check-timestamp   额外探测时间戳服务器可达性（默认不触网）
  --json              输出 JSON 而不是人类可读文本
  --help, -h          显示本帮助

退出码:
  0  可以签
  1  不能签（无证书 / 选不中 / 无私钥 / 已过期）
  2  无法检查（非 Windows / PowerShell 失败 / 参数错误）
`;

/** electron-builder 26 的原样查询，外加两个只读判断字段。 */
export const CERT_QUERY = [
    "Get-ChildItem -Recurse Cert: -CodeSigningCert -ErrorAction SilentlyContinue |",
    "Select-Object -Property Subject,PSParentPath,Thumbprint,HasPrivateKey,NotAfter |",
    "ConvertTo-Json -Compress",
].join(" ");

/** 与 electron-builder 的默认值一致（`signtoolOptions.rfc3161TimeStampServer`）。 */
export const DEFAULT_TIMESTAMP_SERVER = "http://timestamp.digicert.com";

/** 检查失败（非 Windows、PowerShell 出错、参数不对）都用它，靠 `exitCode` 区分。 */
export class SignPreflightError extends Error {
    constructor(message, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "SignPreflightError";
        /** 2 = 无法检查，1 = 内部误用。 */
        this.exitCode = options.exitCode ?? 2;
    }
}

/**
 * 把 `ConvertTo-Json` 的输出转成数组。
 *
 * PowerShell 对**单个**对象输出的是对象而不是长度 1 的数组（`ConvertTo-Json` 的老毛病），
 * 空结果是空串。三种形态都要接住，否则「本机只有一张证书」会被当成解析失败。
 */
export function normalizeCertList(raw) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text === "") return [];
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        throw new SignPreflightError(`证书查询输出不是合法 JSON: ${error.message}`, { cause: error });
    }
    if (parsed == null) return [];
    return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * 从完整 DN 里取 CN，规则与 electron-builder 写 `app-update.yml` 的 `publisherName` 一致
 * （`windowsSignToolManager.js` 用 `parseDn(...).get("CN")`）。
 *
 * 这里只处理 `CN=` 后到下一个 `,` 的一段（支持被引号包住、内部含逗号的形式）。
 * 取不到返回 `null`——那种证书 electron-builder 会在 `computedPublisherName` 那里拿到
 * `undefined`，写出的 `app-update.yml` 没有 `publisherName`，自动更新就不校验发布者（D-217）。
 */
export function extractCommonName(subject) {
    if (typeof subject !== "string") return null;
    const match = /(?:^|,)\s*CN=("(?:[^"]|"")*"|[^,]*)/i.exec(subject);
    if (match == null) return null;
    let value = match[1].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
        value = value.slice(1, -1).replace(/""/g, '"');
    }
    return value === "" ? null : value;
}

/** `PSParentPath` 的最后一段是存储名（`My` / `CA` / `Root` …），与 electron-builder 同款取法。 */
export function storeNameOf(parentPath) {
    if (typeof parentPath !== "string" || parentPath === "") return null;
    const index = parentPath.lastIndexOf("\\");
    return index === -1 ? parentPath : parentPath.slice(index + 1);
}

/** `PSParentPath` 里含 `Certificate::LocalMachine` ⇔ 机器存储，signtool 要加 `/sm`。 */
export function isLocalMachineStore(parentPath) {
    return typeof parentPath === "string" && parentPath.includes("Certificate::LocalMachine");
}

/**
 * 把 PowerShell 的一条记录整理成判断用的结构。
 *
 * `NotAfter` 在 JSON 里是 `/Date(...)/` 还是 ISO 字符串取决于 PowerShell 版本与序列化
 * 设置，两种都要认；认不出就当作「不知道」，不猜成过期或不过期。
 */
export function describeCert(record, now = Date.now()) {
    const subject = typeof record?.Subject === "string" ? record.Subject : "";
    const parentPath = typeof record?.PSParentPath === "string" ? record.PSParentPath : "";
    const thumbprint = typeof record?.Thumbprint === "string" ? record.Thumbprint.toUpperCase() : "";
    const notAfter = parsePowerShellDate(record?.NotAfter);
    return {
        subject,
        commonName: extractCommonName(subject),
        thumbprint,
        store: storeNameOf(parentPath),
        isLocalMachineStore: isLocalMachineStore(parentPath),
        hasPrivateKey: record?.HasPrivateKey === true,
        notAfter,
        expired: notAfter === null ? null : notAfter <= now,
    };
}

/** `"/Date(1761264000000)/"`、ISO 字符串、`Date` 对象三种形态统一成毫秒数；认不出返回 `null`。 */
export function parsePowerShellDate(value) {
    if (value == null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value !== "string") return null;
    const ms = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value.trim());
    if (ms != null) {
        const parsed = Number(ms[1]);
        return Number.isFinite(parsed) ? parsed : null;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 按 electron-builder 的匹配规则挑证书。
 *
 * `certificateSubjectName` 是 **`Subject.includes` 子串匹配**、`certificateSha1` 是
 * **忽略大小写的全等**（源码 `getCertificateFromStoreInfo`）。两者都不给时，
 * 只要存储里有代码签名证书，electron-builder 的 `cscInfo` 仍是 `null`——**它不会自动
 * 挑一张**，必须有 `certificateFile` / `certificateSubjectName` / `certificateSha1` /
 * `WIN_CSC_LINK` 四者之一。这是最容易误解的一点，所以这里单独返回 `noSelector`。
 *
 * @returns {{ kind: "selected", cert: object } | { kind: "no-selector", candidates: object[] }
 *          | { kind: "not-found", candidates: object[], wanted: string }
 *          | { kind: "ambiguous", candidates: object[], wanted: string }}
 */
export function selectSigningCert(certs, { subjectName, sha1 } = {}) {
    const candidates = Array.isArray(certs) ? certs : [];
    const wantSubject = typeof subjectName === "string" && subjectName !== "" ? subjectName : null;
    const wantSha1 = typeof sha1 === "string" && sha1 !== "" ? sha1.toUpperCase() : null;
    if (wantSubject === null && wantSha1 === null) {
        return { kind: "no-selector", candidates };
    }
    const matched = candidates.filter((cert) => {
        if (wantSubject !== null && !cert.subject.includes(wantSubject)) return false;
        if (wantSha1 !== null && cert.thumbprint !== wantSha1) return false;
        return true;
    });
    const wanted = wantSha1 !== null ? wantSha1 : wantSubject;
    if (matched.length === 0) return { kind: "not-found", candidates, wanted };
    if (matched.length > 1) return { kind: "ambiguous", candidates: matched, wanted };
    return { kind: "selected", cert: matched[0] };
}

/**
 * 判断「选中之后能不能真的签」。
 *
 * 三个都要满足：有私钥（没有私钥 signtool 会在 Private Key 过滤后剩 0 张）、未过期
 * （过期证书 signtool 默认拒绝）、选中的是存储里的证书（`certificateFile` 路径不经过这里）。
 */
export function assessCertificate(cert, now = Date.now()) {
    const problems = [];
    if (!cert.hasPrivateKey) {
        problems.push("证书没有私钥：签名需要令牌已插入并已解锁，或证书已带私钥导入");
    }
    if (cert.expired === true) {
        problems.push(`证书已过期（NotAfter ${new Date(cert.notAfter).toISOString()}）`);
    }
    if (cert.store !== "My") {
        problems.push(
            `证书在 ${cert.store ?? "未知"} 存储里：electron-builder 的 /s 参数会用它，但常规做法是装进 My（个人）存储`,
        );
    }
    return { ok: problems.length === 0, problems };
}

/**
 * 拼出可以不改仓库配置就签名的命令。
 *
 * **为什么用 `-c.win.signtoolOptions.…` 而不是写进 `desktop/package.json`**：证书主体因机器
 * 而异，写进仓库等于把「这台机器的证书」固化成项目配置（`docs/operations/code-signing.md` §3/§5）。
 * electron-builder 26 的 CLI 把点号路径合并进配置（`builder.js` 把 `--config.a.b=c` 解析成
 * 对象再 `deepAssign`），字符串字段可靠；**数组字段不行**——`signingHashAlgorithms` 用点号
 * 传会被 yargs 解析成字符串并以 `configuration.win should be a null` 报错，所以它留在
 * `package.json` 里，这里不碰。
 */
export function buildSigningCommand(cert) {
    const args = ["npm --prefix desktop run dist", "--", `-c.win.signtoolOptions.certificateSha1=${cert.thumbprint}`];
    return {
        // 用指纹而不是主体名：同名证书（续期后新旧并存）时 `Subject.includes` 会命中多张，
        // `getCertificateFromStoreInfo` 取第一张，未必是新的那张。
        signtoolOptions: { certificateSha1: cert.thumbprint, certificateSubjectName: cert.commonName },
        command: args.join(" "),
    };
}

/**
 * 探测时间戳服务器是否**可达**。
 *
 * 只说「主机/端口通不通」这一件事：真实的时间戳请求是带 TSA 请求体的 POST，
 * 用 GET 探测会拿到 404（DigiCert 就是这样），所以**任何 HTTP 响应都算可达**，
 * 只有连不上才算不可达。不要把这个结果读成「时间戳能打上」。
 *
 * @returns {Promise<{ url: string, reachable: boolean, detail: string }>}
 */
export async function probeTimestampServer(url, { timeoutMs = 10_000 } = {}) {
    const target = typeof url === "string" && url.trim() !== "" ? url.trim() : DEFAULT_TIMESTAMP_SERVER;
    let parsed;
    try {
        parsed = new URL(target);
    } catch (error) {
        return { url: target, reachable: false, detail: `URL 不合法: ${error.message}` };
    }
    const http = await import("node:http");
    const https = await import("node:https");
    const client = parsed.protocol === "https:" ? https : http;
    return await new Promise((resolve) => {
        const request = client.request(
            parsed,
            { method: "GET", timeout: timeoutMs, headers: { "user-agent": "eam-sign-preflight" } },
            (response) => {
                response.resume();
                resolve({
                    url: target,
                    reachable: true,
                    detail: `HTTP ${response.statusCode}（任何响应都算可达，探测不代表能签发时间戳）`,
                });
            },
        );
        request.on("timeout", () => {
            request.destroy();
            resolve({ url: target, reachable: false, detail: `${timeoutMs}ms 内无响应` });
        });
        request.on("error", (error) => {
            resolve({ url: target, reachable: false, detail: error.message });
        });
        request.end();
    });
}

/** 汇总成一段结论，供 CLI 打印。纯函数，方便测。 */
export function summarize({ certs, selection, assessment, signtool, timestamp = null }) {
    const lines = [];
    if (certs.length === 0) {
        lines.push("没有找到任何代码签名证书。");
        lines.push("");
        lines.push("electron-builder 会打印 no signing info identified, signing is skipped，");
        lines.push("构建退出 0、安装包照常产出，但产物未签名。");
        lines.push("");
        lines.push("下一步：插入令牌并等驱动装好，或把 .pfx 导入 Cert:\\CurrentUser\\My；");
        lines.push("或者改用 .pfx 文件路径（WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD），那条路不需要证书存储。");
        return { ok: false, lines };
    }
    lines.push(`找到 ${certs.length} 张代码签名证书：`);
    for (const cert of certs) {
        const expiry = cert.notAfter === null ? "有效期未知" : new Date(cert.notAfter).toISOString().slice(0, 10);
        const flags = [cert.store ?? "存储未知", cert.hasPrivateKey ? "有私钥" : "无私钥", expiry];
        lines.push(`  - ${cert.commonName ?? cert.subject}  [${flags.join(" / ")}]  ${cert.thumbprint}`);
    }
    lines.push("");

    if (selection.kind === "no-selector") {
        lines.push("但没有任何选择器指向它们。");
        lines.push("electron-builder 不会自动挑证书：必须给 certificateFile / certificateSubjectName /");
        lines.push("certificateSha1 / WIN_CSC_LINK 四者之一，否则 cscInfo = null、签名被跳过。");
        lines.push("");
        lines.push("下一步：用 --sha1 <指纹> 或 --subject <名称> 预演一次选择，然后按打印出的命令打包。");
        return { ok: false, lines };
    }
    if (selection.kind === "not-found") {
        lines.push(`选择器 "${selection.wanted}" 没有命中任何证书。`);
        lines.push("提示：certificateSubjectName 是 Subject 的子串匹配（大小写敏感），");
        lines.push("certificateSha1 是忽略大小写的全等匹配且不带空格。");
        return { ok: false, lines };
    }
    if (selection.kind === "ambiguous") {
        lines.push(`选择器 "${selection.wanted}" 命中 ${selection.candidates.length} 张证书，electron-builder 会取第一张。`);
        lines.push("同名证书（续期后新旧并存）时这不是你想要的行为——改用 --sha1 <指纹> 精确定位。");
        for (const cert of selection.candidates) {
            lines.push(`  - ${cert.thumbprint}  ${cert.notAfter === null ? "" : new Date(cert.notAfter).toISOString().slice(0, 10)}`);
        }
        return { ok: false, lines };
    }

    const cert = selection.cert;
    if (!assessment.ok) {
        lines.push(`选中：${cert.commonName ?? cert.subject}（${cert.thumbprint}）——不能签。`);
        for (const problem of assessment.problems) lines.push(`  - ${problem}`);
        return { ok: false, lines };
    }

    lines.push(`选中：${cert.commonName ?? cert.subject}（${cert.thumbprint}）——可以签。`);
    if (cert.commonName === null) {
        lines.push("警告：这张证书的 Subject 没有 CN，app-update.yml 将写不出 publisherName，");
        lines.push("      自动更新会跳过发布者校验（D-217）。这是 CA 证书构造问题，联系签发方。");
    }
    if (signtool.path === null) {
        lines.push("警告：没找到 signtool.exe。electron-builder 会去下 winCodeSign 工具链，弱网下会失败；");
        lines.push("      可以设 SIGNTOOL_PATH 指向本机 Windows Kits 里的一份。");
    } else {
        lines.push(`signtool：${signtool.path}${signtool.from === "env" ? "（来自 SIGNTOOL_PATH）" : ""}`);
    }
    lines.push("");
    lines.push("打包命令（不改仓库配置，证书主体不进版本库）：");
    lines.push(`  ${buildSigningCommand(cert).command}`);
    lines.push("");
    lines.push("打完后按 docs/operations/code-signing.md §9 第 4/5/6 步验证：verify-signature.mjs 退出 0、");
    lines.push("signtool verify /pa /v 通过且有时间戳、app-update.yml 的 publisherName 与 CN 一致。");
    if (timestamp !== null) {
        lines.push("");
        if (timestamp.reachable) {
            lines.push(`时间戳服务器 ${timestamp.url} 可达（${timestamp.detail}）。`);
        } else {
            lines.push(`时间戳服务器 ${timestamp.url} 不可达（${timestamp.detail}）。`);
            lines.push("签名本身仍会成功，但打不上时间戳——证书一过期，这份安装包的签名就失效了。");
        }
    }
    return { ok: true, lines, cert };
}

/** 参数解析，风格跟随 `scripts/corpus-stage.mjs`：未知参数立即报错、缺值不当成空串。 */
export function parseArgs(argv) {
    const options = { help: false, subjectName: null, sha1: null, checkTimestamp: false, json: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--help" || arg === "-h") return { ...options, help: true };
        if (arg === "--check-timestamp") {
            options.checkTimestamp = true;
            continue;
        }
        if (arg === "--json") {
            options.json = true;
            continue;
        }
        if (arg === "--subject" || arg === "--sha1") {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith("--")) {
                throw new SignPreflightError(`${arg} 缺少取值`, { exitCode: 2 });
            }
            if (arg === "--subject") options.subjectName = value;
            else options.sha1 = value;
            index += 1;
            continue;
        }
        throw new SignPreflightError(`未知参数 ${arg}`, { exitCode: 2 });
    }
    return options;
}

/** 5.1 自己的模块目录：`-CodeSigningCert` 这个动态参数住在这一版 Certificate provider 里。 */
export const WINDOWS_PS51_MODULES = "C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules";

/**
 * 判断一条 PowerShell 失败信息是不是「模块被解析到了别的 PowerShell 版本」。
 *
 * 特征：`-CodeSigningCert` 报 `NamedParameterNotFound`，或 `Certificate:` 驱动器不存在。
 * 根因是 `PSModulePath` 里排在前面的 PS7（`WindowsApps\Microsoft.PowerShell_*`）目录
 * 提供了另一版 `Microsoft.PowerShell.Security`，5.1 加载它之后就没有证书 provider。
 * 这与 `docs/operations/code-signing.md` §6 记录的 `Get-AuthenticodeSignature` 失败是同一个根因。
 */
export function looksLikeModulePathProblem(message) {
    if (typeof message !== "string") return false;
    return (
        /CodeSigningCert/i.test(message) && /NamedParameterNotFound|ParameterBindingException/i.test(message)
    ) || /Cannot find drive.*Certificate|找不到驱动器.*Certificate/i.test(message);
}

/**
 * 选 shell，规则与 electron-builder 的 `VmManager.powershellCommand` **完全一致**：
 *
 *   1. 先用 `powershell.exe` 跑 `Get-Command pwsh.exe`；
 *   2. 成功 → 用 `pwsh.exe`（PowerShell 7）；失败 → 回落到 `powershell.exe`（5.1）。
 *
 * 这个顺序不是细节：electron-builder 26 在**这台机器上**选中的是 `pwsh.exe`，因为
 * `where.exe pwsh` 能找到 WindowsApps 里的那一份。用 5.1 去查会得到不同的结果
 * （5.1 的 `-CodeSigningCert` 会被 PS7 的模块目录搅坏，见 `looksLikeModulePathProblem`），
 * 于是本脚本的结论与 electron-builder 的实际行为分叉——那正是它要防的故障。
 *
 * 不接受任何参数覆盖：**故意跑与 electron-builder 同一条路径**，不是跑一条「更干净」的路。
 */
export async function resolvePowershell({ platform = process.platform, env = process.env } = {}) {
    if (platform !== "win32") {
        throw new SignPreflightError(`本脚本只支持 Windows（当前 ${platform}）`);
    }
    const legacy = path.join(
        env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );
    try {
        await execFileAsync(legacy, ["-NoProfile", "-NonInteractive", "-Command", "Get-Command pwsh.exe"], {
            windowsHide: true,
            env,
        });
        return { path: "pwsh.exe", kind: "pwsh" };
    } catch (error) {
        const message = `${error.stderr ?? ""}${error.message ?? ""}`;
        if (looksLikeModulePathProblem(message)) {
            throw new SignPreflightError(
                [
                    "PowerShell 5.1 加载了不匹配的 Microsoft.PowerShell.Security，连探测 pwsh 都跑不了：",
                    message.split("\n").slice(0, 3).join(" "),
                    "",
                    "electron-builder 走的是同一条路，它也会失败。修法见 docs/operations/code-signing.md §6：",
                    `把 ${WINDOWS_PS51_MODULES} 放到 PSModulePath 最前面再打包。`,
                ].join("\n"),
            );
        }
        return { path: legacy, kind: "windows-powershell" };
    }
}

/**
 * 跑那条查询，拿到原始 JSON 文本。
 *
 * 与 electron-builder 用同一个 shell、同一条命令、同一份环境变量（`vm.powershellCommand`
 * + `vm.exec` 默认继承 `process.env`）。不做任何净化，也不接受覆盖：**它要回答的
 * 就是「electron-builder 现在跑这条命令会看到什么」**，换一条更干净的路就等于换了个问题。
 * 查得到证书却说不出结果的场景，宁可让它一起失败——那样用户才知道要去修环境。
 *
 * @returns {Promise<{ stdout: string, shell: string }>}
 */
export async function queryCertificates({ platform = process.platform, env = process.env } = {}) {
    const shell = await resolvePowershell({ platform, env });
    try {
        const { stdout } = await execFileAsync(
            shell.path,
            ["-NoProfile", "-NonInteractive", "-Command", CERT_QUERY],
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024, env },
        );
        return { stdout, shell: shell.kind };
    } catch (error) {
        const message = `${error.stderr ?? ""}${error.message ?? ""}`;
        const hint = looksLikeModulePathProblem(message)
            ? `\n（PSModulePath 里的 PowerShell 7 目录让 5.1 加载了不匹配的模块；修法见 docs/operations/code-signing.md §6）`
            : "";
        throw new SignPreflightError(`用 ${shell.path} 查询证书失败: ${error.message}${hint}`, {
            cause: error,
        });
    }
}

/**
 * 找 signtool.exe：`SIGNTOOL_PATH`（electron-builder 的第一优先级）→ Windows Kits 最新版。
 *
 * 不查 electron-builder 的 winCodeSign 缓存：那是下载产物，不存在时 electron-builder 会
 * 自己去下；这里只回答「本机有没有现成可用的」。找不到就返回 `path: null`，不报错。
 */
export async function findSigntool({ platform = process.platform } = {}) {
    const fromEnv = process.env.SIGNTOOL_PATH;
    if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        try {
            await access(fromEnv, constants.X_OK);
            return { path: fromEnv, from: "env" };
        } catch {
            return { path: null, from: "env-missing", tried: fromEnv };
        }
    }
    if (platform !== "win32") return { path: null, from: "unsupported" };
    const kitsRoot = path.join(
        process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
        "Windows Kits",
        "10",
        "bin",
    );
    let versions = [];
    try {
        const { readdir } = await import("node:fs/promises");
        versions = await readdir(kitsRoot, { withFileTypes: true });
    } catch {
        return { path: null, from: "kits-missing", tried: kitsRoot };
    }
    const names = versions
        .filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+\.\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => compareVersion(b, a));
    for (const name of names) {
        const candidate = path.join(kitsRoot, name, "x64", "signtool.exe");
        try {
            await access(candidate, constants.X_OK);
            return { path: candidate, from: "kits" };
        } catch {
            // 继续找更旧的版本
        }
    }
    return { path: null, from: "kits-no-signtool", tried: kitsRoot };
}

function compareVersion(a, b) {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
        const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(USAGE);
        return 0;
    }
    const raw = await queryCertificates();
    const certs = normalizeCertList(raw.stdout).map((record) => describeCert(record));
    const selection = selectSigningCert(certs, { subjectName: options.subjectName, sha1: options.sha1 });
    const assessment = selection.kind === "selected" ? assessCertificate(selection.cert) : { ok: false, problems: [] };
    const signtool = await findSigntool();
    const timestamp = options.checkTimestamp ? await probeTimestampServer(DEFAULT_TIMESTAMP_SERVER) : null;
    const summary = summarize({ certs, selection, assessment, signtool, timestamp });

    if (options.json) {
        console.log(
            JSON.stringify(
                {
                    platform: process.platform,
                    shell: raw.shell,
                    certificates: certs,
                    selection: { kind: selection.kind },
                    assessment,
                    signtool,
                    canSign: summary.ok,
                },
                null,
                2,
            ),
        );
    } else {
        console.log(summary.lines.join("\n"));
    }
    return summary.ok ? 0 : 1;
}

// 只有被当成脚本直接运行时才进 main()。测试 import 本模块拿纯函数，
// 不应触发 PowerShell 调用（测试不触网、不依赖 Windows）。
const invokedPath = process.argv[1] === undefined ? "" : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== "" && import.meta.url === invokedPath) {
    try {
        process.exitCode = await main();
    } catch (error) {
        console.error(`sign preflight: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = error instanceof SignPreflightError ? error.exitCode : 2;
    }
}
