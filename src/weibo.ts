import { randomBytes } from 'node:crypto'
import { replaceArticleImages } from './article-images.js'
import type { Article } from './wechat.js'

export const weiboHome = 'https://weibo.com/'
export const weiboEditor = 'https://card.weibo.com/article/v5/editor'
const pictureOrigin = 'https://picupload.weibo.com'
const ssoCallbackOrigins = new Set(['https://passport.weibo.cn', 'https://passport.sina.cn', 'https://passport.krcom.cn'])

type Request = (url: string, init: RequestInit) => Promise<Response>
export type WeiboAccount = { id: string; name: string }
type WeiboContent = { html: string; cover: string }
type PublishedDraft = { title: string; updatedAt: number }
type PublishedArticle = { title: string; createdAt: number; url: string }

function numericId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  return typeof id === 'string' && /^[1-9]\d*$/.test(id) ? id : undefined
}

export function weiboDraftUrl(id: string): string {
  if (!numericId(id)) throw new Error('微博返回了无效的草稿编号。')
  return `${weiboEditor}#/draft/${id}`
}

export function weiboHistoryUrl(id: string): string {
  if (!numericId(id)) throw new Error('微博返回了无效的草稿编号。')
  return `${weiboEditor}#/history/${id}`
}

export function isWeiboSsoCallback(url: URL): boolean {
  return !url.username && !url.password && ssoCallbackOrigins.has(url.origin) && url.pathname === '/sso/crossdomain'
}

export function weiboArticleUrl(input: string): string | undefined {
  try {
    const url = new URL(input)
    const allowed = ['https://weibo.com', 'https://www.weibo.com', 'https://card.weibo.com']
    if (!allowed.includes(url.origin) || url.username || url.password) return
    const id = url.hostname === 'card.weibo.com'
      ? url.pathname.match(/^\/article\/m\/show\/id\/(\d+)\/?$/)?.[1]
      : url.pathname === '/ttarticle/p/show' ? url.searchParams.get('id') : undefined
    if (id && /^[1-9]\d{15,31}$/.test(id)) return `${weiboHome}ttarticle/p/show?id=${id}`
  } catch {
    return
  }
}

function requestId(owner: string): string {
  return (Buffer.from(`${owner}&${Date.now()}`).toString('base64url') + randomBytes(32).toString('base64url')).slice(0, 43)
}

export function normalizeWeiboArticleTitle(title: string): string {
  // Weibo can render ASCII double quotes as double primes on public articles.
  return title.replace(/[″“”]/g, '"').normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function findWeiboPublishedUrl(
  id: string, drafts: ReadonlyMap<string, PublishedDraft>, articles: PublishedArticle[],
): string | undefined {
  const draft = drafts.get(id)
  if (!draft?.title) return
  const matches = (candidate: PublishedDraft, article: PublishedArticle) =>
    normalizeWeiboArticleTitle(candidate.title) === normalizeWeiboArticleTitle(article.title) &&
    Math.abs(candidate.updatedAt - article.createdAt) <= 5_000
  const urls = new Set(articles.filter((article) => matches(draft, article) &&
    [...drafts.values()].filter((candidate) => matches(candidate, article)).length === 1).map((article) => article.url))
  if (urls.size === 1) return [...urls][0]
}

export class Weibo {
  constructor(private readonly request: Request) {}

  private async fetch(url: string, step: string, init: RequestInit = {}): Promise<Response> {
    try {
      const timeout = AbortSignal.timeout(25_000)
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      return await this.request(url, { ...init, credentials: 'include', redirect: 'manual', signal })
    } catch {
      throw new Error(`${step}时网络连接失败或请求超时。`)
    }
  }

  async account(signal?: AbortSignal): Promise<WeiboAccount | null> {
    const response = await this.fetch(weiboEditor, '检查微博账号', { cache: 'no-store', signal })
    if ([301, 302, 303, 307, 308, 401].includes(response.status) || response.type === 'opaqueredirect') return null
    if (!response.ok) throw new Error(`检查微博账号失败（HTTP ${response.status}）。请在应用内打开微博检查登录状态。`)
    const html = await response.text()
    const config = html.match(/\bconfig:\s*JSON\.parse\('((?:\\.|[^'\\])*)'\)/)?.[1]
    if (!config) {
      if (/<meta\b[^>]*http-equiv=["']?refresh/i.test(html)) return null
      throw new Error('微博编辑器未返回账号信息，请打开微博检查登录状态。')
    }
    try {
      const data = JSON.parse(config.replace(/\\(['\\])/g, '$1')) as { uid?: unknown; nick?: unknown }
      const id = numericId(data.uid)
      return id ? { id, name: typeof data.nick === 'string' && data.nick ? data.nick : '微博账号' } : null
    } catch {
      throw new Error('微博返回了无法识别的账号信息。')
    }
  }

  private async json<T>(response: Response, step: string): Promise<T> {
    if (!response.ok) throw new Error(`${step}失败（HTTP ${response.status}）。请检查微博登录和创作权限。`)
    try {
      const body = JSON.parse(await response.text(), (key, value: unknown, context?: { source?: string }) =>
        key === 'id' && typeof value === 'number' && context?.source && /^\d+$/.test(context.source) ? context.source : value)
      if (body && typeof body === 'object' && !Array.isArray(body)) return body as T
    } catch {
      // Unrecognized responses can also be login or verification pages.
    }
    throw new Error(`${step}失败，微博返回了无法识别的数据。请检查微博登录状态。`)
  }

  async publishedDrafts(owner: string): Promise<Map<string, PublishedDraft>> {
    const step = '核对微博发布历史'
    const rid = requestId(owner)
    const query = new URLSearchParams({ uid: owner, allow_pay: '1', _rid: rid })
    const response = await this.fetch(`https://card.weibo.com/article/v5/aj/editor/draft/historylist?${query}`, step, {
      cache: 'no-store', signal: AbortSignal.timeout(8_000),
      headers: { Referer: weiboEditor, 'SN-REQID': rid, Accept: 'application/json' },
    })
    const result = await this.json<{ code?: number | string; data?: { list?: unknown[] } }>(response, step)
    if (String(result.code) !== '100000' || !Array.isArray(result.data?.list)) {
      throw new Error('微博未返回可核对的发布历史。')
    }
    const published = new Map<string, PublishedDraft>()
    for (const entry of result.data.list) {
      if (!entry || typeof entry !== 'object') continue
      const row = entry as { id?: unknown; status?: unknown; error_code?: unknown; title?: unknown; updated?: unknown }
      const id = numericId(row.id)
      if (id && String(row.status) === '1' && String(row.error_code) === '0') {
        const updated = typeof row.updated === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.updated)
          ? Date.parse(row.updated.replace(' ', 'T') + '+08:00') : NaN
        published.set(id, { title: typeof row.title === 'string' ? row.title : '', updatedAt: updated })
      }
    }
    return published
  }

  async publishedArticles(owner: string): Promise<PublishedArticle[]> {
    const articles: PublishedArticle[] = []
    const signal = AbortSignal.timeout(8_000)
    for (let page = 1; page <= 3; page++) {
      const query = new URLSearchParams({ uid: owner, page: String(page), feature: '0' })
      const step = '查找微博文章链接'
      let result
      try {
        const response = await this.fetch(`${weiboHome}ajax/statuses/mymblog?${query}`, step, {
          cache: 'no-store', signal,
          headers: { Referer: `${weiboHome}u/${owner}`, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
        })
        result = await this.json<{ ok?: number; data?: { list?: unknown[]; since_id?: unknown } }>(response, step)
        if (result.ok !== 1 || !Array.isArray(result.data?.list)) throw new Error('微博未返回可核对的个人动态。')
      } catch (error) {
        if (page === 1) throw error
        break
      }
      for (const entry of result.data.list) {
        if (!entry || typeof entry !== 'object') continue
        const post = entry as {
          user?: { idstr?: unknown; id?: unknown }; created_at?: unknown; retweeted_status?: unknown
          page_info?: { object_type?: unknown; page_id?: unknown }
          url_struct?: { page_id?: unknown; url_title?: unknown; long_url?: unknown }[]
        }
        const pageId = numericId(post.page_info?.page_id)
        if (post.retweeted_status || post.page_info?.object_type !== 'article' || !pageId ||
            numericId(post.user?.idstr ?? post.user?.id) !== owner || typeof post.created_at !== 'string' ||
            !Array.isArray(post.url_struct)) continue
        const createdAt = Date.parse(post.created_at)
        if (!Number.isFinite(createdAt)) continue
        for (const link of post.url_struct) {
          if (numericId(link?.page_id) !== pageId || typeof link?.url_title !== 'string' || typeof link.long_url !== 'string') continue
          const url = weiboArticleUrl(link.long_url)
          if (url && new URL(url).searchParams.get('id') === pageId) articles.push({ title: link.url_title, createdAt, url })
        }
      }
      if (!result.data.list.length || !result.data.since_id) break
    }
    return articles
  }

  private async uploadImage(owner: string, image: Blob, step: string): Promise<string> {
    const query = new URLSearchParams({
      app: 'miniblog', s: 'json', p: '1', data: '1', url: '', markpos: '1', logo: '0',
      nick: '', file_source: '4', _rid: requestId(owner),
    })
    const response = await this.fetch(`${pictureOrigin}/interface/pic_upload.php?${query}`, step, {
      method: 'POST', body: image,
      headers: { Origin: new URL(weiboHome).origin, Referer: weiboHome, 'Content-Type': image.type },
    })
    const body = await this.json<{ data?: { pics?: { pic_1?: { pid?: string } } } }>(response, step)
    const pid = body.data?.pics?.pic_1?.pid
    if (typeof pid !== 'string' || !/^[a-z0-9]+$/i.test(pid)) throw new Error(`${step}失败，微博未返回图片编号。`)
    return pid
  }

  async prepareContent(
    owner: string, article: Article, readImage: (url: string) => Promise<Blob>,
    onProgress: (current: number, total: number) => void,
  ): Promise<WeiboContent> {
    let cover = ''
    const html = await replaceArticleImages(article, async (source, index, total) => {
      onProgress(index, total)
      const pid = await this.uploadImage(owner, await readImage(source), `上传微博图片 ${index}/${total}`)
      const url = `https://wx3.sinaimg.cn/large/${pid}.jpg`
      if (index === 1) cover = url
      return `<figure class="image"><img src="${url}" data-pid="${pid}"></figure>`
    })
    return { html, cover }
  }

  private async draftRequest(owner: string, action: 'create' | 'save', body: URLSearchParams, id?: string) {
    const step = action === 'create' ? '创建微博草稿' : '保存微博草稿'
    const rid = requestId(owner)
    const query = new URLSearchParams({ uid: owner, _rid: rid })
    if (id) query.set('id', id)
    const response = await this.fetch(`https://card.weibo.com/article/v5/aj/editor/draft/${action}?${query}`, step, {
      method: 'POST', body,
      headers: { Origin: new URL(weiboEditor).origin, Referer: weiboEditor, 'SN-REQID': rid, Accept: 'application/json' },
    })
    if (action === 'save' && response.status === 404) return undefined
    const result = await this.json<{ code?: string | number; msg?: string; data?: { id?: unknown } }>(response, step)
    if (String(result.code) !== '100000') {
      const detail = typeof result.msg === 'string' ? result.msg.trim().slice(0, 160) : ''
      throw new Error(`${step}失败${detail ? `：${detail}` : '，微博未确认操作。'}`)
    }
    return result
  }

  async saveDraft(
    owner: string, title: string, content: WeiboContent, existing: string | undefined,
    onDraft: (id?: string) => Promise<void>,
  ): Promise<string> {
    const known = numericId(existing)
    if (known) {
      if (await this.updateDraft(owner, known, title, content)) return known
      await onDraft()
    }
    const result = await this.draftRequest(owner, 'create', new URLSearchParams())
    const id = numericId(result?.data?.id)
    if (!id) throw new Error('创建微博草稿失败，微博未返回草稿编号。')
    await onDraft(id)
    if (!await this.updateDraft(owner, id, title, content)) {
      throw new Error('微博刚创建的草稿无法写入（HTTP 404），请重试。')
    }
    return id
  }

  private updateDraft(owner: string, id: string, title: string, content: WeiboContent) {
    return this.draftRequest(owner, 'save', new URLSearchParams({
      id, title, content: content.html, cover: content.cover, subtitle: '', type: '', status: '0',
      publish_at: '', error_msg: '', error_code: '0', collection: '[]', free_content: '', summary: '',
      writer: '', extra: 'null', is_word: '0', article_recommend: '[]', follow_to_read: '0', isreward: '0',
      pay_setting: '{"ispay":0,"isvclub":0}', source: '0', action: '1', content_type: '0', save: '1',
    }), id)
  }
}
