import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(import.meta.dirname, '..', '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'kb-review.mjs')
const DIST_INBOX = path.join(ROOT, 'dist-mcp', 'kb', 'inbox.js')

describe.skipIf(!existsSync(DIST_INBOX))('kb-review 脚本回归门禁', () => {
  it('回归低于基线时拒绝接受且保持 inbox 不变', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kb-review-script-'))
    try {
      writeFileSync(path.join(root, 'index.yaml'), 'version: 1\nentries:\n', 'utf8')
      writeFileSync(
        path.join(root, '_inbox.md'),
        [
          '---',
          'id: test-1',
          'date: 2026-10-20',
          'kind: trap',
          'domain: uart',
          'source: test',
          'content: 回归应失败',
          '---',
          '',
        ].join('\n'),
        'utf8',
      )
      writeFileSync(path.join(root, 'target.md'), '# target\n', 'utf8')

      const result = spawnSync(
        process.execPath,
        [SCRIPT, '--accept', 'test-1', '--target', 'target.md'],
        {
          cwd: ROOT,
          env: { ...process.env, KB_ROOT: root },
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        },
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('回归低于基线')
      expect(existsSync(path.join(root, '_reviewed.md'))).toBe(false)
      expect(readFileSync(path.join(root, '_inbox.md'), 'utf8')).toContain('id: test-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('--inbox 指向根外文件时读该文件，不看 <KB 根>/_inbox.md', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kb-review-script-'))
    const inboxDir = mkdtempSync(path.join(tmpdir(), 'kb-review-inbox-'))
    const externalInbox = path.join(inboxDir, '_inbox.md')
    try {
      writeFileSync(path.join(root, 'index.yaml'), 'version: 1\nentries:\n', 'utf8')
      writeFileSync(
        externalInbox,
        [
          '---',
          'id: external-1',
          'date: 2026-10-23',
          'kind: trap',
          'domain: uart',
          'source: test',
          'content: 根外的待审提案',
          '---',
          '',
        ].join('\n'),
        'utf8',
      )

      const result = spawnSync(process.execPath, [SCRIPT, '--list', '--inbox', externalInbox], {
        cwd: ROOT,
        env: { ...process.env, KB_ROOT: root },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('external-1')
      expect(result.stdout).toContain('根外的待审提案')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(inboxDir, { recursive: true, force: true })
    }
  })

  it('未传 --inbox 且 KB_INBOX_PATH 未设时仍读 <KB 根>/_inbox.md（向后兼容）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kb-review-script-'))
    try {
      writeFileSync(path.join(root, 'index.yaml'), 'version: 1\nentries:\n', 'utf8')
      writeFileSync(
        path.join(root, '_inbox.md'),
        [
          '---',
          'id: legacy-1',
          'date: 2026-10-20',
          'kind: trap',
          'domain: uart',
          'source: test',
          'content: 根内提案',
          '---',
          '',
        ].join('\n'),
        'utf8',
      )

      const env: NodeJS.ProcessEnv = { ...process.env, KB_ROOT: root }
      delete env.KB_INBOX_PATH
      const result = spawnSync(process.execPath, [SCRIPT, '--list'], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('legacy-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('KB_INBOX_PATH 环境变量与 --inbox 同口径（后者优先）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kb-review-script-'))
    const inboxDir = mkdtempSync(path.join(tmpdir(), 'kb-review-inbox-'))
    const fromEnv = path.join(inboxDir, 'env-inbox.md')
    const fromArg = path.join(inboxDir, 'arg-inbox.md')
    const block = (id: string): string =>
      ['---', `id: ${id}`, 'date: 2026-10-23', 'kind: trap', 'domain: uart', 'source: test', `content: ${id} 正文`, '---', ''].join('\n')
    try {
      writeFileSync(path.join(root, 'index.yaml'), 'version: 1\nentries:\n', 'utf8')
      writeFileSync(fromEnv, block('env-1'), 'utf8')
      writeFileSync(fromArg, block('arg-1'), 'utf8')

      const envResult = spawnSync(process.execPath, [SCRIPT, '--list'], {
        cwd: ROOT,
        env: { ...process.env, KB_ROOT: root, KB_INBOX_PATH: fromEnv },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
      expect(envResult.status).toBe(0)
      expect(envResult.stdout).toContain('env-1')

      const argResult = spawnSync(process.execPath, [SCRIPT, '--list', '--inbox', fromArg], {
        cwd: ROOT,
        env: { ...process.env, KB_ROOT: root, KB_INBOX_PATH: fromEnv },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
      expect(argResult.status).toBe(0)
      expect(argResult.stdout).toContain('arg-1')
      expect(argResult.stdout).not.toContain('env-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(inboxDir, { recursive: true, force: true })
    }
  })
})