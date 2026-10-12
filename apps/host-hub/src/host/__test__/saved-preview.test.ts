/**
 * 会话预览摘要（内容搜索的锚点）。
 *
 * 症状：移动端搜索的引导文案写着「试试项目名、文件名或对话关键词」，但列表行的
 * preview 恒为空串——内容关键词永远零结果，承诺了做不到的能力。
 *
 * 语义：标题取首条用户消息，预览取其后的正文（重复首条等于没提供信息）。
 */
import { describe, expect, test } from 'bun:test'

import { foldSummary } from '../saved-query.ts'

const text = (value: string): unknown => ({ type: 'text', text: value })
const message = (role: 'user/message' | 'assistant/message', value: string): unknown => ({
  type: role,
  data: { content: [text(value)] },
})

const header = { id: 's1', createdAt: 1 } as unknown as Parameters<typeof foldSummary>[0]

function previewOf(events: unknown[]): string {
  return foldSummary(header, events as never, '/tmp/sessions').preview
}

describe('foldSummary preview（症状：内容搜索永远零结果）', () => {
  test('首条用户消息之后有正文：预览取其后的内容而非首条', () => {
    const preview = previewOf([
      message('user/message', '帮我看看这个 bug'),
      message('assistant/message', '我先复现一下问题，然后定位到 relay 层'),
    ])
    expect(preview).toBe('我先复现一下问题，然后定位到 relay 层')
  })

  test('多轮对话：预览取最后一条正文', () => {
    const preview = previewOf([
      message('user/message', '第一步'),
      message('assistant/message', '中间过程'),
      message('user/message', '继续'),
      message('assistant/message', '最终结论是配对字段名不匹配'),
    ])
    expect(preview).toBe('最终结论是配对字段名不匹配')
  })

  test('只有一轮：预览兜底为首条，不留空白', () => {
    const preview = previewOf([message('user/message', '只有这一句')])
    expect(preview).toBe('只有这一句')
  })

  test('无任何文本：空串（不留空白字符）', () => {
    expect(previewOf([])).toBe('')
  })

  test('超长正文按上限截断并加省略号', () => {
    const preview = previewOf([
      message('user/message', '标题'),
      message('assistant/message', '长'.repeat(400)),
    ])
    expect(preview.length).toBeLessThanOrEqual(161)
    expect(preview.endsWith('…')).toBe(true)
  })

  test('换行压成单行（列表行不换行）', () => {
    const preview = previewOf([
      message('user/message', '标题'),
      message('assistant/message', '第一行\n第二行\n\n第三行'),
    ])
    expect(preview).toBe('第一行 第二行 第三行')
  })

  test('非文本块（图片等）不污染预览', () => {
    const preview = previewOf([
      message('user/message', '看这张图'),
      { type: 'assistant/message', data: { content: [{ type: 'image' }] } },
      message('assistant/message', '图里是配对二维码'),
    ])
    expect(preview).toBe('图里是配对二维码')
  })
})