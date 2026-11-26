import { replaceArticleImages } from './article-images.js'
import type { Article } from './wechat.js'

export const jianshuHome = 'https://www.jianshu.com/'
export const jianshuLoginUrl = new URL('sign_in', jianshuHome).href
const writer = new URL('writer', jianshuHome).href
const imageHost = 'https://upload-images.jianshu.io'

type Request = (url: string, init: RequestInit) => Promise<Response>
type DraftRef = { id: string; notebookId: string }
type Note = { id?: unknown; notebook_id?: unknown; slug?: unknown; shared?: unknown; note_type?: unknown; autosave_control?: unknown }

function numericId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value
}

export function jianshuDraftUrl({ id, notebookId }: DraftRef): string {
  if (!numericId(id) || !numericId(notebookId)) throw new Error('简书草稿编号无效。')
  return `${writer}#/notebooks/${notebookId}/notes/${id}`
}

function articleUrl(slug: unknown): string | undefined {
  if (typeof slug === 'string' && /^[a-f0-9]{12}$/i.test(slug)) return new URL(`p/${slug}`, jianshuHome).href
}

function hasDraftContent(content: string): boolean {
  return /<(?:img|audio|video|hr)\b/i.test(content) ||
    Boolean(content.replace(/<[^>]*>|&nbsp;|\u00a0/g, '').trim())
}

// Runs in the workspace renderer. The writer may normalize the stored HTML.
export function sameJianshuRichText(expected: string, stored: string): boolean {
  function read(html: string) {
    const template = document.createElement('template')
    template.innerHTML = html
    const text = (template.content.textContent ?? '').replace(/\s/g, '')
    const images = Array.from(template.content.querySelectorAll('img'), (img) => {
      const source = img.getAttribute('src')
      if (!source) return null
      try {
        const address = new URL(source, 'https://www.jianshu.com')
        if (address.protocol === 'https:' && !address.username && !address.password) {
          return address.origin + address.pathname
        }
      } catch { /* Invalid image URL. */ }
      return null
    })
    return { text, images }
  }
  const sent = read(expected)
  const saved = read(stored)
  return sent.text === saved.text && sent.images.length === saved.images.length &&
    sent.images.every((image, index) => image !== null && image === saved.images[index])
}

export function jianshuArticleUrl(input: string): string | undefined {
  try {
    const url = new URL(input)
    if (url.origin === new URL(jianshuHome).origin && !url.username && !url.password) {
      return articleUrl(/^\/p\/([^/]+)\/?$/.exec(url.pathname)?.[1])
    }
  } catch { /* Invalid URL. */ }
}

export async function checkJianshuAccount(
  request: Request,
): Promise<{ id: string; name: string } | null> {
  const response = await request(jianshuHome, {
    cache: 'no-store', credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`检查简书登录失败（HTTP ${response.status}）。`)

  const html = await response.text()
  const pageData = /<script\b[^>]*\bdata-name=["']page-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
  const invalid = '简书未返回可识别的登录状态，请在应用内打开简书后重试。'
  let data: { user_signed_in?: unknown; current_user?: { id?: unknown; nickname?: unknown } } | null
  try {
    data = pageData ? JSON.parse(pageData) : null
  } catch {
    throw new Error(invalid)
  }
  if (data?.user_signed_in === false) return null
  if (data?.user_signed_in !== true) throw new Error(invalid)
  const user = data.current_user
  const id = user?.id
  if (!(typeof id === 'string' && id.trim()) && !(Number.isSafeInteger(id) && Number(id) > 0)) {
    throw new Error(invalid)
  }
  const nickname = typeof user?.nickname === 'string' ? user.nickname.trim() : ''
  return { id: String(id), name: nickname || '简书账号' }
}

class WriterError extends Error {
  constructor(step: string, readonly status: number, readonly rejected: boolean) {
    super(`${step}失败（HTTP ${status}）。`)
  }
}

export class Jianshu {
  constructor(private readonly request: Request) {}

  account() {
    return checkJianshuAccount(this.request)
  }

  private async json<T>(url: string, step: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(url, {
      cache: 'no-store', redirect: 'error', credentials: 'include', referrer: writer,
      signal: AbortSignal.timeout(30_000), ...init,
      headers: { Accept: 'application/json', ...init.headers },
    })
    const data = await response.json().catch(() => undefined)
    const rejected = typeof data?.error === 'string' && Boolean(data.error.trim())
    if (!response.ok || rejected) throw new WriterError(step, response.status, rejected)
    if (data === undefined || data === null) throw new Error(`${step}未返回可识别的数据。`)
    return data
  }

  private api<T>(path: string, step: string, method?: 'POST' | 'PUT', data?: object): Promise<T> {
    return this.json(new URL(path, jianshuHome).href, step, method ? {
      method, headers: { 'Content-Type': 'application/json; charset=UTF-8', Origin: new URL(jianshuHome).origin },
      body: JSON.stringify(data),
    } : {})
  }

  private async requireOwner(owner: string): Promise<void> {
    const user = await this.api<{ id?: unknown }>('/author/current_user', '检查简书写作账号')
    if (numericId(user.id) !== owner) throw new Error('简书登录账号已切换，请登录原账号后重试。')
  }

  private async note({ id, notebookId }: DraftRef): Promise<Note | undefined> {
    if (!numericId(id) || !numericId(notebookId)) throw new Error('简书草稿编号无效。')
    const rows = await this.api<Note[]>(`/author/notebooks/${notebookId}/notes?page=1&count=10&nid=${id}`, '读取简书草稿')
    if (!Array.isArray(rows)) throw new Error('简书未返回可识别的文章列表。')
    const note = rows.find((row) => numericId(row?.id) === id)
    if (note?.notebook_id != null && numericId(note.notebook_id) !== notebookId) return
    return note
  }

  private async draftContent(id: string): Promise<string> {
    const result = await this.api<{ content?: unknown }>(`/author/notes/${id}/content`, '回读简书草稿正文')
    if (result.content === null) return ''
    if (typeof result.content !== 'string') throw new Error('简书未返回可核对的草稿正文。')
    return result.content
  }

  private async uploadImage(blob: Blob, index: number): Promise<string> {
    const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }
    const extension = extensions[blob.type]
    if (!extension) throw new Error('简书图片格式不受支持。')
    const filename = `image-${index}.${extension}`
    const { key, token } = await this.api<{ key?: unknown; token?: unknown }>(
      `/upload_images/token.json?filename=${filename}`, '获取简书图片上传凭证',
    )
    if (typeof key !== 'string' || !key || typeof token !== 'string' || !token) throw new Error('简书未返回有效的图片上传凭证。')
    const form = new FormData()
    form.append('token', token)
    form.append('key', key)
    form.append('file', blob, filename)
    form.append('x:protocol', 'https')
    const image = await this.json<{ url?: unknown }>('https://upload.qiniup.com', '上传简书图片', {
      method: 'POST', credentials: 'omit', body: form,
    })
    const url = typeof image.url === 'string' ? new URL(image.url, imageHost) : undefined
    if (!url || url.origin !== imageHost || url.username || url.password ||
        !/^\/upload_images\/[\w./%-]+$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('简书未返回有效的图片地址。')
    }
    return url.href
  }

  async saveDraft(owner: string, article: Article, existing: DraftRef | undefined,
    remember: (draft: DraftRef) => Promise<void>, readImage: (url: string) => Promise<Blob>,
    progress: (index: number, total: number) => void,
    contentTools: {
      toMarkdown: (html: string, images: string[]) => Promise<string>
      sameRichText: (expected: string, stored: string) => Promise<boolean>
    },
  ): Promise<DraftRef> {
    await this.requireOwner(owner)
    let draft = existing
    let note: Note | undefined
    if (draft) {
      note = await this.note(draft)
      if (!note) throw new Error('未能在原文集中找到简书草稿，请在简书写作页核对。')
      if (note.shared === true) return draft
      if (note.shared !== false) throw new Error('未能核对简书草稿的发布状态。')
    }

    const books = draft ? undefined : await this.api<{ id?: number | string }[]>('/author/notebooks', '读取简书文集')
    const bookId = Array.isArray(books) ? books[0]?.id : undefined
    const notebookId = draft?.notebookId ?? numericId(bookId)
    if (!notebookId) throw new Error('请先在简书写作页创建一个文集。')
    const uploaded = new Map<string, string>()
    const html = await replaceArticleImages(article, async (url, index, total) => {
      progress(index, total)
      try {
        const address = await this.uploadImage(await readImage(url), index)
        uploaded.set(url, address)
        return `<div class="image-package"><img src="${address}"><div class="image-caption"></div></div>`
      } catch (error) {
        const detail = error instanceof Error ? error.message : '图片上传请求失败。'
        throw new Error(`简书第 ${index}/${total} 张图片失败。${detail}`, { cause: error })
      }
    })
    if (!draft) {
      await this.requireOwner(owner)
      note = await this.api<Note>('/author/notes', '创建简书草稿', 'POST', {
        notebook_id: bookId, title: article.title, at_bottom: false,
      })
      const id = numericId(note.id)
      if (!id) throw new Error('简书未返回有效的草稿编号。')
      draft = { id, notebookId }
      await remember(draft)
      if (note.notebook_id != null && numericId(note.notebook_id) !== notebookId) {
        throw new Error('简书返回的草稿文集与所选文集不一致。')
      }
    }
    if ((note?.note_type !== 1 && note?.note_type !== 2) || !Number.isSafeInteger(note.autosave_control)) {
      note = await this.note(draft)
    }
    if (note?.shared === true) return draft
    if ((note?.note_type !== 1 && note?.note_type !== 2) || typeof note.autosave_control !== 'number' ||
        !Number.isSafeInteger(note.autosave_control) || note.autosave_control < 0 || note.autosave_control >= Number.MAX_SAFE_INTEGER) {
      throw new Error('简书未返回可识别的草稿格式或保存版本。')
    }
    const markdown = note.note_type === 2
    const content = markdown ? await contentTools.toMarkdown(article.html, article.images.map((url) => uploaded.get(url)!)) : html
    if (!hasDraftContent(content)) throw new Error('简书文章正文为空。')
    await this.requireOwner(owner)
    await this.api(`/author/notes/${draft.id}`, '保存简书草稿', 'PUT', {
      id: draft.id, autosave_control: note.autosave_control + 1, title: article.title, content,
    })
    const stored = await this.draftContent(draft.id)
    if (!hasDraftContent(stored) ||
        !(markdown ? stored.trim() === content.trim() : await contentTools.sameRichText(content, stored))) {
      throw new Error('简书草稿正文尚未保存成功，请重试同步。')
    }
    return draft
  }

  async publication(owner: string, draft: DraftRef): Promise<{ url?: string; needsContent?: boolean }> {
    await this.requireOwner(owner)
    const note = await this.note(draft)
    if (note?.shared === true) return { url: articleUrl(note.slug) }
    if (note?.shared === false) return { needsContent: !hasDraftContent(await this.draftContent(draft.id)) }
    return {}
  }

  async publish(owner: string, draft: DraftRef): Promise<{ url?: string; saved?: boolean; needsContent?: boolean }> {
    let note: Note | undefined
    try {
      await this.requireOwner(owner)
      note = await this.note(draft)
      if (note?.shared === false) {
        if (!hasDraftContent(await this.draftContent(draft.id))) return { needsContent: true }
        await this.requireOwner(owner)
      }
    } catch {
      return { saved: true }
    }
    if (!note) return {}
    if (note.shared === true) return { url: articleUrl(note.slug) }
    if (note.shared !== false) return {}
    try {
      await this.api(`/author/notes/${draft.id}/publicize`, '提交简书文章', 'POST', {})
    } catch (error) {
      // A timeout or malformed response can still follow a successful submission.
      const current = await this.requireOwner(owner).then(() => this.note(draft)).catch(() => undefined)
      if (current?.shared === true) return { url: articleUrl(current.slug) }
      return { saved: current?.shared === false && error instanceof WriterError && error.rejected &&
        [400, 401, 403, 422, 429].includes(error.status) }
    }
    const { url } = await this.publication(owner, draft)
    return { url }
  }
}
