import { createHash, createHmac } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Article } from './wechat.js'

export interface ZhihuAccount {
  id: string
  name: string
}

type Request = (url: string, init: RequestInit) => Promise<Response>

const column = 'https://zhuanlan.zhihu.com'
const imageApi = 'https://api.zhihu.com/images'
const keyPattern = /^[\w-]+(?:\.[\w-]+)?$/

export function draftUrl(id: string): string {
  if (!/^\d+$/.test(id)) throw new Error('知乎返回了无效的草稿编号。')
  return `${column}/p/${id}/edit`
}

export class Zhihu {
  constructor(private readonly request: Request) {}

  private async fetch(url: string, step: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.request(url, {
        ...init,
        credentials: init.credentials ?? 'include',
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
        headers: init.credentials === 'omit' ? init.headers : { 'x-requested-with': 'fetch', ...init.headers },
      })
    } catch {
      throw new Error(`${step}时网络连接失败或请求超时。`)
    }
  }

  private async json(response: Response, step: string): Promise<Record<string, unknown>> {
    if (!response.ok) throw this.responseError(step, response.status)
    let body: unknown
    try {
      body = JSON.parse(await response.text(), (key, value: unknown, context?: { source?: string }) => {
        // A numeric draft ID can exceed JavaScript's safe integer range.
        if ((key === 'id' || key === 'image_id') && typeof value === 'number' && context?.source && /^\d+$/.test(context.source)) {
          return context.source
        }
        return value
      })
    } catch {
      throw new Error(`${step}失败，知乎返回了无法识别的数据。`)
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`${step}失败，知乎返回了无法识别的数据。`)
    }
    return body as Record<string, unknown>
  }

  private responseError(step: string, status: number): Error {
    if (status === 401 || status === 403) {
      return new Error(`${step}失败（${status}）。请在应用内打开知乎，确认账号已登录且能正常创作。`)
    }
    return new Error(`${step}失败（HTTP ${status}）。`)
  }

  async account(): Promise<ZhihuAccount | null> {
    const step = '检查知乎账号'
    const response = await this.fetch('https://www.zhihu.com/api/v4/me', step)
    if (response.status === 401) return null
    const body = await this.json(response, step)
    if (typeof body.id !== 'string' || !body.id) return null
    return { id: body.id, name: typeof body.name === 'string' && body.name ? body.name : '知乎账号' }
  }

  private async uploadImageFile(file: Blob, step: string): Promise<string> {
    if (!file.size || !/^image\/(jpeg|png|gif|webp)$/.test(file.type)) {
      throw new Error(`${step}失败，本地图片文件无效。`)
    }
    const bytes = await file.arrayBuffer()
    const response = await this.fetch(imageApi, `${step}：请求图片上传凭证`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_hash: createHash('md5').update(new Uint8Array(bytes)).digest('hex'), source: 'article' }),
    })
    const data = await this.json(response, `${step}：请求图片上传凭证`)
    const upload = data.upload_file as { state?: number; image_id?: string; object_key?: string } | undefined
    if (upload?.state === 1 && typeof upload.image_id === 'string' && keyPattern.test(upload.image_id)) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const check = await this.fetch(`${imageApi}/${upload.image_id}`, `${step}：确认知乎图片`)
        const image = await this.json(check, `${step}：确认知乎图片`)
        if (typeof image.original_hash === 'string' && keyPattern.test(image.original_hash)) {
          return `https://pic4.zhimg.com/${image.original_hash}`
        }
        if (attempt < 9) await delay(1000)
      }
      throw new Error(`${step}失败，等待知乎处理图片超时。`)
    }

    const key = upload?.object_key
    const token = data.upload_token as { access_id?: string; access_key?: string; access_token?: string } | undefined
    if (typeof key !== 'string' || !keyPattern.test(key) || !token ||
        typeof token.access_id !== 'string' || typeof token.access_key !== 'string' || typeof token.access_token !== 'string' ||
        !token.access_id || !token.access_key || !token.access_token) {
      throw new Error(`${step}失败，知乎未返回可用的文件上传凭证。`)
    }

    const date = new Date().toUTCString()
    const ossHeaders = { 'x-oss-date': date, 'x-oss-security-token': token.access_token, 'x-oss-user-agent': 'aliyun-sdk-js/6.8.0' }
    const headersToSign = Object.entries(ossHeaders).map(([name, value]) => `${name}:${value}`).join('\n')
    const signature = createHmac('sha1', token.access_key)
      .update(`PUT\n\n${file.type}\n${date}\n${headersToSign}\n/zhihu-pics/${key}`).digest('base64')
    const saved = await this.fetch(`https://zhihu-pics-upload.zhimg.com/${key}`, `${step}：上传图片文件`, {
      method: 'PUT', credentials: 'omit', body: bytes,
      headers: {
        ...ossHeaders, 'Content-Type': file.type, Authorization: `OSS ${token.access_id}:${signature}`,
        Origin: column, Referer: `${column}/`,
      },
    })
    if (!saved.ok) throw new Error(`${step}失败，图片文件上传返回 HTTP ${saved.status}。`)
    const suffix = file.type === 'image/gif' && !key.endsWith('.gif') ? '.gif' : ''
    return `https://pic4.zhimg.com/${key}${suffix}`
  }

  async prepareContent(
    article: Article,
    readImage: (url: string) => Promise<Blob>,
    onProgress: (current: number, total: number) => void,
  ): Promise<string> {
    const imageMarker = /<img data-relay-image="(\d+)">/g
    const markers = [...article.html.matchAll(imageMarker)]
    if (markers.length !== article.images.length || markers.some((match, index) => match[1] !== String(index))) {
      throw new Error('公众号正文与图片列表不一致，请重新导入。')
    }
    const uploaded = new Map<string, string>()
    const images = [...new Set(article.images)]
    for (const [index, url] of images.entries()) {
      const step = `上传图片 ${index + 1}/${images.length}`
      onProgress(index + 1, images.length)
      uploaded.set(url, await this.uploadImageFile(await readImage(url), step))
    }
    return article.html.replace(imageMarker, (_match, index: string) => {
      const url = uploaded.get(article.images[Number(index)])
      if (!url) throw new Error('公众号正文与图片列表不一致，请重新导入。')
      const escaped = url.replace(/[&"<>]/g, (char) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char] ?? char)
      return `<figure><img src="${escaped}"></figure>`
    })
  }

  async createDraft(title: string): Promise<string> {
    const step = '创建知乎草稿'
    const response = await this.fetch(`${column}/api/articles/drafts`, step, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content: '', delta_time: 0 }),
    })
    const body = await this.json(response, step)
    const id = typeof body.id === 'string' || (typeof body.id === 'number' && Number.isSafeInteger(body.id))
      ? String(body.id) : ''
    draftUrl(id)
    return id
  }

  async updateDraft(id: string, title: string, content: string): Promise<'saved' | 'missing'> {
    draftUrl(id)
    const step = '保存知乎草稿'
    const response = await this.fetch(`${column}/api/articles/${id}/draft`, step, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content }),
    })
    if (response.status === 404) return 'missing'
    if (!response.ok) throw this.responseError(step, response.status)
    return 'saved'
  }

  async saveDraft(title: string, content: string, existing: string | undefined,
    onDraftChange: (id: string | undefined) => Promise<void>): Promise<string> {
    if (existing) {
      if (await this.updateDraft(existing, title, content) === 'saved') return existing
      await onDraftChange(undefined)
    }
    const id = await this.createDraft(title)
    await onDraftChange(id)
    if (await this.updateDraft(id, title, content) === 'missing') {
      await onDraftChange(undefined)
      throw new Error('知乎刚创建的草稿无法写入（HTTP 404），请重试。')
    }
    return id
  }
}
