import { setTimeout as delay } from 'node:timers/promises'
import { uploadJuejinImage, type JuejinImage } from './juejin-images.js'
import type { Article } from './wechat.js'

export const juejinHome = 'https://juejin.cn/'
export const juejinArticles = 'https://juejin.cn/creator/content/article/essays?status=all'
const apiOrigin = 'https://api.juejin.cn'

type Request = (url: string, init: RequestInit) => Promise<Response>
type Content = { markdown: string; summary: string; images: JuejinImage[] }

export interface JuejinOption { id: string; name: string }
export interface JuejinDefaults { category: JuejinOption; tags: JuejinOption[] }
export interface JuejinPublicationStatus { id?: string; url?: string; audit?: 'reviewing' | 'rejected'; status?: string }

export const juejinDefaultsRequired = '请在「系统设置 → 默认值设置」设置分类和标签。'

interface Draft {
  id?: string
  user_id?: string
  article_id?: string
  category_id?: string
  tag_ids?: string[]
  brief_content?: string
  cover_image?: string
  link_url?: string
  is_english?: number
  is_original?: number
  is_gfw?: number
  theme_ids?: string[]
  mark_content?: string
}

interface Category {
  category_id?: string
  category_name?: string
  category?: Category
}

interface Tag { tag_id?: string; tag_name?: string; tag?: Tag }

export function juejinId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

export function parseJuejinDefaults(value: unknown): JuejinDefaults | undefined {
  const option = (input: unknown): input is JuejinOption => {
    if (!input || typeof input !== 'object') return false
    const { id, name } = input as Partial<JuejinOption>
    return juejinId(id) && typeof name === 'string' && Boolean(name.trim())
  }
  if (!value || typeof value !== 'object') return
  const { category, tags } = value as Partial<JuejinDefaults>
  if (!option(category) || !Array.isArray(tags) || !tags.length || !tags.every(option) ||
      new Set(tags.map(({ id }) => id)).size !== tags.length) return
  return { category: { id: category.id, name: category.name }, tags: tags.map(({ id, name }) => ({ id, name })) }
}

export function juejinDraftUrl(id: string): string {
  if (!juejinId(id)) throw new Error('掘金草稿编号无效。')
  return `${juejinHome}editor/drafts/${id}`
}

export function juejinArticleId(input: string, allowPreview = false): string | undefined {
  try {
    const url = new URL(input)
    if (url.origin === new URL(juejinHome).origin && !url.username && !url.password) {
      return (allowPreview ? /^\/s?post\/([1-9]\d*)\/?$/ : /^\/post\/([1-9]\d*)\/?$/).exec(url.pathname)?.[1]
    }
  } catch { /* Invalid URL. */ }
}

export function juejinArticleUrl(id: string): string {
  if (!juejinId(id)) throw new Error('掘金文章编号无效。')
  return `${juejinHome}post/${id}`
}

export function juejinReviewUrl(id: string): string {
  if (!juejinId(id)) throw new Error('掘金文章编号无效。')
  return `${juejinHome}spost/${id}`
}

export class Juejin {
  constructor(private readonly request: Request) {}

  private async api<T>(path: string, step: string, { body, query, missingStatus, allowEmpty }: {
    body?: object; query?: URLSearchParams; missingStatus?: number[]; allowEmpty?: boolean
  } = {}): Promise<T | null> {
    const url = new URL(path, apiOrigin)
    url.search = query?.toString() ?? ''
    url.searchParams.set('aid', '2608')
    const response = await this.request(url.href, {
      method: body ? 'POST' : 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(15_000), referrer: juejinHome,
      headers: { Accept: 'application/json', Origin: new URL(juejinHome).origin, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
    })
    if (missingStatus?.includes(response.status)) return null
    if (!response.ok) throw new Error(`${step}失败（HTTP ${response.status}）。`)
    const result = await response.json().catch(() => undefined) as { err_no?: unknown; data?: T | null } | undefined
    if (result?.err_no !== 0 || (!allowEmpty && result.data === undefined)) {
      const code = typeof result?.err_no === 'number' ? `（${result.err_no}）` : ''
      throw new Error(`${step}失败${code}，请在应用内检查掘金账号和创作者权限。`)
    }
    return result.data ?? null
  }

  async account(): Promise<{ id: string; name: string; canPublish?: boolean; tagLimit?: number } | null> {
    const account = await this.api<{ user_id?: string; user_name?: string; phone_verified?: boolean; can_tag_cnt?: number }>(
      '/user_api/v1/user/get', '检查掘金账号', { query: new URLSearchParams({ not_self: '0' }), missingStatus: [401] },
    )
    if (account === null) return null
    if (!juejinId(account.user_id)) throw new Error('掘金未返回有效的账号信息。')
    const count = account.can_tag_cnt
    const tagLimit = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined
    return { id: account.user_id, name: account.user_name || '掘金账号', canPublish: account.phone_verified, tagLimit }
  }

  async categories(): Promise<JuejinOption[]> {
    const rows = await this.api<Category[]>('/tag_api/v1/query_category_list', '加载掘金分类', { body: {} })
    if (!Array.isArray(rows)) throw new Error('未能加载掘金分类。')
    return rows.flatMap((row) => {
      const { category_id: id, category_name: name } = row.category ?? row
      return juejinId(id) && typeof name === 'string' && name ? [{ id, name }] : []
    })
  }

  async searchTags(query: string): Promise<JuejinOption[]> {
    const rows = await this.api<Tag[]>('/tag_api/v1/query_tag_list', '搜索掘金标签', {
      body: { cursor: '0', key_word: query.trim(), limit: 20, sort_type: 1 },
    })
    if (!Array.isArray(rows)) throw new Error('未能加载掘金标签。')
    return rows.flatMap((row) => {
      const { tag_id: id, tag_name: name } = row.tag ?? row
      return juejinId(id) && typeof name === 'string' && name ? [{ id, name }] : []
    })
  }

  async validateDefaults(defaults: JuejinDefaults, tagLimit?: number): Promise<JuejinDefaults> {
    if (tagLimit !== undefined && defaults.tags.length > tagLimit) {
      throw new Error(tagLimit ? `当前掘金账号最多可添加 ${tagLimit} 个标签，请更新发布默认值。` :
        '当前掘金账号暂时无法添加标签，请在掘金检查账号权限。')
    }
    const [categories, tags] = await Promise.all([
      this.categories(),
      Promise.all(defaults.tags.map(async ({ id, name }) => (await this.searchTags(name)).find((tag) => tag.id === id))),
    ])
    const category = categories.find(({ id }) => id === defaults.category.id)
    if (!category || tags.some((tag) => !tag)) throw new Error('所选掘金分类或标签已失效，请更新发布默认值。')
    return { category, tags: tags.filter((tag) => tag !== undefined) }
  }

  async prepareContent(article: Article, read: (url: string) => Promise<Blob>,
    progress: (completed: number, total: number) => void,
    convert: (html: string, images: string[]) => Promise<{ markdown: string; summary: string }>): Promise<Content> {
    const images = [...new Set(article.images)]
    const uploaded = new Map<string, JuejinImage>()
    for (const [index, url] of images.entries()) {
      if (index) await delay(300)
      if (index === 0) progress(0, images.length)
      try {
        const image = await uploadJuejinImage(async <T>(path: string, query: URLSearchParams) => {
          const step = path.endsWith('/gen_token') ? '获取掘金图片上传凭证' : '获取掘金图片链接'
          const result = await this.api<T>(path, step, { query })
          if (result === null) throw new Error(`${step}失败，平台未返回数据。`)
          return result
        }, this.request, await read(url))
        uploaded.set(url, image)
      } catch (error) {
        const detail = error instanceof Error ? error.message : '图片上传请求失败。'
        throw new Error(`掘金第 ${index + 1}/${images.length} 张图片失败，已确认 ${index} 张。${detail}`, { cause: error })
      }
      progress(index + 1, images.length)
    }
    const converted = await convert(article.html, article.images.map((url) => uploaded.get(url)!.pic_uri))
    if (!converted.markdown) throw new Error('未能转换掘金文章正文。')
    return { ...converted, images: [...uploaded.values()] }
  }

  async draft(id: string, owner: string): Promise<Draft | null> {
    if (!juejinId(id)) throw new Error('掘金草稿编号无效。')
    const detail = await this.api<Draft & { article_draft?: Draft; category?: Category; tags?: Tag[]; author_user_info?: { user_id?: string } }>(
      '/content_api/v1/article_draft/detail', '读取掘金草稿', {
      body: { draft_id: id }, missingStatus: [404],
    })
    if (detail === null) return null
    const draft = detail.article_draft ?? detail
    if (draft.id !== id || (draft.user_id ?? detail.author_user_info?.user_id) !== owner) {
      throw new Error('当前掘金账号无法核对这份草稿。')
    }
    const category = detail.category?.category ?? detail.category
    const tagIds = Array.isArray(detail.tags) ? detail.tags.map((row) => (row.tag ?? row).tag_id).filter(juejinId) : undefined
    return { ...draft, category_id: category?.category_id ?? draft.category_id, tag_ids: tagIds ?? draft.tag_ids }
  }

  async saveDraft(owner: string, title: string, content: Content, id: string | undefined,
    remember: (id?: string) => Promise<void>, defaults?: JuejinDefaults): Promise<string> {
    const existing = id ? await this.draft(id, owner) : null
    if (id && !existing) await remember()
    if (existing && juejinId(existing.article_id)) return existing.id!
    const fields = {
      title, mark_content: content.markdown, brief_content: existing?.brief_content || content.summary,
      category_id: defaults?.category.id ?? existing?.category_id ?? '0',
      tag_ids: defaults?.tags.map(({ id }) => id) ?? existing?.tag_ids ?? [],
      cover_image: existing?.cover_image ?? '', link_url: existing?.link_url ?? '',
      is_english: existing?.is_english, is_original: existing?.is_original, is_gfw: existing?.is_gfw,
      theme_ids: existing?.theme_ids ?? [], edit_type: 10, html_content: '', pics: content.images,
    }
    if ((await this.account())?.id !== owner) throw new Error('掘金账号已切换，请重新确认登录账号。')
    if (existing) {
      await this.api('/content_api/v1/article_draft/update', '保存掘金草稿', { body: { id, ...fields }, allowEmpty: true })
      return existing.id!
    }
    const created = await this.api<Draft>('/content_api/v1/article_draft/create', '创建掘金草稿', { body: fields })
    if (!juejinId(created?.id) || created.user_id !== owner) throw new Error('掘金未返回当前账号的有效草稿编号。')
    await remember(created.id)
    return created.id
  }

  async findArticle(draftId: string, owner: string): Promise<(JuejinPublicationStatus & { id: string }) | undefined> {
    const draft = await this.draft(draftId, owner).catch(() => null)
    if ((await this.account())?.id !== owner) return
    const fallback = juejinId(draft?.article_id) ? { id: draft.article_id } : undefined

    type Entry = { draft_id?: string; article_id?: string; article_info?: Entry; audit_status?: number }
    const auditLabels: Partial<Record<number, string>> = { '-1': '审核未通过', 1: '审核中', 3: '编辑中' }
    for (let page = 1; page <= 3; page++) {
      const rows = await this.api<Entry[]>('/content_api/v1/article/list_by_user', '核对掘金文章管理', {
        body: { page_no: page, page_size: 10, audit_status: null, status: null, keyword: '' },
      }).catch(() => null)
      if (!Array.isArray(rows)) return fallback
      for (const row of rows) {
        const entry = row.article_info ?? row
        if ((entry.draft_id ?? row.draft_id) === draftId && juejinId(entry.article_id)) {
          const status = entry.audit_status ?? row.audit_status ?? 0
          const audit = status === 1 ? 'reviewing' : status === -1 ? 'rejected' : undefined
          return { id: entry.article_id, status: auditLabels[status], audit }
        }
      }
      if (rows.length < 10) break
    }
    return fallback
  }

  async publicationStatus(draftId: string, owner: string, articleId?: string): Promise<JuejinPublicationStatus> {
    if (articleId && await this.publicArticle(articleId, draftId).catch(() => false)) {
      return { id: articleId, url: juejinArticleUrl(articleId) }
    }
    const article = await this.findArticle(draftId, owner).catch(() => undefined)
    const id = article?.id ?? articleId
    if (!id) return {}
    if (id !== articleId && await this.publicArticle(id, draftId).catch(() => false)) {
      return { id, url: juejinArticleUrl(id) }
    }
    if (article?.audit) return article
    if ((await this.account().catch(() => null))?.id === owner && await this.reviewArticle(id, draftId).catch(() => false)) {
      return { id, audit: 'reviewing', status: '审核中' }
    }
    return article ?? {}
  }

  private async articleResponse(url: string, credentials: 'omit' | 'include'): Promise<Response | undefined> {
    const response = await this.request(url, {
      credentials, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
    })
    // Electron's session.fetch may omit Response.url. Reject redirects at the request layer.
    if (response.redirected || (response.url && response.url !== url)) {
      void response.body?.cancel().catch(() => {})
      return
    }
    return response
  }

  async articleMissing(id: string): Promise<boolean> {
    const response = await this.articleResponse(juejinArticleUrl(id), 'omit').catch(() => undefined)
    void response?.body?.cancel().catch(() => {})
    return response?.status === 404 || response?.status === 410
  }

  async publicArticle(id: string, draftId: string): Promise<boolean> {
    return this.matchArticle(await this.articleResponse(juejinArticleUrl(id), 'omit'), id, draftId)
  }

  private async reviewArticle(id: string, draftId: string): Promise<boolean> {
    if (!juejinId(id)) return false
    return this.matchArticle(await this.articleResponse(juejinReviewUrl(id), 'include'), id, draftId)
  }

  private async matchArticle(response: Response | undefined, id: string, draftId: string): Promise<boolean> {
    if (!response?.ok) {
      void response?.body?.cancel().catch(() => {})
      return false
    }
    const html = await response.text()
    const article = /<article(?=\s|>)[^>]*>/i.exec(html)?.[0]
    if (!article) return false
    return new RegExp(`\\sdata-entry-id="${id}"(?=\\s|>)`).test(article) &&
      juejinId(draftId) && new RegExp(`\\sdata-draft-id="${draftId}"(?=\\s|>)`).test(article)
  }
}
