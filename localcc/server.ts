#!/usr/bin/env bun
/**
 * localcc — OpenAI / OpenRouter / Anthropic-compatible API gateway for Claude Code.
 *
 * Exposes API endpoints based on LOCALCC_FLAVOR env var so any SDK client
 * can talk to Claude Code through the MCP channel contract.
 * No external service, no tokens, no access control.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { join, extname, basename } from 'path'

const PORT = Number(process.env.LOCALCC_PORT ?? 8686)
const STATE_DIR = join(homedir(), '.claude', 'channels', 'localcc')
const INBOX_DIR = join(STATE_DIR, 'inbox')
const OUTBOX_DIR = join(STATE_DIR, 'outbox')
const MODEL_ID = 'anthropic/claude-code'
const FLAVOR = (process.env.LOCALCC_FLAVOR ?? 'openai') as 'openai' | 'anthropic' | 'openrouter'

// ── Pending request tracking ────────────────────────────────────────
type ReplyPayload = {
  text: string
  files: { url: string; name: string; mime: string }[]
}
type Pending = {
  resolve: (payload: ReplyPayload) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  model: string
  stream: boolean
}
const pending = new Map<string, Pending>()
let seq = 0
function nextId() { return `${Date.now().toString(36)}-${(++seq).toString(36)}` }

const TIMEOUT_MS = Number(process.env.LOCALCC_TIMEOUT ?? 120_000)

// ── MCP server ──────────────────────────────────────────────────────
const mcp = new Server(
  { name: 'localcc', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: `Messages from the localcc API gateway arrive as <channel source="localcc" chat_id="api" message_id="...">. Reply with the reply tool — your transcript output never reaches the API caller.\n\nIf the tag has a file_path attribute, Read that file — it is an upload (image, PDF, etc.) from the API client.\n\nThe API is at http://localhost:${PORT} (flavor: ${FLAVOR}).`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a reply back to the API caller. The message_id must match the pending request.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The response text.' },
          message_id: { type: 'string', description: 'The message_id from the channel notification to reply to.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach (images, PDFs, etc.). These will be returned as base64 in the API response.' },
        },
        required: ['text', 'message_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const text = args.text as string
        const messageId = args.message_id as string
        const filePaths = (args.files as string[] | undefined) ?? []

        const outFiles: { url: string; name: string; mime: string }[] = []
        mkdirSync(OUTBOX_DIR, { recursive: true })

        for (const f of filePaths) {
          const st = statSync(f)
          if (st.size > 50 * 1024 * 1024) throw new Error(`file too large: ${f}`)
          const ext = extname(f).toLowerCase()
          const outName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          copyFileSync(f, join(OUTBOX_DIR, outName))
          outFiles.push({
            url: `/files/${outName}`,
            name: basename(f),
            mime: extToMime(ext),
          })
        }

        const p = pending.get(messageId)
        if (p) {
          clearTimeout(p.timer)
          pending.delete(messageId)
          p.resolve({ text, files: outFiles })
        }
        return { content: [{ type: 'text', text: `sent (${messageId})${outFiles.length ? ` +${outFiles.length} file(s)` : ''}` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())

// ── Deliver a message to Claude Code via MCP channel ────────────────
function deliver(id: string, text: string, files: { path: string; name: string }[]): void {
  if (files.length === 0) {
    void mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text,
        meta: { chat_id: 'api', message_id: id, user: 'api', ts: new Date().toISOString() },
      },
    })
  } else {
    void mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: text || `(${files[0].name})`,
        meta: {
          chat_id: 'api', message_id: id, user: 'api', ts: new Date().toISOString(),
          file_path: files[0].path,
        },
      },
    })
    for (let i = 1; i < files.length; i++) {
      void mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: `(${files[i].name})`,
          meta: {
            chat_id: 'api', message_id: id, user: 'api', ts: new Date().toISOString(),
            file_path: files[i].path,
          },
        },
      })
    }
  }
}

// ── Content flattening ──────────────────────────────────────────────
function flattenContent(content: unknown): { text: string; files: { path: string; name: string }[] } {
  if (typeof content === 'string') return { text: content, files: [] }
  if (!Array.isArray(content)) return { text: String(content ?? ''), files: [] }

  const parts: string[] = []
  const files: { path: string; name: string }[] = []

  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>

    // OpenAI / OpenRouter
    if (p.type === 'text' && typeof p.text === 'string') {
      parts.push(p.text)
    } else if (p.type === 'input_text' && typeof p.text === 'string') {
      parts.push(p.text)
    } else if (p.type === 'image_url' || p.type === 'input_image') {
      const url = (p.type === 'image_url'
        ? (p.image_url as Record<string, unknown>)?.url
        : p.image_url) as string | undefined
      if (url) {
        const saved = saveDataUrl(url)
        if (saved) files.push(saved)
        else parts.push(`[image: ${url.slice(0, 80)}...]`)
      }
    }
    // Anthropic: image with source.type=base64
    else if (p.type === 'image') {
      const src = p.source as Record<string, unknown> | undefined
      if (src?.type === 'base64' && typeof src.data === 'string' && typeof src.media_type === 'string') {
        const saved = saveDataUrl(`data:${src.media_type};base64,${src.data}`)
        if (saved) files.push(saved)
      }
    }
    // Anthropic: document (PDF etc)
    else if (p.type === 'document') {
      const src = p.source as Record<string, unknown> | undefined
      if (src?.type === 'base64' && typeof src.data === 'string' && typeof src.media_type === 'string') {
        const saved = saveDataUrl(`data:${src.media_type};base64,${src.data}`)
        if (saved) files.push(saved)
      }
    }
  }
  return { text: parts.join('\n'), files }
}

function saveDataUrl(url: string): { path: string; name: string } | undefined {
  const match = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) return undefined
  const [, mimeType, b64] = match
  const ext = mimeToExt(mimeType) || '.bin'
  mkdirSync(INBOX_DIR, { recursive: true })
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
  const path = join(INBOX_DIR, name)
  writeFileSync(path, Buffer.from(b64, 'base64'))
  return { path, name }
}

function mimeToExt(mime: string): string {
  const m: Record<string, string> = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'image/svg+xml': '.svg', 'application/pdf': '.pdf',
  }
  return m[mime] ?? ''
}

function extToMime(ext: string): string {
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  }
  return m[ext] ?? 'application/octet-stream'
}

// ── Extract messages from request body ──────────────────────────────
function extractMessages(body: Record<string, unknown>): { text: string; files: { path: string; name: string }[] } {
  // Anthropic: system prompt is a top-level field
  const systemPrompt = typeof body.system === 'string' ? body.system : ''

  const raw = body.messages ?? body.input
  if (typeof raw === 'string') return { text: raw, files: [] }
  if (!Array.isArray(raw)) return { text: JSON.stringify(raw), files: [] }

  const allParts: string[] = []
  const allFiles: { path: string; name: string }[] = []

  if (systemPrompt) allParts.push(`[system]: ${systemPrompt}`)

  for (const msg of raw) {
    if (!msg || typeof msg !== 'object') continue
    const m = msg as Record<string, unknown>
    const role = (m.role as string) ?? 'user'
    const { text, files } = flattenContent(m.content)
    if (text) allParts.push(`[${role}]: ${text}`)
    allFiles.push(...files)
  }
  return { text: allParts.join('\n\n'), files: allFiles }
}

// ── Read file as base64 data URL ────────────────────────────────────
function fileToDataUrl(filePath: string, mime: string): string {
  const data = readFileSync(filePath)
  return `data:${mime};base64,${data.toString('base64')}`
}

function fileToBase64(filePath: string): string {
  return readFileSync(filePath).toString('base64')
}

// ── Response builders ───────────────────────────────────────────────

// OpenAI Chat Completions
function chatCompletionResponse(id: string, model: string, reply: ReplyPayload) {
  const content: unknown[] = []
  if (reply.text) content.push({ type: 'text', text: reply.text })
  for (const f of reply.files) {
    const fullPath = join(OUTBOX_DIR, f.url.replace('/files/', ''))
    if (f.mime.startsWith('image/'))
      content.push({ type: 'image_url', image_url: { url: fileToDataUrl(fullPath, f.mime) } })
  }
  const messageContent = content.length === 1 && reply.files.length === 0 ? reply.text : content

  return {
    id: `gen-${id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    system_fingerprint: `fp_localcc_${Date.now().toString(36)}`,
    choices: [{
      index: 0,
      message: { role: 'assistant' as const, content: messageContent, refusal: null },
      finish_reason: 'stop',
      logprobs: null,
    }],
    usage: {
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  }
}

// OpenAI Responses API
function responsesApiResponse(id: string, model: string, reply: ReplyPayload) {
  const content: unknown[] = []
  if (reply.text) content.push({ type: 'output_text', text: reply.text })
  for (const f of reply.files) {
    const fullPath = join(OUTBOX_DIR, f.url.replace('/files/', ''))
    if (f.mime.startsWith('image/'))
      content.push({ type: 'output_image', image_url: fileToDataUrl(fullPath, f.mime) })
  }

  return {
    id: `resp-${id}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content }],
    output_text: reply.text,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }
}

// Anthropic Messages API
function anthropicResponse(id: string, model: string, reply: ReplyPayload) {
  const content: unknown[] = []
  if (reply.text) content.push({ type: 'text', text: reply.text })
  for (const f of reply.files) {
    const fullPath = join(OUTBOX_DIR, f.url.replace('/files/', ''))
    if (f.mime.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: f.mime, data: fileToBase64(fullPath) },
      })
    }
  }

  return {
    id: `msg_${id}`,
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }
}

// OpenAI streaming
function openaiStreamChunks(id: string, model: string, reply: ReplyPayload): string[] {
  const created = Math.floor(Date.now() / 1000)
  const cid = `gen-${id}`
  return [
    JSON.stringify({
      id: cid, object: 'chat.completion.chunk', created, model,
      system_fingerprint: `fp_localcc_${Date.now().toString(36)}`,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
    JSON.stringify({
      id: cid, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }],
    }),
    JSON.stringify({
      id: cid, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  ]
}

// Anthropic streaming
function anthropicStreamEvents(id: string, model: string, reply: ReplyPayload): string[] {
  const msgId = `msg_${id}`
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { id: msgId, type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
    })}`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text },
    })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop', index: 0,
    })}`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 },
    })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
  ]
}

// ── Error responses ─────────────────────────────────────────────────
function errorResponse(code: number, message: string) {
  if (FLAVOR === 'anthropic') {
    return Response.json({
      type: 'error',
      error: { type: 'invalid_request_error', message },
    }, { status: code, headers: CORS })
  }
  return Response.json({
    error: { code, message, metadata: {} },
  }, { status: code, headers: CORS })
}

// ── HTTP server ─────────────────────────────────────────────────────
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key, anthropic-version, http-referer, x-title, x-stainless-lang, x-stainless-os, x-stainless-runtime, x-stainless-arch, x-stainless-package-version, x-stainless-runtime-version, x-stainless-retry-count',
}

const MODEL_ENTRY = {
  id: MODEL_ID,
  object: 'model',
  created: Math.floor(Date.now() / 1000),
  owned_by: 'anthropic',
  name: 'Claude Code',
  description: 'Claude Code via MCP channel gateway',
  context_length: 200000,
  architecture: { tokenizer: 'claude', instruct_type: 'claude' },
  pricing: { prompt: '0', completion: '0', image: '0', request: '0' },
  top_provider: { max_completion_tokens: null, is_moderated: false },
  per_request_limits: null,
}

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    // ── Serve outbox files ──────────────────────────────────────
    if (path.startsWith('/files/')) {
      const f = path.slice(7)
      if (f.includes('..') || f.includes('/')) return errorResponse(400, 'bad path')
      try {
        const data = readFileSync(join(OUTBOX_DIR, f))
        return new Response(data, {
          headers: { ...CORS, 'content-type': extToMime(extname(f).toLowerCase()) },
        })
      } catch {
        return errorResponse(404, 'file not found')
      }
    }

    // ── Health ──────────────────────────────────────────────────
    if (path === '/' || path === '/health') {
      return Response.json({ status: 'ok', flavor: FLAVOR, pending: pending.size }, { headers: CORS })
    }

    // ── Anthropic flavor ────────────────────────────────────────
    if (FLAVOR === 'anthropic') {
      if (path === '/v1/messages' && req.method === 'POST') {
        try { return await handleRequest(await req.json(), 'anthropic') }
        catch (err) { return errorResponse(400, err instanceof Error ? err.message : 'bad request') }
      }
      return errorResponse(404, `not found: ${path}`)
    }

    // ── OpenAI / OpenRouter flavors ─────────────────────────────

    // Models
    if ((path === '/v1/models' || path === '/api/v1/models') && req.method === 'GET') {
      return Response.json({ object: 'list', data: [MODEL_ENTRY] }, { headers: CORS })
    }
    if ((path === `/v1/models/${MODEL_ID}` || path === `/api/v1/models/${MODEL_ID}`) && req.method === 'GET') {
      return Response.json({ data: MODEL_ENTRY }, { headers: CORS })
    }

    // Chat Completions
    if ((path === '/v1/chat/completions' || path === '/api/v1/chat/completions') && req.method === 'POST') {
      try { return await handleRequest(await req.json(), 'chat') }
      catch (err) { return errorResponse(400, err instanceof Error ? err.message : 'bad request') }
    }

    // Responses API
    if (path === '/v1/responses' && req.method === 'POST') {
      try { return await handleRequest(await req.json(), 'responses') }
      catch (err) { return errorResponse(400, err instanceof Error ? err.message : 'bad request') }
    }

    // OpenRouter extras
    if (FLAVOR === 'openrouter') {
      if ((path === '/api/v1/generation' || path === '/v1/generation') && req.method === 'GET') {
        const genId = url.searchParams.get('id')
        return Response.json({
          data: {
            id: genId ?? 'unknown', model: MODEL_ID, total_cost: 0, origin: 'localcc',
            usage: 0, is_byok: false, created_at: new Date().toISOString(),
            provider_name: 'localcc', latency: 0,
            tokens_prompt: 0, tokens_completion: 0,
            native_tokens_prompt: 0, native_tokens_completion: 0,
            num_media_prompt: null, num_media_completion: null,
            cancelled: false, finish_reason: 'stop',
          },
        }, { headers: CORS })
      }
      if ((path === '/api/v1/auth/key' || path === '/v1/auth/key') && req.method === 'GET') {
        return Response.json({
          data: { label: 'localcc', usage: 0, limit: null, is_free_tier: false, rate_limit: { requests: 1000, interval: '10s' } },
        }, { headers: CORS })
      }
    }

    return errorResponse(404, `not found: ${path}`)
  },
})

async function handleRequest(
  body: Record<string, unknown>,
  format: 'chat' | 'responses' | 'anthropic',
): Promise<Response> {
  const id = nextId()
  const model = (body.model as string) ?? MODEL_ID
  const stream = Boolean(body.stream)

  const { text, files } = extractMessages(body)
  if (!text.trim() && !files.length) {
    return errorResponse(400, 'empty input')
  }

  const reply = await new Promise<ReplyPayload>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout waiting for Claude reply'))
    }, TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer, model, stream })
    deliver(id, text, files)
  }).catch(err => {
    return { text: `error: ${err instanceof Error ? err.message : err}`, files: [] } as ReplyPayload
  })

  // Cleanup inbox files
  for (const f of files) {
    try { unlinkSync(f.path) } catch {}
  }

  const headers: Record<string, string> = { ...CORS, 'x-request-id': id }

  if (stream) {
    if (format === 'anthropic') {
      const events = anthropicStreamEvents(id, model, reply)
      const sseBody = events.map(e => `${e}\n\n`).join('')
      return new Response(sseBody, {
        headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      })
    }
    const chunks = openaiStreamChunks(id, model, reply)
    const sseBody = chunks.map(c => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(sseBody, {
      headers: { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    })
  }

  let payload
  switch (format) {
    case 'anthropic': payload = anthropicResponse(id, model, reply); break
    case 'responses': payload = responsesApiResponse(id, model, reply); break
    default: payload = chatCompletionResponse(id, model, reply); break
  }

  return Response.json(payload, { headers })
}

process.stderr.write(`localcc: http://localhost:${PORT} (${FLAVOR})\n`)
