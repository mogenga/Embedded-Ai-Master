import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_COMMAND_NAMES,
  SKILL_NAME_PATTERN,
  SkillStoreError,
  readSkills,
  removeSkill,
  writeSkill,
} from "../src/skills/store.js";
import type { SkillRoots, WriteSkillInput } from "../src/skills/store.js";

const dirs: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeRoots(): {
  roots: SkillRoots;
  home: string;
  workdir: string;
  agentsHome: string;
} {
  const home = makeDir("eam-skills-home-");
  const workdir = makeDir("eam-skills-work-");
  // `agentsHome` 必须显式给：不给的话 store 在测试进程里直接抛错（D-170
  // 同一条规则），否则会读到跑测试那个人的真实 `~/.agents`。
  const agentsHome = makeDir("eam-skills-agents-");
  return { roots: { home, workdir, agentsHome }, home, workdir, agentsHome };
}

function userDir(home: string): string {
  return path.join(home, "skills");
}

function projectDir(workdir: string): string {
  return path.join(workdir, ".harness", "skills");
}

function writeSkillFile(dir: string, fileName: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  writeFileSync(file, text, "utf8");
  return file;
}

async function expectSkillError(run: () => Promise<unknown>, code: string): Promise<SkillStoreError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SkillStoreError);
  const skillError = caught as SkillStoreError;
  expect(skillError.code).toBe(code);
  // 报错必须带原因（R3），不能只说「无效」。
  expect(skillError.message.length).toBeGreaterThan(0);
  return skillError;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readSkills 的目录语义", () => {
  it("技能目录不存在时是零个技能，不是错误", () => {
    const { roots } = makeRoots();

    expect(readSkills(roots)).toEqual({ skills: [], problems: [] });
  });

  it("没有 workdir 时项目作用域直接缺席", () => {
    const { home, agentsHome } = makeRoots();
    writeSkillFile(userDir(home), "only-user.md", "用户级正文\n");

    const result = readSkills({ home, agentsHome });

    expect(result.skills.map((skill) => skill.name)).toEqual(["only-user"]);
    expect(result.problems).toEqual([]);
  });

  it("按名称稳定排序", () => {
    const { roots, home } = makeRoots();
    for (const name of ["zebra", "alpha", "middle"]) {
      writeSkillFile(userDir(home), `${name}.md`, `---\ndescription: ${name}\n---\n正文\n`);
    }

    expect(readSkills(roots).skills.map((skill) => skill.name)).toEqual(["alpha", "middle", "zebra"]);
  });

  it("目录式技能（<name>/SKILL.md）与平铺文件一样能读", () => {
    // `~/.agents/skills` 由 skill CLI 管理，每个技能是一个目录，入口固定为
    // SKILL.md，旁边还有 scripts/、references/。只认平铺文件会让那一整批
    // 技能读不到，而且一个 problem 都不报——目录被当成「不是文件」静默跳过。
    const { roots, home } = makeRoots();
    const dir = path.join(userDir(home), "from-cli");
    mkdirSync(path.join(dir, "references"), { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      "---\ndescription: 从 CLI 装的\nargument-hint: '[path]'\n---\n正文第一行\n",
      "utf8",
    );
    // 旁边的文件不是技能入口，不能被拼进正文。
    writeFileSync(path.join(dir, "references", "notes.md"), "不该出现在正文里\n", "utf8");

    const skill = readSkills(roots).skills.find((entry) => entry.name === "from-cli");

    expect(skill).toMatchObject({
      name: "from-cli",
      description: "从 CLI 装的",
      argumentHint: "[path]",
      scope: "user",
    });
    expect(skill?.body).toBe("正文第一行");
    expect(skill?.body).not.toContain("不该出现在正文里");
  });

  it("目录里没有 SKILL.md 是 problem，不是静默跳过", () => {
    const { roots, home } = makeRoots();
    mkdirSync(path.join(userDir(home), "looks-like-skill"), { recursive: true });
    writeFileSync(path.join(userDir(home), "looks-like-skill", "README.md"), "x\n", "utf8");

    const result = readSkills(roots);

    expect(result.skills).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file).toContain("looks-like-skill");
    expect(result.problems[0]?.message).toContain("SKILL.md");
  });

  it("平铺文件与同名目录同时存在时，平铺文件优先并报出另一个", () => {
    // 两种布局都合法的根里，同名是真实的歧义：说清楚哪一份被用了，
    // 而不是让其中一份默默消失。
    const { roots, home } = makeRoots();
    writeSkillFile(userDir(home), "dup.md", "---\ndescription: 平铺\n---\n平铺正文\n");
    mkdirSync(path.join(userDir(home), "dup"), { recursive: true });
    writeFileSync(path.join(userDir(home), "dup", "SKILL.md"), "---\ndescription: 目录\n---\n目录正文\n", "utf8");

    const result = readSkills(roots);
    const dup = result.skills.filter((skill) => skill.name === "dup");

    expect(dup).toHaveLength(1);
    expect(dup[0]?.description).toBe("平铺");
    expect(result.problems.some((problem) => problem.message.includes("同名"))).toBe(true);
  });
});

describe("frontmatter 解析", () => {
  it("没有 frontmatter 时整份文件就是正文", () => {
    const { roots, home } = makeRoots();
    writeSkillFile(userDir(home), "plain.md", "只做只读诊断，不做任何写操作。\n");

    expect(readSkills(roots).skills).toEqual([
      {
        name: "plain",
        description: "",
        argumentHint: "",
        scope: "user",
        body: "只做只读诊断，不做任何写操作。",
      },
    ]);
  });

  it("单引号与双引号包裹的值都会剥掉一对引号", () => {
    const { roots, home } = makeRoots();
    writeSkillFile(
      userDir(home),
      "quoted.md",
      '---\ndescription: "范围: 全部"\nargument-hint: \'[path]\'\n---\n正文\n',
    );

    const skill = readSkills(roots).skills[0];
    expect(skill?.description).toBe("范围: 全部");
    expect(skill?.argumentHint).toBe("[path]");
  });

  it("折叠块（`>`）与字面块（`|`）的值会被拼成一行/保留换行", () => {
    // `~/.agents/skills` 里 CLI 装的技能确实这么写（`description: >` 然后缩进
    // 若干行）。只按「冒号后取到行尾」解析会得到一个字面量 `>`，描述栏就会
    // 显示一个大于号——读不出值却装作读到了，比读失败更糟。
    const { roots, home } = makeRoots();
    writeSkillFile(
      userDir(home),
      "folded.md",
      "---\ndescription: >\n  第一行\n  第二行\nargument-hint: '[x]'\n---\n正文\n",
    );
    writeSkillFile(
      userDir(home),
      "literal.md",
      "---\ndescription: |\n  第一行\n  第二行\n---\n正文\n",
    );

    const byName = Object.fromEntries(readSkills(roots).skills.map((s) => [s.name, s]));
    // 折叠：换行变空格（YAML 的 `>` 语义）。
    expect(byName.folded?.description).toBe("第一行 第二行");
    expect(byName.folded?.argumentHint).toBe("[x]");
    // 字面块保留换行（`|` 语义）。
    expect(byName.literal?.description).toBe("第一行\n第二行");
  });

  it("未知键是额外元数据，不是故障", () => {
    const { roots, home } = makeRoots();
    writeSkillFile(
      userDir(home),
      "meta.md",
      "---\ndescription: 带元数据\nmodel: gpt-x\nallowed-tools: [read]\n---\n正文\n",
    );

    const result = readSkills(roots);
    expect(result.problems).toEqual([]);
    expect(result.skills[0]).toMatchObject({ name: "meta", description: "带元数据", body: "正文" });
  });

  it("单个文件用不了时进 problems，其余技能照常返回", () => {
    const { roots, home } = makeRoots();
    writeSkillFile(userDir(home), "fine.md", "正文\n");
    // 断链符号链接：文件项存在，但目标不存在。无论目标在不在，符号链接本身
    // 都不该被跟随，所以它在这里是一个「用不了的文件」的样本。
    const broken = path.join(userDir(home), "broken.md");
    symlinkSync(path.join(home, "nowhere.md"), broken);

    const result = readSkills(roots);

    expect(result.skills.map((skill) => skill.name)).toEqual(["fine"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file).toBe(broken);
    expect(result.problems[0]?.message).toContain("符号链接");
  });

  it("指向根目录之外的符号链接不会被当成技能读出来", () => {
    // 项目技能住在 `.harness/skills/`，那是**别人的仓库**能提交的内容。一个
    // `.md` 链接若指向技能根之外的任意文件，跟随它就会把那个文件的内容当成
    // 提示词正文，随下一次 `/名称` 发送给模型。与 `listDirectory` /
    // `listSessionArtifacts` 同一条规则：符号链接不跟随。
    const { roots, home, workdir } = makeRoots();
    const secret = path.join(workdir, "outside.md");
    writeFileSync(secret, "不该被读到的内容\n", "utf8");
    mkdirSync(projectDir(workdir), { recursive: true });
    const link = path.join(projectDir(workdir), "sneaky.md");
    symlinkSync(secret, link);
    writeSkillFile(userDir(home), "fine.md", "正文\n");

    const result = readSkills(roots);

    expect(result.skills.map((skill) => skill.name)).toEqual(["fine"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file).toBe(link);
    // 「没读」必须说成没读。悄悄跳过会让用户以为那个技能不存在，
    // 而内容其实已被链接指向某处。
    expect(result.problems[0]?.message).toContain("符号链接");
  });

  it("frontmatter 未闭合是 problem，且不影响同目录其它技能", () => {
    const { roots, home } = makeRoots();
    const broken = writeSkillFile(userDir(home), "broken.md", "---\ndescription: 坏文件\n正文\n");
    writeSkillFile(userDir(home), "good.md", "---\ndescription: 好的\n---\n正文\n");

    const result = readSkills(roots);

    expect(result.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file).toBe(broken);
    expect(result.problems[0]?.message).toContain("frontmatter");
  });
});

describe("名称约束", () => {
  it("文件名主干非法的技能报 problem 并跳过", () => {
    const { roots, home } = makeRoots();
    writeSkillFile(userDir(home), "ok.md", "正文\n");
    writeSkillFile(userDir(home), "Upper.md", "正文\n");
    writeSkillFile(userDir(home), "has space.md", "正文\n");
    writeSkillFile(userDir(home), "con.md", "正文\n");

    const result = readSkills(roots);

    expect(result.skills.map((skill) => skill.name)).toEqual(["ok"]);
    expect(result.problems.map((problem) => path.basename(problem.file))).toEqual([
      "Upper.md",
      "con.md",
      "has space.md",
    ].sort());
  });

  it("与内置命令同名的技能永远无法被调用，报 problem 并跳过", () => {
    const { roots, home } = makeRoots();
    for (const name of BUILTIN_COMMAND_NAMES) {
      writeSkillFile(userDir(home), `${name}.md`, "正文\n");
    }

    const result = readSkills(roots);

    expect(BUILTIN_COMMAND_NAMES).toEqual(["clear", "context", "compact"]);
    expect(result.skills).toEqual([]);
    expect(result.problems).toHaveLength(BUILTIN_COMMAND_NAMES.length);
    for (const problem of result.problems) {
      expect(problem.message).toContain("内置命令");
    }
  });

  it("SKILL_NAME_PATTERN 是共享常量", () => {
    expect(SKILL_NAME_PATTERN.test("review-diff")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("review_diff2")).toBe(true);
    expect(SKILL_NAME_PATTERN.test("2fast")).toBe(false);
    expect(SKILL_NAME_PATTERN.test("Upper")).toBe(false);
  });
});

describe("作用域合并", () => {
  it("同名时项目技能覆盖用户技能", () => {
    const { roots, home, workdir } = makeRoots();
    writeSkillFile(userDir(home), "dup.md", "---\ndescription: 用户版\n---\n用户正文\n");
    writeSkillFile(projectDir(workdir), "dup.md", "---\ndescription: 项目版\n---\n项目正文\n");

    const result = readSkills(roots);

    expect(result.problems).toEqual([]);
    expect(result.skills).toEqual([
      {
        name: "dup",
        description: "项目版",
        argumentHint: "",
        scope: "project",
        body: "项目正文",
      },
    ]);
  });

  it("同一层里 skill CLI 的库压过应用的库", () => {
    // 规则：项目级压用户级，同一层里 `.agents` 压过应用自己的库。
    const { roots, home, agentsHome } = makeRoots();
    writeSkillFile(userDir(home), "review.md", "---\ndescription: 应用库\n---\n应用正文\n");
    writeSkillFile(
      path.join(agentsHome, "skills"),
      "review.md",
      "---\ndescription: CLI 库\n---\nCLI 正文\n",
    );

    const result = readSkills(roots);

    expect(result.problems).toEqual([]);
    expect(result.skills).toEqual([
      { name: "review", description: "CLI 库", argumentHint: "", scope: "user", body: "CLI 正文" },
    ]);
  });

  it("项目级的应用库压过用户级的 CLI 库", () => {
    // 跨层的顺序仍然是「最近的」优先，不能让用户级的 `.agents` 顶掉项目级。
    const { roots, home, workdir, agentsHome } = makeRoots();
    writeSkillFile(
      path.join(agentsHome, "skills"),
      "review.md",
      "---\ndescription: 用户级 CLI\n---\n用户级\n",
    );
    writeSkillFile(projectDir(workdir), "review.md", "---\ndescription: 项目级应用\n---\n项目级\n");

    const result = readSkills(roots);

    expect(result.skills).toEqual([
      { name: "review", description: "项目级应用", argumentHint: "", scope: "project", body: "项目级" },
    ]);
  });

  it("目录式技能也能参与覆盖", () => {
    const { roots, workdir } = makeRoots();
    mkdirSync(path.join(projectDir(workdir), "from-cli"), { recursive: true });
    writeFileSync(
      path.join(projectDir(workdir), "from-cli", "SKILL.md"),
      "---\ndescription: 目录式\n---\n正文\n",
      "utf8",
    );

    expect(readSkills(roots).skills).toEqual([
      { name: "from-cli", description: "目录式", argumentHint: "", scope: "project", body: "正文" },
    ]);
  });
});

describe("writeSkill", () => {
  it("两个作用域都能写后读回（含 frontmatter 往返）", async () => {
    const { roots } = makeRoots();
    const body = "审查 $ARGUMENTS 的改动，列出有风险的地方。";

    const written = await writeSkill(roots, {
      name: "review-diff",
      description: "审查当前的改动",
      argumentHint: "[path]",
      body,
    });
    const projectWritten = await writeSkill(roots, {
      name: "probe",
      scope: "project",
      body: "只读诊断。",
    });

    expect(written).toEqual({
      name: "review-diff",
      description: "审查当前的改动",
      argumentHint: "[path]",
      scope: "user",
      body,
    });
    expect(projectWritten).toEqual({
      name: "probe",
      description: "",
      argumentHint: "",
      scope: "project",
      body: "只读诊断。",
    });
    expect(readSkills(roots)).toEqual({
      skills: [
        { name: "probe", description: "", argumentHint: "", scope: "project", body: "只读诊断。" },
        {
          name: "review-diff",
          description: "审查当前的改动",
          argumentHint: "[path]",
          scope: "user",
          body,
        },
      ],
      problems: [],
    });
  });

  it("含冒号的值与空值会被引号包裹，并能原样读回", async () => {
    const { roots, home } = makeRoots();

    await writeSkill(roots, { name: "colon", description: "范围: 全部", body: "正文" });
    await writeSkill(roots, { name: "empty", description: "", body: "正文" });

    const colonRaw = readFileSync(path.join(userDir(home), "colon.md"), "utf8");
    expect(colonRaw).toContain('description: "范围: 全部"');
    expect(readFileSync(path.join(userDir(home), "empty.md"), "utf8")).toContain('description: ""');

    const skills = readSkills(roots).skills;
    expect(skills.find((skill) => skill.name === "colon")?.description).toBe("范围: 全部");
    expect(skills.find((skill) => skill.name === "empty")?.description).toBe("");
  });

  it.each<[string, string, string]>([
    ["含冒号", "范围: 全部", ""],
    ["含井号", "改 #1 之后", ""],
    ["首尾空格", " 留白 ", ""],
    ["空值", "", ""],
    ["含双引号", '他说"继续"', ""],
    ["含单引号", "don't", ""],
    ["首尾同引号", '"已加引号"', ""],
    ["提示本身含冒号", "审查改动", "[path]: 可选"],
  ])("frontmatter 往返恒等（%s）", async (_label, description, argumentHint) => {
    const { roots } = makeRoots();

    const written = await writeSkill(roots, { name: "roundtrip", description, argumentHint, body: "正文" });

    expect(written).toMatchObject({ description: description.trim(), argumentHint: argumentHint.trim() });
    expect(readSkills(roots).skills).toEqual([written]);
    expect(readSkills(roots).problems).toEqual([]);
  });

  it("落盘是 UTF-8 无 BOM、LF 换行、末尾有换行，且不留临时文件", async () => {
    const { roots, home } = makeRoots();

    await writeSkill(roots, { name: "encoded", description: "编码", body: "正文" });

    const raw = readFileSync(path.join(userDir(home), "encoded.md"));
    expect(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(raw.toString("utf8")).toBe('---\ndescription: 编码\nargument-hint: ""\n---\n正文\n');
    expect(readdirSync(userDir(home)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  // 每一项都必须自带 name；缺省作用域的那几行走默认 user，其余字段可任意填充。
  it.each<[string, WriteSkillInput]>([
    ["名称大写", { name: "Bad", body: "正文" }],
    ["名称含空格", { name: "bad name", body: "正文" }],
    ["名称是路径穿越", { name: "../escape", body: "正文" }],
    ["名称是 Windows 保留名", { name: "con", body: "正文" }],
    ["名称与内置命令冲突", { name: "clear", body: "正文" }],
    ["正文为空", { name: "empty-body", body: "   \n " }],
    ["正文不是字符串", { name: "bad-body", body: 42 }],
    ["作用域非法", { name: "bad-scope", body: "正文", scope: "global" }],
    ["argumentHint 超长", { name: "long-hint", body: "正文", argumentHint: "a".repeat(101) }],
    ["description 超长", { name: "long-desc", body: "正文", description: "字".repeat(501) }],
  ])("拒绝非法输入（%s），且不落盘", async (_label, input) => {
    const { roots, home } = makeRoots();

    await expectSkillError(() => writeSkill(roots, input), "invalid_skill");

    expect(existsSync(userDir(home))).toBe(false);
  });

  it("项目作用域没有 workdir 时显式报错，不会退回用户目录", async () => {
    const home = makeDir("eam-skills-home-");
    const agentsHome = makeDir("eam-skills-agents-");

    const error = await expectSkillError(
      () => writeSkill({ home, agentsHome }, { name: "proj", scope: "project", body: "正文" }),
      "invalid_skill",
    );

    expect(error.message).toContain("workdir");
    expect(existsSync(userDir(home))).toBe(false);
  });

  it("同名技能来自 skill CLI 时拒绝写入，并说出那份文件的路径", async () => {
    // 写进应用的库会被 `.agents` 遮住：保存"成功"但 `/name` 还是旧的。
    // 必须拒绝并指路，否则这是一次静默失败（R3）。
    const { roots, agentsHome } = makeRoots();
    const cliFile = writeSkillFile(
      path.join(agentsHome, "skills"),
      "review.md",
      "---\ndescription: CLI 版\n---\nCLI 正文\n",
    );

    const error = await expectSkillError(
      () => writeSkill(roots, { name: "review", description: "我的版本", body: "我的正文" }),
      "invalid_skill",
    );

    expect(error.message).toContain("遮蔽");
    expect(error.message).toContain(cliFile);
    // 原文件没有被改动。
    expect(readFileSync(cliFile, "utf8")).toContain("CLI 版");
  });

  it("同名目录式技能来自 CLI 时同样拒绝写入", async () => {
    const { roots, agentsHome } = makeRoots();
    mkdirSync(path.join(agentsHome, "skills", "review"), { recursive: true });
    writeFileSync(
      path.join(agentsHome, "skills", "review", "SKILL.md"),
      "---\ndescription: CLI 目录版\n---\n正文\n",
      "utf8",
    );

    const error = await expectSkillError(
      () => writeSkill(roots, { name: "review", body: "我的正文" }),
      "invalid_skill",
    );

    expect(error.message).toContain("遮蔽");
  });

  it("写入永远落在应用的库，即使 CLI 的根优先级更高", async () => {
    const { roots, home, agentsHome } = makeRoots();

    await writeSkill(roots, { name: "mine", body: "正文" });

    expect(existsSync(path.join(home, "skills", "mine.md"))).toBe(true);
    expect(existsSync(path.join(agentsHome, "skills", "mine.md"))).toBe(false);
  });
});

describe("removeSkill", () => {
  it("删到返回 true，再删一次返回 false", async () => {
    const { roots, home } = makeRoots();
    await writeSkill(roots, { name: "gone", body: "正文" });

    await expect(removeSkill(roots, { name: "gone", scope: "user" })).resolves.toBe(true);
    await expect(removeSkill(roots, { name: "gone", scope: "user" })).resolves.toBe(false);

    expect(readSkills(roots).skills).toEqual([]);
    expect(existsSync(path.join(userDir(home), "gone.md"))).toBe(false);
  });

  it("删除的是读时生效的那一份：被 CLI 遮住的应用库副本不会挡路", async () => {
    // 用户点的是列表里的一行，那一行代表解析结果。删掉一个被 `.agents`
    // 遮住的应用库副本，只会让这一行原地不动——看起来像删除失败了。
    const { roots, home, agentsHome } = makeRoots();
    const appCopy = path.join(userDir(home), "review.md");
    writeSkillFile(userDir(home), "review.md", "---\ndescription: 应用库\n---\n应用\n");
    writeSkillFile(path.join(agentsHome, "skills"), "review.md", "---\ndescription: CLI\n---\nCLI\n");

    const error = await expectSkillError(
      () => removeSkill(roots, { name: "review", scope: "user" }),
      "invalid_skill",
    );

    // CLI 的目录不归我们管：说清楚去哪删，而不是删掉一个看不见的副本。
    expect(error.message).toContain("skill CLI");
    expect(readFileSync(appCopy, "utf8")).toContain("应用");
    expect(existsSync(path.join(agentsHome, "skills", "review.md"))).toBe(true);
  });

  it("拒绝路径穿越，且不碰文件系统", async () => {
    const { roots, home, workdir } = makeRoots();
    mkdirSync(userDir(home), { recursive: true });
    const sentinel = writeSkillFile(home, "escape.md", "不该被删掉\n");

    for (const scope of ["user", "project"] as const) {
      await expectSkillError(() => removeSkill(roots, { name: "../escape", scope }), "invalid_skill");
    }

    expect(readFileSync(sentinel, "utf8")).toBe("不该被删掉\n");
    expect(readdirSync(userDir(home))).toEqual([]);
    expect(existsSync(path.join(workdir, ".harness"))).toBe(false);
  });

  it("作用域必须是显式给出的 user / project", async () => {
    const { roots } = makeRoots();

    await expectSkillError(() => removeSkill(roots, { name: "x", scope: undefined }), "invalid_skill");
    await expectSkillError(() => removeSkill(roots, { name: "x", scope: "global" }), "invalid_skill");
  });
});
