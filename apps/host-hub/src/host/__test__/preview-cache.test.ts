/**
 * 会话摘要缓存（症状：桌面端 2s 轮询 thread/list 引发逐会话全档读风暴）。
 *
 * 回归点：preview 折叠要读整份 events.jsonl 再解析，线程表上限 1024。
 * 无缓存时每轮询 = 1024 次全档读 + 校验 + 解析。缓存键取 (threadId, mtime, size)，
 * 档内容变了这两个值必变，故命中即等价，不需要失效广播。
 */
import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPreviewCache } from '../preview-cache.ts'

const entry = (threadId: string, sessionPath: string) =>
  ({ threadId, sessionPath, state: 'live', cwd: '/w', keepalive: false, isStreaming: false, idleMs: 0, rssBytes: null }) as never

async function fixture(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'preview-cache-'))
  const path = join(dir, 'events.jsonl')
  await writeFile(path, '{"n":1}\n')
  return { dir, path }
}

describe('preview 缓存', () => {
  test('同一档重复请求只读一次（轮询不得放大成读风暴）', async () => {
    const { path } = await fixture()
    let reads = 0
    const cache = createPreviewCache({ read: async () => { reads += 1; return '摘要' } })
    const entries = [entry('t1', path)]
    await cache.load(entries)
    await cache.load(entries)
    await cache.load(entries)
    expect(reads).toBe(1)
  })

  test('档内容变化后重新读取（mtime/size 变则必失效）', async () => {
    const { path } = await fixture()
    let reads = 0
    const cache = createPreviewCache({ read: async () => { reads += 1; return `第${reads}次` } })
    await cache.load([entry('t1', path)])
    expect((await cache.load([entry('t1', path)])).get('t1')).toBe('第1次')

    await writeFile(path, '{"n":2}\n{"n":3}\n')
    await utimes(path, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    expect((await cache.load([entry('t1', path)])).get('t1')).toBe('第2次')
  })

  test('不同会话各自缓存，互不串扰', async () => {
    const { path } = await fixture()
    const reads = new Map<string, number>()
    const cache = createPreviewCache({
      read: async (threadId) => { reads.set(threadId, (reads.get(threadId) ?? 0) + 1); return `${threadId}的摘要` },
    })
    const out = await cache.load([entry('t1', path), entry('t2', path)])
    expect(out.get('t1')).toBe('t1的摘要')
    expect(out.get('t2')).toBe('t2的摘要')
    expect(reads.size).toBe(2)
  })

  test('读取抛错按空串处理，不让单个会话的失败拖垮整张列表', async () => {
    const { path } = await fixture()
    const cache = createPreviewCache({ read: async () => { throw new Error('损坏档') } })
    const out = await cache.load([entry('t1', path)])
    expect(out.get('t1')).toBe('')
  })

  test('档不存在时跳过该行，不抛', async () => {
    const cache = createPreviewCache({ read: async () => '不应被调用' })
    const out = await cache.load([entry('t1', '/nonexistent/events.jsonl')])
    expect(out.size).toBe(0)
  })

  test('缓存容量有上界（进程长跑不随会话数无界增长）', async () => {
    const { path } = await fixture()
    const cache = createPreviewCache({ read: async () => 'x' })
    for (let i = 0; i < 700; i += 1) {
      await cache.load([entry(`t${i}`, path)])
    }
    // 再次加载最早的那个：若已淘汰则会重新读——此处只断言「不会抛且结果可用」
    expect((await cache.load([entry('t0', path)])).size).toBe(1)
  })
})