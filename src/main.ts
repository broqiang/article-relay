import { app, BrowserWindow, ipcMain, protocol, session, shell, type Session, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromiumUserAgent } from './browser.js'
import { errorMessage, TaskStore, type SyncRun, type Task } from './tasks.js'
import { inspectWeChatScript, wechatArticleUrl, type PageResult } from './wechat.js'
import { articleUrl, draftUrl, Zhihu } from './zhihu.js'
import { checkZhihuArticle, publishZhihuDraft, type PublishResult } from './zhihu-publish.js'

const workspaceUrl = 'relay://workspace/index.html'
const zhihuLoginUrl = 'https://www.zhihu.com/signin'
const releasesUrl = 'https://github.com/broqiang/article-relay/releases'
const workspaceAssets = new Map([
  ['/index.html', 'text/html'],
  ['/styles.css', 'text/css'],
  ['/app.js', 'text/javascript'],
  ['/icon.svg', 'image/svg+xml'],
])

protocol.registerSchemesAsPrivileged([{
  scheme: 'relay',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}])

function serveWorkspace(): void {
  protocol.handle('relay', async (request) => {
    const url = new URL(request.url)
    const type = workspaceAssets.get(url.pathname)
    if (request.method !== 'GET' || url.host !== 'workspace' || !type) {
      return new Response(null, { status: 404 })
    }
    const body = await readFile(join(__dirname, '..', 'ui', url.pathname.slice(1)), 'utf8')
    return new Response(body, {
      headers: { 'Content-Type': `${type}; charset=utf-8` },
    })
  })
}

function siteView(browserSession: Session, origins: string[], backgroundThrottling = true): WebContentsView {
  browserSession.setUserAgent(chromiumUserAgent(browserSession.getUserAgent()))
  const view = new WebContentsView({ webPreferences: {
    session: browserSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    backgroundThrottling,
  } })
  const contents = view.webContents
  function allowed(url: string): boolean {
    try { return origins.includes(new URL(url).origin) } catch { return false }
  }

  contents.on('will-navigate', (event) => {
    if (!allowed(event.url)) event.preventDefault()
  })
  contents.on('will-redirect', (event) => {
    if (event.isMainFrame && !allowed(event.url)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (allowed(url)) setImmediate(() => {
      if (!contents.isDestroyed()) void contents.loadURL(url).catch(() => {})
    })
    return { action: 'deny' }
  })
  browserSession.setPermissionCheckHandler(() => false)
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  browserSession.on('will-download', (event) => event.preventDefault())
  return view
}

interface Action {
  taskId?: string
  runId?: string
  url?: string
  refresh?: boolean
}

async function createWindow(): Promise<void> {
  const tasks = await TaskStore.open(app.getPath('userData'))
  const window = new BrowserWindow({
    width: 1160, height: 800, minWidth: 900, minHeight: 660,
    backgroundColor: '#f3f5f9', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true },
  })
  window.webContents.on('preload-error', (_event, _path, error) => {
    console.error('文章同步：应用通信脚本加载失败。', error)
  })
  window.webContents.on('render-process-gone', (_event, { reason, exitCode }) => {
    console.error('文章同步：界面进程退出。', { reason, exitCode })
  })
  window.webContents.on('console-message', ({ level, message, sourceId, lineNumber }) => {
    if (level === 'error') console.error(`文章同步：界面错误（${sourceId}:${lineNumber}）`, message)
  })
  const wechatSession = session.fromPartition('persist:wechat')
  const sourceView = siteView(wechatSession, ['https://mp.weixin.qq.com'])
  const zhihuSession = session.fromPartition('persist:zhihu')
  const zhihuView = siteView(zhihuSession, ['https://www.zhihu.com', 'https://zhuanlan.zhihu.com'], false)
  const zhihu = new Zhihu((url, init) => zhihuSession.fetch(url, init))
  let activeView: WebContentsView | undefined
  let sourceTask: string | undefined
  let busy = false

  function resizeBrowser(view = activeView): void {
    const [width, height] = window.getContentSize()
    // Keep the workspace controls and the browser toolbar visible above/beside the view.
    view?.setBounds({ x: 340, y: 132, width: Math.max(1, width - 364), height: Math.max(1, height - 156) })
  }

  function show(view?: WebContentsView, label = ''): void {
    if (window.isDestroyed()) return
    if (activeView !== view) {
      if (activeView) window.contentView.removeChildView(activeView)
      activeView = view
      if (view) window.contentView.addChildView(view)
      resizeBrowser()
    }
    window.webContents.send('relay:browser', label)
  }

  async function readArticle(): Promise<PageResult> {
    const tries = 13
    for (let attempt = 0; attempt < tries; attempt++) {
      const pageUrl = sourceView.webContents.getURL()
      if (!pageUrl || new URL(pageUrl).origin !== 'https://mp.weixin.qq.com') {
        throw new Error('请先打开微信公众号文章。')
      }
      const result = await sourceView.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: inspectWeChatScript }]) as PageResult
      if (result.state === 'verification') {
        return { state: 'verification' as const }
      }
      if (result.state === 'carousel-pending' && attempt + 1 === tries) return result
      if (result.state === 'unsupported-image') throw new Error('正文中有无法导入的图片地址，请检查原文。')
      if (result.state === 'article') {
        if (result.hasCover && !result.article.images.length && attempt < 3) {
          await delay(400)
          continue
        }
        return { ...result, article: { ...result.article, sourceUrl: wechatArticleUrl(pageUrl) } }
      }
      if (attempt + 1 < tries) await delay(400)
    }
    return { state: 'missing' as const }
  }

  function progress(taskId: string, message: string): void {
    if (!window.isDestroyed()) window.webContents.send('relay:progress', taskId, message)
  }

  function notifyTasks(selected?: string): void {
    if (!window.isDestroyed()) window.webContents.send('relay:tasks-changed', tasks.list(), selected)
  }

  async function updateTask(id: string, changes: Partial<Omit<Task, 'id' | 'updatedAt'>>): Promise<void> {
    await tasks.update(id, changes)
    notifyTasks()
  }

  function selectedTask(action?: Action): Task {
    return tasks.get(action?.taskId ?? '')
  }

  async function fetchImages(id: string): Promise<void> {
    await tasks.downloadImages(id, (url, init) => wechatSession.fetch(url, init), () => notifyTasks())
  }

  async function readSource(taskId: string): Promise<void> {
    const result = await readArticle()
    if (result.state !== 'article') {
      const detail = result.state === 'verification'
        ? '请在公众号页面完成微信验证，再点击「继续读取文章」。'
        : result.state === 'carousel-pending'
          ? `轮播只读到 ${result.loaded}/${result.total} 张图。请等原文加载后继续。`
          : '暂时没有读到正文。请确认右侧原文已加载后继续。'
      await updateTask(taskId, { importState: 'paused', importDetail: detail })
      return
    }
    const { article } = result
    const extraction = `提取到 ${article.images.length - result.carouselImages} 张正文图片` +
      (result.carouselImages ? `和 ${result.carouselImages} 张轮播图片。` : '。')
    await updateTask(taskId, {
      article, title: article.title, extraction, importState: 'downloading', importDetail: '正文已读取，正在检查本地原图。',
    })
    sourceTask = undefined
    show()
    await fetchImages(taskId)
  }

  async function failImport(taskId: string, error: unknown): Promise<never> {
    if (tasks.get(taskId).importState !== 'failed') {
      await updateTask(taskId, { importState: 'failed', importDetail: errorMessage(error) })
    }
    throw error
  }

  async function beginImport(task: Task, refresh: boolean): Promise<void> {
    notifyTasks(task.id)
    try {
      if (task.article && !refresh) {
        show()
        return await fetchImages(task.id)
      }
      await updateTask(task.id, { importState: 'reading', importDetail: '正在打开公众号文章…' })
      sourceTask = task.id
      show(sourceView, '公众号原文')
      await sourceView.webContents.loadURL(task.sourceUrl)
      await readSource(task.id)
    } catch (error) {
      await failImport(task.id, error)
    }
  }

  async function writeRun(taskId: string, run: SyncRun, missingId?: string): Promise<void> {
    const other = tasks.get(taskId).runs.filter((item) => item.id !== run.id).map((item) =>
      missingId && item.owner === run.owner && item.draftId === missingId ? { ...item, draftMissing: true } : item)
    await updateTask(taskId, { runs: [run, ...other] })
  }

  function assertCanPublish(task: Task, owner: string): void {
    const prior = task.runs.find((run) => run.owner === owner &&
      ['publishing', 'published', 'publish-uncertain'].includes(run.state))
    if (prior?.state === 'published') throw new Error('这篇文章已用当前知乎账号发布，可在同步记录中查看。')
    if (prior) throw new Error('上一次发布的结果尚未确认，请先在知乎核对。')
  }

  function articleRun(task: Task, runId?: string): SyncRun & { draftId: string } {
    const run = task.runs.find((item) => item.id === runId)
    if (!run?.draftId || (run.state !== 'published' && run.state !== 'publish-uncertain')) {
      throw new Error('这次同步没有可查看的文章链接。')
    }
    return { ...run, draftId: run.draftId }
  }

  async function recordPublished(taskId: string, run: SyncRun & { draftId: string }) {
    await writeRun(taskId, { ...run, state: 'published', finishedAt: new Date().toISOString(), error: undefined })
    return { publishedUrl: articleUrl(run.draftId) }
  }

  async function publishSaved(taskId: string, run: SyncRun & { draftId: string }) {
    assertCanPublish(tasks.get(taskId), run.owner)
    await writeRun(taskId, { ...run, state: 'publishing', finishedAt: undefined, error: undefined })
    progress(taskId, '正在提交知乎文章…')
    show()
    resizeBrowser(zhihuView)
    let result: PublishResult
    try {
      result = await publishZhihuDraft(zhihuView.webContents, run.draftId)
      if (result === 'uncertain') {
        progress(taskId, '正在核对知乎发布结果…')
        if (await checkZhihuArticle(zhihuView.webContents, run.draftId)) result = 'published'
      }
    } catch {
      result = 'uncertain'
    }
    if (result === 'published') return recordPublished(taskId, run)
    const error = result === 'manual'
      ? '未能自动提交。草稿已保留，你可以打开草稿，在知乎编辑器中检查并发布。'
      : '知乎发布结果尚未确认。请在知乎核对文章状态，避免重复发布。'
    await writeRun(taskId, {
      ...run, state: result === 'manual' ? 'saved' : 'publish-uncertain', finishedAt: new Date().toISOString(), error,
    })
    return { publishNotice: error }
  }

  function serial<T>(work: () => Promise<T>): Promise<T> {
    if (busy) return Promise.reject(new Error('请等当前操作完成。'))
    busy = true
    return work().finally(() => { busy = false })
  }

  const handlers = {
    'relay:version': () => app.getVersion(),
    'relay:open-releases': async () => {
      try {
        await shell.openExternal(releasesUrl)
      } catch {
        throw new Error(`无法打开系统浏览器，请手动访问 ${releasesUrl}`)
      }
    },
    'relay:restart': () => {
      if (busy) throw new Error('请等当前操作完成。')
      app.relaunch()
      app.quit()
    },
    'relay:open-zhihu': async () => {
      show(zhihuView, '知乎账号')
      const contents = zhihuView.webContents
      const current = contents.getURL()
      if (!current || current === 'about:blank' || current.startsWith('chrome-error:')) {
        await contents.loadURL(zhihuLoginUrl)
      } else {
        const url = new URL(current)
        if (url.origin === 'https://www.zhihu.com' && /^\/(signin|signup)\/?$/.test(url.pathname)) {
          await contents.loadURL(current)
        }
      }
    },
    'relay:account': async () => ({ name: (await zhihu.account())?.name ?? null }),
    'relay:tasks': () => tasks.list(),
    'relay:delete-task': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const result = await tasks.delete(task.id)
      if (sourceTask === task.id) sourceTask = undefined
      show()
      notifyTasks()
      return result
    }),
    'relay:import': (action?: Action) => serial(async () => {
      if (action?.taskId) return beginImport(selectedTask(action), action.refresh === true)
      if (typeof action?.url !== 'string') throw new Error('请输入微信公众号文章链接。')
      let url: string
      try { url = wechatArticleUrl(action.url) } catch { throw new Error('请输入有效的微信公众号文章链接。') }
      await beginImport(await tasks.findOrCreate(url), false)
    }),
    'relay:read': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      if (sourceTask !== task.id) return beginImport(task, true)
      try {
        show(sourceView, '公众号原文')
        await updateTask(task.id, { importState: 'reading', importDetail: '正在读取公众号文章…' })
        await readSource(task.id)
      } catch (error) {
        await failImport(task.id, error)
      }
    }),
    'relay:hide-browser': () => show(),
    'relay:show-draft': (action?: Action) => serial(async () => {
      const run = selectedTask(action).runs.find((item) => item.id === action?.runId)
      if (run?.state !== 'saved' || !run.error || run.draftMissing || !run.draftId) {
        throw new Error('这次发布没有可打开的草稿。')
      }
      const account = await zhihu.account()
      if (!account || run.owner !== account.id) {
        throw new Error('请先登录保存这份草稿的知乎账号。')
      }
      show(zhihuView, '知乎草稿编辑器')
      await zhihuView.webContents.loadURL(draftUrl(run.draftId))
    }),
    'relay:show-article': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = articleRun(task, action?.runId)
      if (run.state === 'publish-uncertain') {
        progress(task.id, '正在核对知乎发布结果…')
        if (await checkZhihuArticle(zhihuView.webContents, run.draftId)) return recordPublished(task.id, run)
      }
      try {
        await shell.openExternal(articleUrl(run.draftId))
      } catch {
        throw new Error('无法打开系统浏览器。你可以复制同步记录中的文章链接后访问。')
      }
      return { articleOpened: true, needsConfirmation: run.state === 'publish-uncertain' }
    }),
    'relay:mark-published': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = articleRun(task, action?.runId)
      return run.state === 'published' ? { publishedUrl: articleUrl(run.draftId) } : recordPublished(task.id, run)
    }),
    'relay:publish': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const article = task.article
      if (!article || task.importState !== 'ready') throw new Error('请先完成公众号文章导入。')
      const startedAt = new Date().toISOString()
      const base: SyncRun = { id: randomUUID(), platform: 'zhihu', owner: '', account: '账号未确认', startedAt, state: 'running' }
      progress(task.id, '正在检查知乎登录状态…')
      let account
      try {
        account = await zhihu.account()
      } catch (error) {
        await writeRun(task.id, { ...base, finishedAt: new Date().toISOString(), state: 'failed', error: errorMessage(error) })
        throw error
      }
      if (!account) {
        await writeRun(task.id, { ...base, finishedAt: new Date().toISOString(), state: 'failed', error: '请先在应用内登录知乎。' })
        return { loginRequired: true }
      }
      assertCanPublish(task, account.id)
      const owned = task.runs.filter((run) => run.owner === account.id && run.draftId && !run.draftMissing)
      const existing = owned[0]?.draftId
      const saved = owned.find((run) => run.draftId === existing && run.state === 'saved')
      if (existing && saved) return publishSaved(task.id, { ...saved, draftId: existing })

      let run: SyncRun = { ...base, owner: account.id, account: account.name, draftId: existing }
      await writeRun(task.id, run)
      let draftId: string
      try {
        const content = await zhihu.prepareContent(article, (url) => tasks.readImage(task.id, url), (index, total) => {
          progress(task.id, `正在上传本地原图 ${index}/${total}…`)
        })
        progress(task.id, '正在保存知乎草稿…')
        draftId = await zhihu.saveDraft(article.title, content, existing, async (id) => {
          const missingId = !id ? run.draftId : undefined
          run = { ...run, draftId: id }
          await writeRun(task.id, run, missingId)
          if (missingId) progress(task.id, '原草稿已失效，正在新建知乎草稿…')
        })
      } catch (error) {
        await writeRun(task.id, { ...run, state: 'failed', error: errorMessage(error), finishedAt: new Date().toISOString() })
        throw error
      }
      const savedRun: SyncRun & { draftId: string } = { ...run, draftId, state: 'saved', finishedAt: new Date().toISOString() }
      await writeRun(task.id, savedRun)
      return publishSaved(task.id, savedRun)
    }),
  }

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, argument?: Action) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame.url !== workspaceUrl) {
        throw new Error('请求来自无效的页面。')
      }
      return handler(argument)
    })
  }

  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.on('resize', () => resizeBrowser())
  window.on('closed', () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    for (const view of [sourceView, zhihuView]) view.webContents.close()
  })
  await window.loadURL(workspaceUrl)
  const initialized = await window.webContents.executeJavaScript(`
    if (document.documentElement.dataset.relayReady === 'true') {
      true
    } else {
      document.getElementById('account-name').textContent = '应用界面启动失败'
      document.getElementById('status').textContent = '界面未能加载，请查看启动终端中的错误信息。'
      document.getElementById('status').classList.add('error')
      false
    }
  `)
  if (!initialized) console.error('文章同步：界面脚本未完成初始化。')
}

app.setName('文章同步')
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(() => {
    serveWorkspace()
    return createWindow()
  }).catch((error) => {
    console.error(error)
    app.quit()
  })
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('window-all-closed', () => app.quit())
}
