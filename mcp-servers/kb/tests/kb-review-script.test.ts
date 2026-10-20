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
})