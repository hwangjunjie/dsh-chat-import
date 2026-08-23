// lib/convert/codebuddy.mjs — CodeBuddy (Tencent AI Code) JSONL → DSH 会话（纯函数）
//
// CodeBuddy 事件格式（每行一个顶层 JSON 对象）：
//   message (role=user|assistant)   — 主对话
//   function_call                   — 工具调用（name/callId/arguments）
//   function_call_result            — 工具结果（callId/status/output: {type,text}）
//   reasoning                       — 推理（rawContent[{type:"reasoning_text",text}]，可读）
//   topic / summary                 — 标题来源
//   file-history-snapshot           — 跳过
//
// 与 Codex 格式高度同构，主要差异：
//   - 无 envelope（事件直接顶层，不套 response_item payload）
//   - function_call_result 而非 function_call_output（输出字段 output:{type,text}）
//   - sessionId/cwd 在事件级别，非 session_meta

import {
  SESSION_FORMAT_VERSION,
  applyBudgetTrim,
  mintSessionId,
  parseJsonlLines,
  parseTime,
  synthesizeSession,
} from './core.mjs'

const TITLE_MAX_LEN = 80
const TITLE_ELLIPSIS = '…'
function normalizeTitle(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, ' ')
  if (!t) return ''
  return t.length <= TITLE_MAX_LEN ? t : t.slice(0, TITLE_MAX_LEN - TITLE_ELLIPSIS.length) + TITLE_ELLIPSIS
}

export function convertCodebuddyJsonl(raw, args = {}) {
  const { recs, skipped, skippedLines, secrets } = parseJsonlLines(raw)

  let sourceId = null
  let cwd = null
  let createdAt = null
  let model = null

  const callSteps = new Map()
  const turns = []
  let cur = null
  let lastStep = null
  let firstTopic = null
  let firstSummary = null

  const openTurn = (prompt) => {
    cur = { prompt, steps: [] }
    turns.push(cur)
    lastStep = null
  }
  const openStep = () => {
    const step = { content: [], toolCalls: [], toolResults: [] }
    if (cur) cur.steps.push(step)
    lastStep = step
    return step
  }

  for (const rec of recs) {
    if (!rec || typeof rec !== 'object') continue
    const env = rec.type

    // ── 元数据提取 ──
    if (!sourceId && typeof rec.sessionId === 'string' && rec.sessionId) sourceId = rec.sessionId
    if (!cwd && typeof rec.cwd === 'string' && rec.cwd) cwd = rec.cwd
    if (createdAt === null && rec.timestamp) createdAt = parseTime(rec.timestamp)
    const pd = rec.providerData
    if (!model && pd && typeof pd.model === 'string' && pd.model) model = pd.model

    // ── message: user / assistant ──
    if (env === 'message' && rec.role === 'user' && Array.isArray(rec.content)) {
      const parts = []
      for (const block of rec.content) {
        if (block && block.type === 'input_text' && typeof block.text === 'string') {
          if (!block.text.startsWith('<')) parts.push(block.text)
        }
      }
      const prompt = parts.join('\n').trim()
      if (prompt) openTurn(prompt)
    } else if (env === 'message' && rec.role === 'assistant' && cur) {
      const step = openStep()
      for (const block of (rec.content || [])) {
        if (block && block.type === 'output_text' && typeof block.text === 'string') {
          step.content.push({ type: 'text', text: block.text })
        }
      }

    // ── function_call → 工具调用 ──
    } else if (env === 'function_call' && cur) {
      const step = lastStep || openStep()
      const callId = rec.callId
      const argumentsText = typeof rec.arguments === 'string'
        ? rec.arguments
        : JSON.stringify(rec.arguments ?? {})
      const mapped = {
        id: callId,
        name: rec.name || 'unknown',
        arguments: argumentsText,
      }
      // 与 Codex 一致：assistant 消息必须携带 tool-call block
      step.content.push({ type: 'tool-call', ...mapped })
      step.toolCalls.push(mapped)
      if (callId) callSteps.set(callId, step)

    // ── function_call_result → 工具结果 ──
    } else if (env === 'function_call_result' && cur) {
      const callId = rec.callId
      const step = callSteps.get(callId) || lastStep || openStep()
      let text = ''
      const out = rec.output
      if (out && typeof out === 'object' && typeof out.text === 'string') {
        text = out.text
      } else if (typeof out === 'string') {
        text = out
      } else {
        text = JSON.stringify(out ?? '')
      }
      const isError = rec.status && rec.status !== 'completed'
      step.toolResults.push({
        toolCallId: callId,
        content: [{ type: 'text', text }],
        isError: !!isError,
      })

    // ── reasoning（可读文本，跳过以与 Codex 保持一致）──
    } else if (env === 'reasoning') {
      // CodeBuddy reasoning 含可读 rawContent[{type:"reasoning_text",text}]，
      // 但 DSH 统一由 synthesizeSession 处理事件纪律，暂跳过。

    // ── topic / summary → 标题候选 ──
    } else if (env === 'topic' && !firstTopic && typeof rec.topic === 'string') {
      firstTopic = rec.topic.trim()
    } else if (env === 'summary' && !firstSummary && typeof rec.summary === 'string') {
      firstSummary = rec.summary.trim()
    }
    // file-history-snapshot / 其余忽略
  }

  const sessionId = args.sessionId || mintSessionId(sourceId)
  const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: createdAt ?? Date.now() }
  if (sourceId) meta.sourceId = sourceId
  if (cwd) meta.cwd = cwd

  // 标题优先级：topic > summary > 首问。钉 session/title 事件（显式标题机制）：
  // 导入历史会话的列表标题不能依赖 DSH 自动回退（实测落到工作区名「notes」），
  // 必须钉住才有正确标题。
  const finalTitle = normalizeTitle(firstTopic || firstSummary || (turns.length > 0 ? turns[0].prompt : ''))
  const { turns: seedTurns, trimmed } = applyBudgetTrim(turns, args.budget)
  const syn = synthesizeSession({
    meta, turns: seedTurns, title: finalTitle || undefined, provider: 'codebuddy', model,
    skipped, records: recs.length, skippedLines, secrets,
    imported: { sourcePath: args.sourcePath },
  })
  return {
    ...syn,
    title: finalTitle,
    ...(trimmed ? { trimmed } : {}),
  }
}
