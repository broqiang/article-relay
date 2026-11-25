import { app, BrowserWindow, ipcMain, protocol, session, shell, type Session, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromiumUserAgent, publicationUrlStatus } from './browser.js'
import { blockingPublication, clearPublishedRun, errorMessage, platformNames, publishMissingPlatforms, TaskStore, type Platform, type SyncRun, type Task } from './tasks.js'
import { inspectWeChatScript, wechatArticleUrl, type PageResult } from './wechat.js'
import { Weibo, findWeiboPublishedUrl, isWeiboSsoCallback, weiboArticleUrl, weiboDraftUrl, weiboEditor, weiboHistoryUrl, weiboHome, type WeiboAccount } from './weibo.js'
import { checkWeiboArticle, publishWeiboDraft } from './weibo-publish.js'
import { articleUrl, draftUrl, Zhihu } from './zhihu.js'
import { checkZhihuArticle, publishZhihuDraft, type PublishResult } from './zhihu-publish.js'

const workspaceUrl = 'relay://workspace/index.html'
const zhihuLoginUrl = 'https://www.zhihu.com/signin'
const releasesUrl = 'https://github.com/broqiang/article-relay/releases'
const workspaceAssets = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'text/css; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/icon.svg', 'image/svg+xml; charset=utf-8'],
  ['/zhihu.ico', 'image/vnd.microsoft.icon'],
  ['/weibo.ico', 'image/vnd.microsoft.icon'],
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
    const body = await readFile(join(__dirname, '..', 'ui', url.pathname.slice(1)))
    return new Response(body, {
      headers: { 'Content-Type': type },
    })
  })
}

function siteView(
  browserSession: Session, origins: string[], backgroundThrottling = true, allowCallback?: (url: URL) => boolean,
): WebContentsView {
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
    try {
      const address = new URL(url)
      return origins.includes(address.origin) || allowCallback?.(address) === true
    } catch { return false }
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
  platform?: Platform
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
  const weiboSession = session.fromPartition('persist:weibo')
  const weiboView = siteView(weiboSession, [
    'https://weibo.com', 'https://www.weibo.com', 'https://card.weibo.com',
    'https://passport.weibo.com', 'https://login.sina.com.cn', 'https://security.weibo.com',
  ], false, isWeiboSsoCallback)
  const weibo = new Weibo((url, init) => weiboSession.fetch(url, init))
  let activeView: WebContentsView | undefined
  let activeLabel = ''
  let sourceTask: string | undefined
  let busy = false
  let weiboAccountWatch: AbortController | undefined

  function resizeBrowser(view = activeView): void {
    const [width, height] = window.getContentSize()
    // Keep the workspace controls and the browser toolbar visible above/beside the view.
    view?.setBounds({ x: 340, y: 132, width: Math.max(1, width - 364), height: Math.max(1, height - 156) })
  }

  function show(view?: WebContentsView, label = ''): void {
    if (window.isDestroyed()) return
    if (view !== weiboView) {
      weiboAccountWatch?.abort()
      weiboAccountWatch = undefined
    }
    if (activeView !== view) {
      if (activeView) window.contentView.removeChildView(activeView)
      activeView = view
      if (view) window.contentView.addChildView(view)
      resizeBrowser()
    }
    activeLabel = label
    window.webContents.send('relay:browser', label)
    if (view === weiboView) watchWeiboAccount()
  }

  function watchWeiboAccount(): void {
    if (weiboAccountWatch) return
    const watch = new AbortController()
    weiboAccountWatch = watch
    const contents = weiboView.webContents
    let previous: WeiboAccount | null | undefined
    let probe: AbortController | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let navigation = 0

    function schedule(refreshIfStalled = false): void {
      clearTimeout(timer)
      probe?.abort()
      const expectedNavigation = navigation
      timer = setTimeout(async () => {
        const check = new AbortController()
        probe = check
        const account = await weibo.account(check.signal).catch(() => undefined)
        if (watch.signal.aborted || check.signal.aborted || account === undefined || window.isDestroyed()) return
        const changed = previous !== undefined && previous?.id !== account?.id
        const update = previous === undefined || changed || previous?.name !== account?.name
        previous = account
        if (update) window.webContents.send('relay:weibo-account-changed', account?.name ?? null)
        if (changed && account) void reconcileWeiboRuns().catch(() => {})
        if (changed && refreshIfStalled && navigation === expectedNavigation && !contents.isLoadingMainFrame()) {
          void contents.loadURL(weiboHome).catch(() => {})
        }
      }, refreshIfStalled ? 1_000 : 0)
    }

    const onNavigationStart = (event: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (event.isMainFrame && !event.isSameDocument) navigation++
    }
    const onLoad = () => schedule()
    const onCookie = (_event: Electron.Event, cookie: Electron.Cookie) => {
      const domain = cookie.domain?.replace(/^\./, '')
      if ((cookie.name === 'SUB' || cookie.name === 'SUBP') &&
          (domain === 'weibo.com' || domain?.endsWith('.weibo.com'))) schedule(true)
    }
    contents.on('did-start-navigation', onNavigationStart)
    contents.on('did-finish-load', onLoad)
    weiboSession.cookies.on('changed', onCookie)
    watch.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      probe?.abort()
      contents.removeListener('did-start-navigation', onNavigationStart)
      contents.removeListener('did-finish-load', onLoad)
      weiboSession.cookies.removeListener('changed', onCookie)
    }, { once: true })
    schedule()
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
      missingId && item.platform === run.platform && item.owner === run.owner && item.draftId === missingId
        ? { ...item, draftMissing: true } : item)
    await updateTask(taskId, { runs: [run, ...other] })
  }

  function assertCanPublish(task: Task, platform: Platform): void {
    const prior = blockingPublication(task.runs, platform)
    const name = platformNames[platform]
    if (prior?.state === 'published') throw new Error(`这篇文章已发布到${name}，可在该平台的记录中查看。`)
    if (prior) throw new Error(`上一次发布的结果尚未确认，请先在${name}核对。`)
  }

  function publicationPlatform(action?: Action): Platform {
    if (action?.platform === undefined || action.platform === 'zhihu') return 'zhihu'
    if (action.platform === 'weibo') return 'weibo'
    throw new Error('不支持的发布平台。')
  }

  function articleRun(task: Task, runId?: string): SyncRun & { draftId: string } {
    const run = task.runs.find((item) => item.id === runId)
    if (!run?.draftId || (run.state !== 'published' && run.state !== 'publish-uncertain')) {
      throw new Error('这次同步没有可查看的文章链接。')
    }
    return { ...run, draftId: run.draftId }
  }

  async function recordPublished(
    taskId: string, run: SyncRun & { draftId: string },
    url = run.platform === 'zhihu' ? articleUrl(run.draftId) : undefined,
  ) {
    const finishedAt = run.state === 'published' && run.finishedAt ? run.finishedAt : new Date().toISOString()
    await writeRun(taskId, { ...run, publishedUrl: url, state: 'published', finishedAt, error: undefined })
    return { published: true, publishedUrl: url }
  }

  function incompleteWeiboRuns() {
    return tasks.list().flatMap(({ id }) => tasks.get(id).runs.flatMap((run) =>
      run.platform === 'weibo' && !run.publishedUrl && run.draftId &&
      (run.state === 'publish-uncertain' || run.state === 'published')
        ? [{ taskId: id, run: { ...run, draftId: run.draftId } }] : []))
  }

  async function reconcileWeiboRuns(): Promise<void> {
    if (!incompleteWeiboRuns().length) return
    const account = await weibo.account()
    if (!account || !incompleteWeiboRuns().some(({ run }) => run.owner === account.id)) return
    const published = await weibo.publishedDrafts(account.id)
    if (!incompleteWeiboRuns().some(({ run }) => run.owner === account.id && published.has(run.draftId))) return
    const articles = await weibo.publishedArticles(account.id).catch(() => [])
    if (busy || window.isDestroyed()) return
    await serial(async () => {
      for (const { taskId, run } of incompleteWeiboRuns()) {
        if (run.owner !== account.id || !published.has(run.draftId)) continue
        const url = findWeiboPublishedUrl(run.draftId, published, articles)
        if (url || run.state === 'publish-uncertain') await recordPublished(taskId, run, url)
      }
    })
  }

  async function checkWeiboHistory(run: SyncRun & { draftId: string }, justSubmitted = false) {
    const published = await weibo.publishedDrafts(run.owner).catch(() => undefined)
    if (!published?.has(run.draftId)) return
    let url = findWeiboPublishedUrl(run.draftId, published, await weibo.publishedArticles(run.owner).catch(() => []))
    if (!url && justSubmitted) {
      await delay(1_000)
      url = findWeiboPublishedUrl(run.draftId, published, await weibo.publishedArticles(run.owner).catch(() => []))
    }
    return { url }
  }

  async function deletePublication(task: Task, runId?: string): Promise<void> {
    const run = articleRun(task, runId)
    if (run.state !== 'published') throw new Error('请先核对线上发布结果。')
    const name = platformNames[run.platform]
    const adapter = run.platform === 'weibo' ? weibo : zhihu
    const requireOwner = async () => {
      if ((await adapter.account())?.id !== run.owner) throw new Error(`请先登录当时发布文章的${name}账号。`)
    }
    progress(task.id, `正在核对${name}线上文章…`)
    await requireOwner()
    const url = run.platform === 'weibo'
      ? weiboArticleUrl(run.publishedUrl ?? '') || (await checkWeiboHistory(run))?.url
      : articleUrl(run.draftId)
    if (!url) throw new Error('没有可核对的微博文章链接，请先补录链接。')
    const siteSession = run.platform === 'weibo' ? weiboSession : zhihuSession
    if (await publicationUrlStatus((address, init) => siteSession.fetch(address, init), url) !== 'missing') {
      const exists = run.platform === 'weibo'
        ? await checkWeiboArticle(weiboView.webContents, url, run.articleTitle ?? '', run.owner)
        : await checkZhihuArticle(zhihuView.webContents, run.draftId)
      throw new Error(exists
        ? `${name}文章仍在线，请先到${name}删除文章。`
        : `暂时无法确认${name}文章已删除。请核对线上文章后重试。`)
    }
    await requireOwner()
    await updateTask(task.id, { runs: clearPublishedRun(task.runs, run) })
  }

  async function publishSaved(taskId: string, run: SyncRun & { draftId: string }) {
    assertCanPublish(tasks.get(taskId), run.platform)
    await writeRun(taskId, { ...run, state: 'publishing', finishedAt: undefined, error: undefined })
    const name = platformNames[run.platform]
    progress(taskId, `正在提交${name}文章…`)
    show()
    let result: PublishResult
    let manualReason: string | undefined
    try {
      if (run.platform === 'weibo') {
        resizeBrowser(weiboView)
        const outcome = await publishWeiboDraft(weiboView.webContents, run.draftId, run.articleTitle ?? '', run.owner)
        if (outcome.state === 'published') return recordPublished(taskId, run, outcome.url)
        if (outcome.state === 'uncertain') {
          progress(taskId, '正在核对微博发布历史…')
          const confirmed = await checkWeiboHistory(run, true)
          if (confirmed) return recordPublished(taskId, run, confirmed.url)
        }
        if (outcome.state === 'manual') {
          manualReason = {
            load: '微博草稿编辑器未能加载。',
            next: '应用未能识别微博草稿编辑器的「下一步」操作。',
            submit: '点击「下一步」后，应用未能识别微博发布设置中的提交操作。',
          }[outcome.step]
        }
        result = outcome.state
      } else {
        resizeBrowser(zhihuView)
        result = await publishZhihuDraft(zhihuView.webContents, run.draftId)
        if (result === 'uncertain') {
          progress(taskId, '正在核对知乎发布结果…')
          if (await checkZhihuArticle(zhihuView.webContents, run.draftId)) result = 'published'
        }
      }
    } catch {
      result = 'uncertain'
    }
    if (result === 'published') return recordPublished(taskId, run)
    const error = result === 'manual'
      ? `${manualReason ?? '未能自动提交。'}草稿已保留，你可以打开草稿，在${name}编辑器中检查并发布。`
      : `${name}发布结果尚未确认。请在${name}核对文章状态，避免重复发布。`
    await writeRun(taskId, {
      ...run, state: result === 'manual' ? 'saved' : 'publish-uncertain', finishedAt: new Date().toISOString(), error,
    })
    return { publishNotice: error }
  }

  async function serial<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new Error('请等当前操作完成。')
    busy = true
    try {
      return await work()
    } finally {
      busy = false
    }
  }

  async function publishArticle(task: Task, platform: Platform) {
    const article = task.article
    if (!article || task.importState !== 'ready') throw new Error('请先完成公众号文章导入。')
    assertCanPublish(task, platform)
    const name = platformNames[platform]
    const startedAt = new Date().toISOString()
    const base: SyncRun = { id: randomUUID(), platform, owner: '', account: '账号未确认', startedAt, state: 'running' }
    progress(task.id, `正在检查${name}登录状态…`)
    let account
    try {
      account = await (platform === 'weibo' ? weibo : zhihu).account()
    } catch (error) {
      await writeRun(task.id, { ...base, finishedAt: new Date().toISOString(), state: 'failed', error: errorMessage(error) })
      throw error
    }
    if (!account) {
      await writeRun(task.id, { ...base, finishedAt: new Date().toISOString(), state: 'failed', error: `请先在应用内登录${name}。` })
      return { loginRequired: true }
    }
    const owned = task.runs.filter((run) => run.platform === platform && run.owner === account.id && run.draftId && !run.draftMissing)
    const existing = owned[0]?.draftId
    const saved = owned.find((run) => run.draftId === existing && run.state === 'saved')
    if (existing && saved) return publishSaved(task.id, { ...saved, draftId: existing })

    let run: SyncRun = { ...base, owner: account.id, account: account.name, draftId: existing, articleTitle: article.title }
    await writeRun(task.id, run)
    let draftId: string
    try {
      const readImage = (url: string) => tasks.readImage(task.id, url)
      const uploading = (index: number, total: number) => {
        progress(task.id, `正在上传本地原图 ${index}/${total}…`)
      }
      const saveProgress = async (id?: string) => {
        const missingId = !id ? run.draftId : undefined
        run = { ...run, draftId: id }
        await writeRun(task.id, run, missingId)
        if (missingId) progress(task.id, `原草稿已失效，正在新建${name}草稿…`)
      }
      if (platform === 'weibo') {
        const content = await weibo.prepareContent(account.id, article, readImage, uploading)
        progress(task.id, '正在保存微博草稿…')
        draftId = await weibo.saveDraft(account.id, article.title, content, existing, saveProgress)
      } else {
        const content = await zhihu.prepareContent(article, readImage, uploading)
        progress(task.id, '正在保存知乎草稿…')
        draftId = await zhihu.saveDraft(article.title, content, existing, saveProgress)
      }
    } catch (error) {
      await writeRun(task.id, { ...run, state: 'failed', error: errorMessage(error), finishedAt: new Date().toISOString() })
      throw error
    }
    const savedRun: SyncRun & { draftId: string } = { ...run, draftId, state: 'saved', finishedAt: new Date().toISOString() }
    await writeRun(task.id, savedRun)
    return publishSaved(task.id, savedRun)
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
    'relay:open-weibo': async () => {
      const alreadyOpen = activeView === weiboView && activeLabel === '微博账号'
      show(weiboView, '微博账号')
      const contents = weiboView.webContents
      const current = contents.getURL()
      if (!alreadyOpen || !current || current === 'about:blank' || current.startsWith('chrome-error:')) {
        try {
          await contents.loadURL(weiboHome)
        } catch (error) {
          if (activeView === weiboView && (error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') throw error
        }
      }
    },
    'relay:account': async (action?: Action) => {
      const adapter = publicationPlatform(action) === 'weibo' ? weibo : zhihu
      return { name: (await adapter.account())?.name ?? null }
    },
    'relay:tasks': () => tasks.list(),
    'relay:delete-publication': (action?: Action) => serial(() => deletePublication(selectedTask(action), action?.runId)),
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
      const task = selectedTask(action)
      const run = task.runs.find((item) => item.id === action?.runId)
      if (!run?.draftId || run.draftMissing || !run.error ||
          (run.state !== 'saved' && !(run.state === 'publish-uncertain' && run.manualHandoff))) {
        throw new Error('这次发布没有可打开的草稿。')
      }
      const name = platformNames[run.platform]
      const account = await (run.platform === 'weibo' ? weibo : zhihu).account()
      if (!account || run.owner !== account.id) {
        throw new Error(`请先登录保存这份草稿的${name}账号。`)
      }
      if (run.platform === 'weibo') {
        show()
        const url = weiboDraftUrl(run.draftId)
        await weiboView.webContents.loadURL(url)
        if (run.state === 'saved') {
          await writeRun(task.id, {
            ...run, state: 'publish-uncertain', manualHandoff: true,
            error: '已交给微博编辑器处理。手动发布后，请用文章链接核对结果。',
          })
        }
        show(weiboView, '微博草稿编辑器')
        return
      }
      await zhihuView.webContents.loadURL(draftUrl(run.draftId))
      if (run.state === 'saved') {
        await writeRun(task.id, {
          ...run, state: 'publish-uncertain', manualHandoff: true,
          error: '已交给知乎编辑器处理。请在知乎核对文章状态。',
        })
      }
      show(zhihuView, '知乎草稿编辑器')
    }),
    'relay:show-article': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = articleRun(task, action?.runId)
      if (run.platform === 'weibo' && !run.publishedUrl) {
        progress(task.id, '正在查找已发布的微博文章…')
        const confirmed = await checkWeiboHistory(run)
        if (confirmed && (confirmed.url || run.state === 'publish-uncertain')) {
          return recordPublished(task.id, run, confirmed.url)
        }
        show(weiboView, '微博文章管理')
        if (run.state === 'published') {
          await weiboView.webContents.loadURL(weiboHistoryUrl(run.draftId))
        } else if (weiboView.webContents.getURL().split('#')[0] !== weiboEditor) {
          await weiboView.webContents.loadURL(weiboEditor)
        }
        return { checkNotice: run.state === 'published'
          ? '文章已发布。可以复制文章链接并返回工作区补录。'
          : '请在微博核对文章。发布后，复制文章链接并返回工作区核对。' }
      }
      if (run.state === 'publish-uncertain') {
        progress(task.id, '正在核对知乎发布结果…')
        if (await checkZhihuArticle(zhihuView.webContents, run.draftId)) return recordPublished(task.id, run)
      }
      const url = run.platform === 'weibo' ? weiboArticleUrl(run.publishedUrl ?? '') : articleUrl(run.draftId)
      if (!url) throw new Error('这次同步没有可查看的文章链接。')
      try {
        await shell.openExternal(url)
      } catch {
        throw new Error('无法打开系统浏览器。你可以复制同步记录中的文章链接后访问。')
      }
      return { articleOpened: true, needsConfirmation: run.state === 'publish-uncertain' }
    }),
    'relay:mark-published': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = articleRun(task, action?.runId)
      if (run.platform === 'weibo') {
        if (run.publishedUrl) return { publishedUrl: run.publishedUrl }
        const url = weiboArticleUrl(action?.url ?? '')
        if (!url) throw new Error('请输入有效的微博头条文章链接。')
        show()
        progress(task.id, '正在核对微博文章的标题和作者…')
        if (!run.articleTitle || !await checkWeiboArticle(weiboView.webContents, url, run.articleTitle, run.owner)) {
          throw new Error('未能核对微博文章的标题和作者。请检查链接并确认文章已发布。')
        }
        return recordPublished(task.id, run, url)
      }
      return run.state === 'published' ? { publishedUrl: articleUrl(run.draftId) } : recordPublished(task.id, run)
    }),
    'relay:publish': (action?: Action) => serial(() => publishArticle(selectedTask(action), publicationPlatform(action))),
    'relay:publish-all': (action?: Action) => serial(() => {
      const { id } = selectedTask(action)
      return publishMissingPlatforms(() => tasks.get(id), publishArticle)
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
    weiboAccountWatch?.abort()
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    for (const view of [sourceView, zhihuView, weiboView]) view.webContents.close()
  })
  await window.loadURL(workspaceUrl)
  const initialized = await window.webContents.executeJavaScript(`
    if (document.documentElement.dataset.relayReady === 'true') {
      true
    } else {
      document.getElementById('account-summary').textContent = '应用界面启动失败'
      document.getElementById('status').textContent = '界面未能加载，请查看启动终端中的错误信息。'
      document.getElementById('status').classList.add('error')
      false
    }
  `)
  if (!initialized) console.error('文章同步：界面脚本未完成初始化。')
  if (initialized) void reconcileWeiboRuns().catch(() => {})
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
