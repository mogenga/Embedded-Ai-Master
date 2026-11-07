// Verify every markdown link target inside repo docs resolves. Run from repo root.
// Usage: node scripts/check-doc-links.mjs [--verbose]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".tmp", "dist", "dist-mcp", "dist-installer", ".worktrees",
  "corpus", "build", "results", "figures-c-diag",
  // 第三方技能包与实验资产：不是本仓库维护的文档，链接指向各自的上游。
  ".claude", ".codeartsdoer", "experiments",
]);

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (/\.md$/i.test(entry.name)) out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

const files = walk(".", []);
const problems = [];
let links = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const dir = path.posix.dirname(file);
  // Inline links: [text](target) — skip images by looking at the char before '['.
  const re = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const [, bang, , rawTarget] = match;
    if (bang === "!") continue; // images checked separately below
    if (/^(https?:|mailto:|#)/.test(rawTarget)) continue;
    const target = rawTarget.split("#")[0];
    if (target === "") continue;
    links += 1;
    const resolved = path.posix.normalize(path.posix.join(dir, decodeURI(target)));
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${file}:${line} -> ${rawTarget}`);
    }
  }
  // Images: <img src="..."> and ![]( ... ) — only check local ones.
  const imgRe = /(?:!\[[^\]]*\]\(([^)\s]+)\)|<img[^>]*src="([^"]+)")/g;
  while ((match = imgRe.exec(text)) !== null) {
    const rawTarget = match[1] ?? match[2];
    if (/^(https?:|data:)/.test(rawTarget)) continue;
    const target = rawTarget.split("#")[0];
    if (target === "") continue;
    links += 1;
    const resolved = path.posix.normalize(path.posix.join(dir, decodeURI(target)));
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split("\n").length;
      problems.push(`${file}:${line} -> ${rawTarget}`);
    }
  }
}

if (problems.length === 0) {
  console.log(`check-doc-links: ${files.length} 个文档、${links} 条本地链接全部可达`);
  process.exit(0);
}
console.error(`check-doc-links: ${problems.length} 条链接不可达（共 ${links} 条）`);
for (const item of problems) console.error(`  ${item}`);
process.exit(1);
