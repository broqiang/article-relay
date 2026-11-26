import { createHash } from 'node:crypto'
import type { net, Session, WebContents } from 'electron'
import type { Article } from './wechat.js'

const doubanAccountOrigin = 'https://accounts.douban.com'
export const doubanAccountUrl = `${doubanAccountOrigin}/passport/setting`

function unknownAccount(detail: string): Error {
  return new Error(`暂时无法确认豆瓣登录状态（${detail}）。请打开豆瓣账号页面检查后重试。`)
}

export function checkDoubanAccount(session: Session, request: typeof net.request): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = request({
      url: doubanAccountUrl, session, cache: 'no-store', credentials: 'include', redirect: 'manual',
    })
    const timeout = setTimeout(() => {
      reject(unknownAccount('请求超时'))
      probe.abort()
    }, 8_000)
    probe.once('close', () => clearTimeout(timeout))
    probe.on('error', reject)
    probe.once('redirect', (status, _method, url) => {
      const destination = URL.parse(url, doubanAccountUrl)
      if (destination?.origin === doubanAccountOrigin && /^\/(accounts|passport)\/login\/?$/.test(destination.pathname)) {
        resolve(false)
      } else {
        reject(unknownAccount(`HTTP ${status}`))
      }
    })
    probe.once('response', (response) => {
      if (response.statusCode === 200 && /^text\/html\b/i.test(String(response.headers['content-type'] ?? ''))) {
        resolve(true)
      } else {
        reject(unknownAccount(`HTTP ${response.statusCode}`))
      }
      probe.abort()
    })
    probe.end()
  })
}

const doubanOrigin = 'https://www.douban.com'
export const doubanPublishEndpoint = 'https://m.douban.com/rexxar/api/v2/topic/post'
const publisherApi = 'https://m.douban.com/rexxar/api/v2/group/topic/'
const editorUrl = `${doubanOrigin}/topic/create?subtype=note`

export function doubanDraftUrl(id: string): string {
  if (!/^[1-9]\d*$/.test(id)) throw new Error('豆瓣草稿编号无效。')
  return `${editorUrl}&draft_id=${id}`
}

export function doubanArticleUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const url = URL.parse(value, doubanOrigin)
  if (!url || ![doubanOrigin, 'https://douban.com'].includes(url.origin) || url.username || url.password) return
  const path = /^\/(note|topic)\/([1-9]\d*)\/?$/.exec(url.pathname)
  if (path) return `${doubanOrigin}/${path[1]}/${path[2]}/`
}

interface Photo {
  id: string | number
  url: string
  src: string
  raw_src: string
}

interface DraftBlock {
  key: string
  text: string
  type: string
  depth: number
  inlineStyleRanges: { style: string; offset: number; length: number }[]
  entityRanges: { key: number; offset: number; length: number }[]
  data: Record<string, unknown>
}

interface DraftEntity {
  type: 'IMAGE' | 'LINK' | 'SEPARATOR'
  mutability: 'MUTABLE' | 'IMMUTABLE'
  data: Record<string, unknown>
}

interface DraftContent {
  blocks: DraftBlock[]
  entityMap: Record<number, DraftEntity>
}

interface DraftProps {
  subtype: 'note'
  title: string
  content: DraftContent
  image_ids: Photo['id'][]
  image_layout?: 'vertical'
}

// Runs in the workspace renderer, which parses the imported HTML without loading its resources.
function doubanContent(html: string, images: Photo[]): DraftContent {
  const root = document.createElement('template')
  root.innerHTML = html
  const blocks: DraftBlock[] = []
  const entityMap: DraftContent['entityMap'] = {}
  let entityIndex = 0
  let imageIndex = 0
  let current: DraftBlock | undefined
  const types: Record<string, string> = {
    P: 'unstyled', DIV: 'unstyled', BLOCKQUOTE: 'blockquote', PRE: 'code-block',
    H1: 'header-one', H2: 'header-two', H3: 'header-three',
    H4: 'header-four', H5: 'header-four', H6: 'header-four',
    LI: 'unstyled', TR: 'unstyled', CAPTION: 'unstyled',
  }
  const styles: Record<string, string> = {
    STRONG: 'BOLD', EM: 'ITALIC', U: 'UNDERLINE', S: 'STRIKETHROUGH', CODE: 'CODE',
  }
  function block(type: string, depth: number): DraftBlock {
    return { key: blocks.length.toString(36).padStart(5, '0'), text: '', type, depth,
      inlineStyleRanges: [], entityRanges: [], data: {} }
  }
  function flush() {
    if (current?.text.trim()) blocks.push(current)
    current = undefined
  }
  function entity(type: DraftEntity['type'], data: DraftEntity['data']): number {
    const key = entityIndex++
    entityMap[key] = { type, data, mutability: type === 'LINK' ? 'MUTABLE' : 'IMMUTABLE' }
    return key
  }
  function append(text: string, type: string, depth: number, inline: string[], link?: string) {
    if (!current && !text.trim()) return
    current ??= block(type, depth)
    const offset = current.text.length
    current.text += text
    for (const style of inline) current.inlineStyleRanges.push({ offset, length: text.length, style })
    if (link && text.length) {
      current.entityRanges.push({ offset, length: text.length, key: entity('LINK', { url: link, title: text, display: 'inline' }) })
    }
  }
  function visit(node: Node, type = 'unstyled', depth = 0, inline: string[] = [], link?: string): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? ''
      append(type === 'code-block' ? value : value.replace(/[\t\n\r ]+/g, ' '), type, depth, inline, link)
      return
    }
    if (!(node instanceof HTMLElement)) return
    const tag = node.tagName
    if (tag === 'IMG' || tag === 'HR') {
      flush()
      const item = block('atomic', 0)
      item.text = ' '
      if (tag === 'IMG') {
        const image = images[imageIndex]
        if (!image || node.getAttribute('data-relay-image') !== String(imageIndex++)) {
          throw new Error('豆瓣正文与本地图片列表不一致。')
        }
        item.entityRanges.push({ key: entity('IMAGE', { ...image, caption: '' }), offset: 0, length: 1 })
      } else {
        item.entityRanges.push({ key: entity('SEPARATOR', {}), offset: 0, length: 1 })
      }
      blocks.push(item)
      return
    }
    if (tag === 'BR') {
      append('\n', type, depth, inline, link)
      return
    }
    const list = tag === 'UL' || tag === 'OL'
    const boundary = Object.hasOwn(types, tag) || list
    if (boundary) flush()
    let childType = types[tag] ?? type
    if (tag === 'LI') childType = node.parentElement?.tagName === 'OL' ? 'ordered-list-item' : 'unordered-list-item'
    if ((type === 'blockquote' || type.endsWith('list-item')) && (tag === 'P' || tag === 'DIV')) childType = type
    const childDepth = list && type.endsWith('list-item') ? depth + 1 : depth
    const style = styles[tag]
    const childStyles = style && !inline.includes(style) ? [...inline, style] : inline
    const href = tag === 'A' ? node.getAttribute('href') : undefined
    const childLink = href && /^https?:\/\//i.test(href) ? href : link
    for (const child of node.childNodes) visit(child, childType, childDepth, childStyles, childLink)
    if ((tag === 'TD' || tag === 'TH') && node.nextElementSibling) append('  ', childType, depth, [], undefined)
    if (boundary) flush()
  }
  for (const node of root.content.childNodes) visit(node)
  flush()
  if (imageIndex !== images.length || !blocks.some((item) => item.text.trim()) && !imageIndex) {
    throw new Error('豆瓣正文为空或缺少已上传图片。')
  }
  return { blocks, entityMap }
}

export function doubanContentScript(html: string, images: Photo[]): string {
  return `(${doubanContent.toString()})(${JSON.stringify(html)},${JSON.stringify(images)})`
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function numericId(value: unknown): string | undefined {
  const id = typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'string' ? String(value) : ''
  return /^[1-9]\d*$/.test(id) ? id : undefined
}

function contentEvidence(value: unknown): string | undefined {
  const { blocks, entityMap } = object(value)
  if (!Array.isArray(blocks) || !entityMap || typeof entityMap !== 'object') return
  let text = ''
  const evidence: string[] = []
  for (const item of blocks) {
    const { text: value, entityRanges, type } = object(item)
    if (typeof value !== 'string' || !Array.isArray(entityRanges)) return
    if (type !== 'atomic') {
      text += value
      continue
    }
    for (const range of entityRanges) {
      const { key } = object(range)
      const entity = object(object(entityMap)[String(key)])
      if (entity.type !== 'IMAGE') continue
      const image = numericId(object(entity.data).id)
      if (!image) return
      evidence.push(text.replace(/\s+/gu, ''), image)
      text = ''
    }
  }
  return JSON.stringify([...evidence, text.replace(/\s+/gu, '')])
}

function fingerprint(title: string, evidence: string | undefined): string {
  return createHash('sha256').update(JSON.stringify([title, evidence])).digest('hex')
}

export function doubanDraftFingerprint(props: DraftProps): string {
  return fingerprint(props.title, contentEvidence(props.content))
}

// The published article contains rendered HTML and uses the upload ID in each image URL.
function doubanPublishedEvidence(html: string): string | undefined {
  const root = document.createElement('template')
  root.innerHTML = html
  root.content.querySelectorAll('.image-caption-wrapper, script, style').forEach((node) => node.remove())
  const evidence: string[] = []
  let text = ''
  const nodes = document.createTreeWalker(root.content, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
    if (node instanceof HTMLImageElement) {
      const raw = node.getAttribute('src')
      const url = raw ? URL.parse(raw) : null
      const id = url && /(?:^|\.)doubanio\.com$/.test(url.hostname) &&
        /\/p([1-9]\d*)\.[a-z]+$/i.exec(url.pathname)?.[1]
      if (!id) return
      evidence.push(text.replace(/\s+/gu, ''), id)
      text = ''
    } else if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
    }
  }
  return JSON.stringify([...evidence, text.replace(/\s+/gu, '')])
}

export function doubanPublishedEvidenceScript(html: string): string {
  return `(${doubanPublishedEvidence.toString()})(${JSON.stringify(html)})`
}

export type DoubanAudit = 'reviewing' | 'rejected'

function diaryAudit(label: unknown): DoubanAudit | undefined {
  if (typeof label !== 'string') return
  if (/审核未通过|审核不通过/.test(label)) return 'rejected'
  if (/审核中|待审核/.test(label)) return 'reviewing'
}

function matchesDiary(data: Record<string, unknown>, url: string, owner: string): boolean {
  return numericId(data.id) === url.split('/').at(-2) && doubanArticleUrl(data.url) === url &&
    data.subtype === 'note' && numericId(object(data.author).id) === owner
}

type EditorAction =
  | { action: 'account' }
  | { action: 'read'; owner: string; id: string }
  | { action: 'save'; owner: string; id?: string; props: DraftProps }
  | { action: 'upload'; owner: string; type: string; bytes: string }
  | { action: 'publish'; owner: string; props: DraftProps }

// Runs in Douban's diary editor with its own session and CSRF credentials.
async function editorRequest(input: EditorAction): Promise<{ status: number; data: unknown }> {
  const here = new URL(location.href)
  if (here.origin !== 'https://www.douban.com' || here.pathname !== '/topic/create' ||
      here.searchParams.get('subtype') !== 'note') throw new Error('豆瓣日记编辑器未就绪。')
  const { user, upload_auth_token } = (window as Window & { __INIT_STATE__?: {
    user?: { id?: string | number; name?: string }; upload_auth_token?: string
  } }).__INIT_STATE__ ?? {}
  if (input.action === 'account') return { status: 200, data: user }
  if (!user?.id || String(user.id) !== input.owner) throw new Error('请先登录保存这份草稿的豆瓣账号。')
  const cookie = document.cookie.split('; ').find((item) => item.startsWith('ck='))
  if (!cookie) throw new Error('豆瓣日记会话已失效，请重新登录。')
  const ck = decodeURIComponent(cookie.slice(3))
  const api = 'https://m.douban.com/rexxar/api/v2'
  let path: string
  const options: RequestInit = {
    credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(16_000),
  }
  if (input.action === 'upload') {
    if (!upload_auth_token) throw new Error('豆瓣未提供图片上传凭据。')
    path = 'https://upload.douban.com/j/group/topic/add_photo'
    const body = new FormData()
    const bytes = Uint8Array.from(atob(input.bytes), (character) => character.charCodeAt(0))
    body.append('ck', ck)
    const extension = input.type === 'image/jpeg' ? 'jpg' : input.type.slice(6)
    body.append('image_file', new Blob([bytes], { type: input.type }), `article.${extension}`)
    body.append('primary_color', '')
    body.append('upload_auth_token', upload_auth_token)
    Object.assign(options, { method: 'POST', body })
  } else if (input.action === 'read') {
    path = `${api}/dwarf/${input.id}?${new URLSearchParams({ ck })}`
  } else {
    path = input.action === 'save' ? `${api}/dwarf/${input.id ?? 'drafts'}` : `${api}/topic/post`
    const { title, content, image_ids, image_layout, subtype } = input.props
    const body = input.action === 'save' ? { draft_props: JSON.stringify(input.props) } : {
      subtype, title, content: JSON.stringify(content), image_layout,
      image_ids: image_ids.map((id, index) => `${index + 1}_${id}`).join(','),
      accessible: 'public', original: false, explanation_types: '', reply_limit: 'A', send_status: true,
    }
    Object.assign(options, { method: 'POST', body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': ck } })
  }
  const response = await fetch(path, options)
  return { status: response.status, data: await response.json().catch(() => undefined) }
}

export class Douban {
  constructor(
    private readonly contents: WebContents,
    private readonly checkAccount: () => Promise<boolean>,
    private readonly publicFetch: (url: string, init: RequestInit) => Promise<Response>,
    private readonly accountFetch?: (url: string, init: RequestInit) => Promise<Response>,
  ) {}

  async account(): Promise<{ id: string; name: string } | undefined> {
    if (!await this.checkAccount()) return
    await this.contents.loadURL(editorUrl)
    const { data } = await this.request({ action: 'account' })
    const { id, name } = object(data)
    const owner = numericId(id)
    if (!owner || typeof name !== 'string' || !name.trim()) throw new Error('无法确认豆瓣日记账号。')
    return { id: owner, name }
  }

  private request(input: EditorAction): Promise<{ status: number; data: unknown }> {
    return this.contents.executeJavaScript(`(${editorRequest.toString()})(${JSON.stringify(input)})`)
  }

  async saveDraft(
    owner: string, article: Article, existing: string | undefined,
    onDraft: (id?: string) => Promise<void>, readImage: (url: string) => Promise<Blob>,
    uploading: (index: number, total: number) => void, convert: (html: string, images: Photo[]) => Promise<DraftContent>,
  ): Promise<{ id: string; fingerprint: string }> {
    const sources = [...new Set(article.images)]
    const photos = new Map<string, Photo>()
    for (const [index, url] of sources.entries()) {
      uploading(index + 1, sources.length)
      const file = await readImage(url)
      if (!/^image\/(jpeg|png|gif|webp|bmp)$/.test(file.type)) throw new Error('豆瓣不支持上传此图片格式。')
      const { status, data } = await this.request({
        action: 'upload', owner, type: file.type, bytes: Buffer.from(await file.arrayBuffer()).toString('base64'),
      })
      const result = object(data)
      const photo = object(result.photo)
      const address = typeof photo.url === 'string' ? URL.parse(photo.url) : null
      if (status !== 200 || result.r !== 0 || !numericId(photo.id) || !address || address.protocol !== 'https:' ||
          !/(?:^|\.)doubanio\.com$/.test(address.hostname)) throw new Error(`豆瓣未确认第 ${index + 1} 张图片上传成功。`)
      photos.set(url, { ...(photo as unknown as Photo), src: address.href, raw_src: address.href })
    }
    const content = await convert(article.html, article.images.map((url) => photos.get(url)!))
    const expected = contentEvidence(content)
    if (!expected) throw new Error('无法核对转换后的豆瓣正文。')
    const props: DraftProps = {
      subtype: 'note', title: article.title, content, image_ids: [...photos.values()].map(({ id }) => id),
      image_layout: photos.size ? 'vertical' : undefined,
    }
    let id = existing
    if (id && !await this.draft(owner, id)) {
      await onDraft()
      id = undefined
    }
    const result = await this.request({ action: 'save', owner, id, props })
    const data = object(result.data)
    const savedId = numericId(data.id)
    if (result.status !== 200 || !savedId || numericId(data.user_id) !== owner || (id && savedId !== id)) {
      throw new Error('豆瓣未确认草稿保存成功。')
    }
    await onDraft(savedId)
    const saved = await this.draft(owner, savedId)
    if (!saved || saved.title !== props.title || contentEvidence(saved.content) !== expected ||
        saved.image_ids.map(String).join(',') !== props.image_ids.map(String).join(',')) {
      throw new Error('豆瓣草稿中的标题、正文或图片与本地文章不一致。')
    }
    return { id: savedId, fingerprint: doubanDraftFingerprint(saved) }
  }

  async draft(owner: string, id: string): Promise<DraftProps | undefined> {
    doubanDraftUrl(id)
    const result = await this.request({ action: 'read', owner, id })
    const data = object(result.data)
    if (result.status === 404 && data.code === 1004) return
    if (result.status !== 200 || numericId(data.id) !== id || numericId(data.user_id) !== owner) {
      throw new Error('无法核对这份豆瓣草稿及其所属账号。')
    }
    const props = object(typeof data.draft_props === 'string' ? JSON.parse(data.draft_props) : data.draft_props)
    if (props.subtype !== 'note' || typeof props.title !== 'string' || !Array.isArray(props.image_ids) ||
        contentEvidence(props.content) === undefined) throw new Error('豆瓣草稿的正文或图片格式无法识别。')
    return props as unknown as DraftProps
  }

  private async publishedDiary(url: string, signedIn = false): Promise<Record<string, unknown>> {
    try {
      const request = signedIn ? this.accountFetch : this.publicFetch
      if (!request) return {}
      const response = await request(`${publisherApi}${url.split('/').at(-2)}`, {
        credentials: signedIn ? 'include' : 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) return object(await response.json())
      void response.body?.cancel().catch(() => {})
    } catch {
      // A failed lookup leaves the result pending.
    }
    return {}
  }

  async publicationAudit(input: string, owner: string): Promise<DoubanAudit | undefined> {
    const url = doubanArticleUrl(input)
    if (!url) return
    const data = await this.publishedDiary(url, true)
    if (matchesDiary(data, url, owner)) return diaryAudit(data.label)
  }

  async publicArticle(input: string, owner: string, match?: {
    fingerprint: string
    startedAt: string
    evidence: (html: string) => Promise<string | undefined>
  }): Promise<boolean> {
    const url = doubanArticleUrl(input)
    if (!url) return false
    try {
      const data = await this.publishedDiary(url)
      if (!matchesDiary(data, url, owner) || data.is_private !== false || diaryAudit(data.label) ||
          typeof data.content !== 'string' || !data.content.trim()) return false
      if (!match) return true
      if (typeof data.title !== 'string' || typeof data.create_time !== 'string' ||
          !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(data.create_time) ||
          !(Date.parse(data.create_time.replace(' ', 'T') + '+08:00') >= Date.parse(match.startedAt) - 2_000)) return false
      const evidence = await match.evidence(data.content)
      return evidence !== undefined && fingerprint(data.title, evidence) === match.fingerprint
    } catch {
      return false
    }
  }

  async publish(owner: string, props: DraftProps): Promise<{ url?: string; saved?: boolean; audit?: DoubanAudit }> {
    const { status, data } = await this.request({ action: 'publish', owner, props })
    const result = object(data)
    const url = doubanArticleUrl(result.url)
    if (status >= 200 && status < 300 && url && matchesDiary(result, url, owner)) {
      const audit = diaryAudit(result.label)
      return audit ? { url, audit } : { url }
    }
    const explicitError = [400, 401, 403, 413, 415, 422, 429].includes(status) &&
      typeof result.code === 'number' && result.code !== 0
    const message = typeof result.localized_message === 'string' ? result.localized_message : ''
    const rejected = explicitError && !/已(?:经)?(?:发布|提交)|审核/.test(message)
    return { saved: rejected }
  }
}
