import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, openAsBlob } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { parseJuejinDefaults, type JuejinDefaults } from './juejin.js'
import { wechatArticleUrl, type Article } from './wechat.js'

export type ImportState = 'pending' | 'reading' | 'paused' | 'downloading' | 'ready' | 'failed'

export const platformNames = { zhihu: '知乎', weibo: '微博', juejin: '掘金', jianshu: '简书' } as const
export type Platform = keyof typeof platformNames

export interface SyncRun {
  id: string
  platform: Platform
  owner: string
  account: string
  startedAt: string
  finishedAt?: string
  state: 'running' | 'saved' | 'failed' | 'publishing' | 'published' | 'publish-uncertain'
  draftId?: string
  jianshuNotebookId?: string
  articleId?: string
  articleTitle?: string
  publishedUrl?: string
  manualHandoff?: boolean
  draftMissing?: boolean
  juejinAudit?: 'reviewing' | 'rejected'
  juejinAutoCheckStopped?: boolean
  error?: string
}

export function canCheckJuejinAudit(run: SyncRun): run is SyncRun & { draftId: string } {
  return run.platform === 'juejin' && run.state === 'publish-uncertain' && Boolean(run.draftId) && !run.draftMissing &&
    !run.juejinAutoCheckStopped && run.juejinAudit !== 'rejected'
}

export function canOpenDraft(run: SyncRun, runs: SyncRun[]): run is SyncRun & { draftId: string } {
  if (!run.draftId || run.draftMissing || (run.platform === 'jianshu' && !run.jianshuNotebookId)) return false
  const related = runs.filter((item) => item.platform === run.platform && item.draftId === run.draftId)
  if (related.some((item) => item.state === 'published' || item.state === 'publishing' ||
      (item.platform === 'juejin' && (item.articleId || item.juejinAudit)))) return false
  if (run.state === 'saved') return !related.some((item) => item.state === 'publish-uncertain')
  return run.state === 'publish-uncertain' &&
    Boolean(run.manualHandoff || run.platform === 'zhihu' || run.platform === 'juejin' || run.platform === 'jianshu')
}

export function blockingPublication(runs: SyncRun[], platform: Platform): SyncRun | undefined {
  return runs.find((run) => run.platform === platform && run.state === 'published') ??
    runs.find((run) => run.platform === platform && ['publishing', 'publish-uncertain'].includes(run.state))
}

export function clearPublishedRun(runs: SyncRun[], publication: SyncRun): SyncRun[] {
  return runs.filter((run) => run.id !== publication.id &&
    !(run.platform === publication.platform && run.owner === publication.owner &&
      run.draftId === publication.draftId && run.state !== 'published' && run.state !== 'publish-uncertain'))
}

interface LocalImage {
  url: string
  name: string
  type: string
  bytes: number
}

interface LegacyDraft {
  id: string
  owner: string
  source: string
  title: string
  saved: boolean
}

export interface Task {
  id: string
  sourceUrl: string
  title: string
  updatedAt: string
  article?: Article
  extraction?: string
  images: LocalImage[]
  importState: ImportState
  importDetail: string
  runs: SyncRun[]
}

type BatchState = 'published' | 'already-published' | 'login-required' | 'needs-check' | 'reviewing' | 'saved' | 'failed'

export async function publishMissingPlatforms(
  getTask: () => Task,
  publish: (task: Task, platform: Platform) => Promise<{
    published?: boolean; loginRequired?: boolean; saved?: boolean; reviewing?: boolean; publishNotice?: string
  }>,
): Promise<{ platform: Platform; state: BatchState; detail?: string }[]> {
  const task = getTask()
  if (task.importState !== 'ready' || !task.article) throw new Error('请先完成公众号文章导入。')
  const outcomes: { platform: Platform; state: BatchState; detail?: string }[] = []
  for (const platform of Object.keys(platformNames) as Platform[]) {
    const current = getTask()
    const prior = blockingPublication(current.runs, platform)
    if (prior) {
      outcomes.push({ platform, state: prior.state === 'published' ? 'already-published' :
        prior.juejinAudit === 'reviewing' ? 'reviewing' : 'needs-check' })
      continue
    }
    try {
      const result = await publish(current, platform)
      const state = result.published ? 'published' : result.loginRequired ? 'login-required' : result.saved ? 'saved' :
        result.reviewing ? 'reviewing' :
        blockingPublication(getTask().runs, platform) ? 'needs-check' : 'failed'
      outcomes.push({ platform, state, detail: result.publishNotice })
    } catch (error) {
      const pending = blockingPublication(getTask().runs, platform)
      outcomes.push({ platform, state: pending ? 'needs-check' : 'failed', detail: errorMessage(error) })
    }
  }
  return outcomes
}

type ImageRequest = (url: string, init: RequestInit) => Promise<Response>

const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sourceKey(input: string): string {
  const url = new URL(wechatArticleUrl(input))
  if (url.pathname !== '/s') return `${url.origin}${url.pathname}`
  const identity = ['__biz', 'mid', 'idx'].map((key) => url.searchParams.get(key))
  if (identity.every(Boolean)) return `${url.origin}/s:${JSON.stringify(identity)}`
  url.searchParams.sort()
  return url.href
}

function newTask(url: string): Task {
  return {
    id: sha256(sourceKey(url)), sourceUrl: url, title: '', updatedAt: new Date().toISOString(),
    images: [], importState: 'pending', importDetail: '等待导入文章。', runs: [],
  }
}

async function readOptional(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function parseLegacyDraft(content: string | undefined): LegacyDraft | undefined {
  if (!content) return
  try {
    const draft: LegacyDraft = JSON.parse(content)
    if (typeof draft.id === 'string' && /^\d+$/.test(draft.id) && typeof draft.owner === 'string' &&
        typeof draft.title === 'string' && typeof draft.saved === 'boolean') {
      return { ...draft, source: wechatArticleUrl(draft.source) }
    }
  } catch {
    console.warn('无法读取旧版草稿记录。')
  }
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, data, { mode: 0o600 })
  await rename(temporary, path)
}

export function taskSummary(task: Task) {
  const urls = [...new Set(task.article?.images ?? [])]
  return {
    id: task.id, sourceUrl: task.sourceUrl, title: task.title, updatedAt: task.updatedAt,
    importState: task.importState, importDetail: task.importDetail, extraction: task.extraction,
    total: urls.length, downloaded: urls.filter((url) => task.images.some((image) => image.url === url)).length,
    hasArticle: Boolean(task.article),
    runs: task.runs.map((item) => {
      const { owner: _owner, ...run } = item
      return { ...run, canOpenDraft: canOpenDraft(item, task.runs) }
    }),
  }
}

export class TaskStore {
  private constructor(private readonly root: string, private tasks: Task[]) {}

  static async open(root: string): Promise<TaskStore> {
    await mkdir(root, { recursive: true })
    const index = await readOptional(join(root, 'tasks.json'))
    const tasks = index === undefined ? [] : JSON.parse(index) as Task[]
    if (!Array.isArray(tasks)) throw new Error('无法读取本地任务记录。')
    const store = new TaskStore(root, tasks)
    if (index === undefined) {
      const legacy = join(root, 'last-draft.json')
      const draft = parseLegacyDraft(await readOptional(legacy))
      if (draft) {
        const task = newTask(draft.source)
        const time = (await stat(legacy)).mtime.toISOString()
        task.title = draft.title
        task.updatedAt = time
        task.importDetail = '已保留旧版草稿链接，首次同步前需导入本地素材。'
        task.runs.push({
          id: randomUUID(), platform: 'zhihu', owner: draft.owner, account: '原知乎账号',
          startedAt: time, finishedAt: time, state: draft.saved ? 'saved' : 'failed', draftId: draft.id,
          error: draft.saved ? undefined : '旧版草稿未完成，可以在导入素材后重试。',
        })
        await store.commit([task])
      }
    } else {
      let interrupted = false
      for (const task of tasks) {
        if (task.importState === 'reading' || task.importState === 'downloading') {
          task.importState = 'failed'
          task.importDetail = '上次导入中断，可以继续导入。'
          interrupted = true
        }
        for (const run of task.runs) {
          if (run.state === 'publishing') {
            run.state = 'publish-uncertain'
            run.finishedAt = new Date().toISOString()
            run.error = `应用退出时尚未确认发布结果，请先在${platformNames[run.platform]}核对。`
            interrupted = true
            continue
          }
          if (run.state !== 'running') continue
          run.state = 'failed'
          run.finishedAt = new Date().toISOString()
          run.error = '应用退出时同步尚未完成，可以重试。'
          interrupted = true
        }
      }
      if (interrupted) await store.commit(tasks)
    }
    return store
  }

  list() {
    return this.tasks.map(taskSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private async readJuejinDefaults(): Promise<Record<string, unknown>> {
    const content = await readOptional(join(this.root, 'juejin-defaults.json'))
    if (content === undefined) return {}
    const records: unknown = JSON.parse(content)
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('无法读取掘金发布默认值。')
    return records as Record<string, unknown>
  }

  async juejinDefaults(owner: string): Promise<JuejinDefaults | undefined> {
    return parseJuejinDefaults((await this.readJuejinDefaults())[owner])
  }

  async saveJuejinDefaults(owner: string, defaults: JuejinDefaults): Promise<void> {
    const records = await this.readJuejinDefaults()
    await atomicWrite(join(this.root, 'juejin-defaults.json'), JSON.stringify({ ...records, [owner]: defaults }))
  }

  get(id: string): Task {
    const task = this.tasks.find((candidate) => candidate.id === id)
    if (!task) throw new Error('找不到这条任务记录。')
    return task
  }

  async findOrCreate(input: string): Promise<Task> {
    const task = newTask(wechatArticleUrl(input))
    const existing = this.tasks.find((candidate) => candidate.id === task.id)
    if (existing) return existing
    await this.commit([...this.tasks, task])
    return task
  }

  async update(id: string, changes: Partial<Omit<Task, 'id' | 'updatedAt'>>): Promise<Task> {
    const updated = { ...this.get(id), ...changes, updatedAt: new Date().toISOString() }
    await this.commit(this.tasks.map((task) => task.id === id ? updated : task))
    return updated
  }

  async clearJuejinPublicationHistory(id: string, runId: string): Promise<void> {
    const task = this.get(id)
    const records = task.runs.filter((run) => run.platform === 'juejin')
    if (!records.some((run) => run.id === runId) ||
        records.some((run) => !['saved', 'failed', 'publish-uncertain'].includes(run.state))) {
      throw new Error('当前无法清理掘金本地发布记录。')
    }
    await this.update(id, { runs: task.runs.filter((run) => run.platform !== 'juejin') })
  }

  async delete(id: string): Promise<{ mediaRemoved: boolean }> {
    if (!/^[a-f\d]{64}$/.test(id)) throw new Error('无效的任务编号。')
    const task = this.get(id)
    await this.commit(this.tasks.filter((candidate) => candidate !== task))
    try {
      await rm(join(this.root, 'media', id), { recursive: true, force: true })
      return { mediaRemoved: true }
    } catch {
      return { mediaRemoved: false }
    }
  }

  private async commit(tasks: Task[]): Promise<void> {
    await atomicWrite(join(this.root, 'tasks.json'), JSON.stringify(tasks, null, 2))
    this.tasks = tasks
  }

  private imagePath(id: string, image: LocalImage): string {
    if (!/^[a-f\d]{64}$/.test(id) || !/^[a-f\d]{64}\.(jpg|png|gif|webp)$/.test(image.name)) {
      throw new Error('本地图片文件名无效。')
    }
    return join(this.root, 'media', id, image.name)
  }

  private async hasFile(id: string, image: LocalImage): Promise<boolean> {
    try {
      const file = await stat(this.imagePath(id, image))
      return file.isFile() && file.size > 0 && file.size === image.bytes
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }

  async readImage(id: string, url: string): Promise<Blob> {
    const image = this.get(id).images.find((item) => item.url === url)
    if (!image || !await this.hasFile(id, image)) throw new Error('本地原图缺失，请先重新完成文章导入。')
    return openAsBlob(this.imagePath(id, image), { type: image.type })
  }

  async downloadImages(id: string, request: ImageRequest, onChange: () => void): Promise<Task> {
    const task = this.get(id)
    if (!task.article) throw new Error('请先读取公众号正文。')
    const urls = [...new Set(task.article.images)]
    const available = new Map<string, LocalImage>()
    for (const image of task.images) {
      if (urls.includes(image.url) && await this.hasFile(id, image)) available.set(image.url, image)
    }
    if (task.importState === 'ready' && available.size === urls.length) return task
    try {
      for (const [index, url] of urls.entries()) {
        if (available.has(url)) continue
        const step = `图片 ${index + 1}/${urls.length}`
        await this.update(id, { importState: 'downloading', importDetail: `正在下载${step}…`, images: [...available.values()] })
        onChange()
        const asset = await this.downloadImage(id, url, request, step)
        available.set(url, asset)
        await this.update(id, { images: [...available.values()] })
        onChange()
      }
      const completed = await this.update(id, {
        importState: 'ready', importDetail: urls.length ? `已保存正文和 ${urls.length} 张原图。` : '已保存正文。',
        images: [...available.values()],
      })
      onChange()
      return completed
    } catch (error) {
      await this.update(id, { importState: 'failed', importDetail: errorMessage(error), images: [...available.values()] })
      onChange()
      throw error
    }
  }

  private async downloadImage(id: string, url: string, request: ImageRequest, step: string): Promise<LocalImage> {
    const address = new URL(url)
    if (address.protocol !== 'https:' || address.port || address.username || address.password ||
        !/(?:^|\.)(?:qpic\.cn|qlogo\.cn|wx\.qq\.com)$/.test(address.hostname)) {
      throw new Error(`${step}的公众号图片地址无效。`)
    }
    let response: Response
    try {
      response = await request(url, {
        credentials: 'omit', redirect: 'error', referrer: 'https://mp.weixin.qq.com/',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error(`下载${step}时连接失败或超时。`)
    }
    if (!response.ok) throw new Error(`下载${step}失败（HTTP ${response.status}）。`)
    const type = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? ''
    const extension = extensions[type]
    if (!extension || !response.body) throw new Error(`${step}未返回可保存的图片文件。`)
    const image = { url, name: `${sha256(url)}.${extension}`, type, bytes: 0 }
    const path = this.imagePath(id, image)
    const temporary = `${path}.tmp`
    await mkdir(join(this.root, 'media', id), { recursive: true })
    try {
      await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), createWriteStream(temporary, { mode: 0o600 }))
      image.bytes = (await stat(temporary)).size
      if (!image.bytes) throw new Error('原图为空文件。')
      await rename(temporary, path)
      return image
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw new Error(`下载${step}失败：${errorMessage(error)}`)
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
