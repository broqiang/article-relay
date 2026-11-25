import type { Debugger } from 'electron'

type NetworkEvent = {
  requestId?: string
  request?: { url: string; method: string; postData?: string }
  response?: { url: string; status: number }
  redirectResponse?: unknown
  errorText?: string
}

export interface JuejinPublishDiagnostic { notice: string; rejected?: boolean }

function safeMessage(message: unknown): string {
  if (typeof message !== 'string') return ''
  return message.replace(/https?:\/\/[^\s<>"']+/gi, '〔链接〕')
    .replace(/\b(?:cookie|authorization|(?:\w+[-_])*token|session(?:id|key)?|signature)\s*[:=：]\s*(?:Bearer\s+)?[^\s,，;；]+/gi, '〔凭证〕')
    .replace(/\s+/g, ' ').trim().slice(0, 160)
}

export function monitorJuejinPublishResponse(debuggerClient: Debugger, draftId: string) {
  const publishEndpoint = /^https:\/\/api\.juejin\.cn\/content_api\/v1\/article\/publish(?:\?|$)/
  let ownsDebugger = false
  let active = false
  let requestId: string | undefined
  let httpStatus: number | undefined
  let responseFinished = false
  let networkError: string | undefined
  let code: number | undefined
  let message = ''

  function readResponse(id: string): void {
    void debuggerClient.sendCommand('Network.getResponseBody', { requestId: id }).then(({ body, base64Encoded }) => {
      if (!active || requestId !== id || typeof body !== 'string') return
      const reply = JSON.parse(base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body)
      if (typeof reply?.err_no === 'number' && Number.isSafeInteger(reply.err_no)) {
        code = reply.err_no
        if (code !== 0) message = safeMessage(reply.err_msg || reply.message)
      }
    }).catch(() => { /* Keep the HTTP status when a response has no readable JSON. */ }).finally(() => {
      if (active && requestId === id) responseFinished = true
    })
  }

  function onMessage(_event: unknown, method: string, params: NetworkEvent): void {
    if (!active || !params?.requestId) return
    if (method === 'Network.requestWillBeSent') {
      if (params.requestId === requestId && params.redirectResponse) {
        requestId = undefined
        return
      }
      const request = params.request
      if (requestId || request?.method !== 'POST' || !publishEndpoint.test(request.url)) return
      if (request.postData) {
        try {
          if (JSON.parse(request.postData)?.draft_id !== draftId) return
        } catch { return }
      }
      requestId = params.requestId
      return
    }
    if (params.requestId !== requestId) return
    if (method === 'Network.responseReceived' && params.response && publishEndpoint.test(params.response.url)) {
      httpStatus = params.response.status
    }
    if (method === 'Network.loadingFinished') readResponse(requestId)
    if (method === 'Network.loadingFailed' && /^net::ERR_[A-Z0-9_]+$/.test(params.errorText ?? '')) {
      networkError = params.errorText
    }
  }

  function close(): void {
    active = false
    debuggerClient.removeListener('message', onMessage)
    try {
      if (ownsDebugger && debuggerClient.isAttached()) debuggerClient.detach()
    } catch { /* The editor window may already be closed. */ }
    ownsDebugger = false
  }

  return {
    async start(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (debuggerClient.isAttached()) return
        debuggerClient.attach()
        ownsDebugger = true
        active = true
        debuggerClient.on('message', onMessage)
        await Promise.race([
          debuggerClient.sendCommand('Network.enable', { maxPostDataSize: 4096 }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(reject, 1_500) }),
        ])
      } catch {
        close()
      } finally {
        clearTimeout(timer)
      }
    },
    close,
    diagnostic(): JuejinPublishDiagnostic | undefined {
      const details = [httpStatus && `HTTP ${httpStatus}`, code !== undefined && `业务码 ${code}`].filter(Boolean).join('，')
      const platformError = code !== undefined && code !== 0
      const conflict = httpStatus === 409 || /已(?:经)?(?:发布|提交)|审核中|already\s+(?:published|submitted)/i.test(message)
      const rejected = !conflict && (platformError || (responseFinished && [400, 401, 403, 413, 415, 422, 429].includes(httpStatus ?? 0)))
      if (rejected) return { rejected, notice: `掘金发布接口拒绝提交（${details}）。${message ? `${message} ` : ''}草稿已保留。` }
      if (networkError) return { notice: `掘金发布请求未完成（${networkError}）。草稿已保留。` }
      if (details) return { notice: message ? `掘金发布接口返回（${details}）。${message}` :
        `掘金发布接口已响应（${details}），暂未取得文章编号。` }
    },
  }
}
