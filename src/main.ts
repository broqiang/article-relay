import { app, BrowserWindow, ipcMain, net, protocol, session, shell, type Session, WebContentsView } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromiumUserAgent, publicationUrlStatus } from './browser.js'
import { Jianshu, jianshuArticleUrl, jianshuDraftUrl, jianshuHome, jianshuLoginUrl, sameJianshuRichText } from './jianshu.js'
import { monitorJuejinAudits } from './juejin-audit.js'
import { Juejin, juejinArticleId, juejinArticles, juejinArticleUrl, juejinDefaultsRequired, juejinDraftUrl, juejinHome, juejinId,
  juejinReviewUrl, parseJuejinDefaults, type JuejinDefaults, type JuejinPublicationStatus } from './juejin.js'
import { juejinMarkdown } from './juejin-markdown.js'
import { publishJuejinDraft } from './juejin-publish.js'
import { monitorJuejinPublishResponse, type JuejinPublishDiagnostic } from './juejin-publish-response.js'
import { blockingPublication, canCheckJuejinAudit, canOpenDraft, clearPublishedRun, errorMessage, platformNames, publishMissingPlatforms, TaskStore, type Platform, type SyncRun, type Task } from './tasks.js'
import { checkTiebaLogin, tiebaHome } from './tieba.js'
import { inspectWeChatScript, wechatArticleUrl, type PageResult } from './wechat.js'
import { Weibo, findWeiboPublishedUrl, isWeiboSsoCallback, weiboArticleUrl, weiboDraftUrl, weiboEditor, weiboHistoryUrl, weiboHome, type WeiboAccount } from './weibo.js'
import { checkWeiboArticle, publishWeiboDraft } from './weibo-publish.js'
import { articleUrl, draftUrl, Zhihu } from './zhihu.js'
import { checkZhihuArticle, publishZhihuDraft, type PublishResult } from './zhihu-publish.js'

const workspaceUrl = 'relay://workspace/index.html'
const helpUrl = 'relay://workspace/help.html'
const zhihuLoginUrl = 'https://www.zhihu.com/signin'
const zhihuOrigins = ['https://www.zhihu.com', 'https://zhuanlan.zhihu.com']
const repositoryUrl = 'https://github.com/broqiang/article-relay'
const releasesUrl = `${repositoryUrl}/releases`
const latestReleaseUrl = 'https://api.github.com/repos/broqiang/article-relay/releases/latest'
const workspaceAssets = new Map([
  ['/index.html', 'text/html; charset=utf-8'],
  ['/help.html', 'text/html; charset=utf-8'],
  ['/styles.css', 'text/css; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/icon.svg', 'image/svg+xml; charset=utf-8'],
  ['/github.svg', 'image/svg+xml; charset=utf-8'],
  ['/button-icons.svg', 'image/svg+xml; charset=utf-8'],
  ['/zhihu.ico', 'image/vnd.microsoft.icon'],
  ['/weibo.ico', 'image/vnd.microsoft.icon'],
  ['/juejin.ico', 'image/vnd.microsoft.icon'],
  ['/jianshu.ico', 'image/vnd.microsoft.icon'],
  ['/tieba.ico', 'image/vnd.microsoft.icon'],
])

async function hasUpdate(currentVersion: string): Promise<boolean> {
  const response = await net.fetch(latestReleaseUrl, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) return false

  const { tag_name: latestVersion } = await response.json() as { tag_name?: unknown }
  const versionPattern = /^v?(\d+)\.(\d+)\.(\d+)$/
  const current = versionPattern.exec(currentVersion)
  const latest = typeof latestVersion === 'string' ? versionPattern.exec(latestVersion) : null
  if (!current || !latest) return false

  for (let i = 1; i < current.length; i++) {
    const currentPart = BigInt(current[i])
    const latestPart = BigInt(latest[i])
    if (latestPart !== currentPart) return latestPart > currentPart
  }
  return false
}

async function openGitHub(url: string): Promise<void> {
  try {
    await shell.openExternal(url)
  } catch {
    throw new Error(`无法打开系统浏览器，请手动访问 ${url}`)
  }
}

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
  settingsOpen?: boolean
  openOnly?: boolean
  returnFromDraft?: boolean
  owner?: string
  query?: string
  defaults?: unknown
}

async function createWindow(): Promise<void> {
  const tasks = await TaskStore.open(app.getPath('userData'))
  const window = new BrowserWindow({
    width: 1280, height: 840, minWidth: 900, minHeight: 660,
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
  const zhihuView = siteView(zhihuSession, zhihuOrigins, false)
  const zhihu = new Zhihu((url, init) => zhihuSession.fetch(url, init))
  const jianshuSession = session.fromPartition('persist:jianshu')
  const jianshuView = siteView(jianshuSession, [
    new URL(jianshuHome).origin, 'https://open.weixin.qq.com', 'https://graph.qq.com',
  ])
  const jianshu = new Jianshu((url, init) => jianshuSession.fetch(url, init))
  const tiebaSession = session.fromPartition('persist:tieba')
  const tiebaView = siteView(tiebaSession, [
    new URL(tiebaHome).origin, 'https://passport.baidu.com', 'https://wappass.baidu.com',
  ])
  tiebaView.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  const weiboSession = session.fromPartition('persist:weibo')
  const weiboView = siteView(weiboSession, [
    'https://weibo.com', 'https://www.weibo.com', 'https://card.weibo.com',
    'https://passport.weibo.com', 'https://login.sina.com.cn', 'https://security.weibo.com',
  ], false, isWeiboSsoCallback)
  const weibo = new Weibo((url, init) => weiboSession.fetch(url, init))
  const juejinSession = session.fromPartition('persist:juejin')
  const juejinView = siteView(juejinSession, [new URL(juejinHome).origin], false)
  const juejin = new Juejin((url, init) => juejinSession.fetch(url, init))
  let observeJuejinDispatch: (() => void) | undefined
  juejinSession.webRequest.onBeforeRequest({ urls: ['https://api.juejin.cn/content_api/v1/article/publish*'] }, (details, callback) => {
    if (details.webContentsId === juejinView.webContents.id && details.method === 'POST' &&
        new URL(details.url).pathname === '/content_api/v1/article/publish') observeJuejinDispatch?.()
    callback({})
  })
  const publicationSites = { zhihu, weibo, juejin, jianshu }
  const publicationSessions = { zhihu: zhihuSession, weibo: weiboSession, juejin: juejinSession, jianshu: jianshuSession }
  let activeView: WebContentsView | undefined
  let activeDraft: { taskId: string; runId: string } | undefined
  let zhihuDraftCheckView: WebContentsView | undefined
  let settingsOpen = false
  let activeLabel = ''
  let sourceTask: string | undefined
  let busy = false
  let weiboAccountWatch: AbortController | undefined
  const juejinAuditMonitor = monitorJuejinAudits(checkJuejinAudit)

  function resizeBrowser(view = activeView): void {
    const [width, height] = window.getContentSize()
    // Keep the workspace controls and the browser toolbar visible above/beside the view.
    view?.setBounds({ x: 340, y: 132, width: Math.max(1, width - 364), height: Math.max(1, height - 156) })
  }

  function show(view?: WebContentsView, label = '', draft?: typeof activeDraft): void {
    if (window.isDestroyed()) return
    if (view !== weiboView) {
      weiboAccountWatch?.abort()
      weiboAccountWatch = undefined
    }
    if (activeView !== view) {
      if (activeView) window.contentView.removeChildView(activeView)
      activeView = view
      if (view) {
        view.setVisible(!settingsOpen)
        window.contentView.addChildView(view)
      }
      resizeBrowser()
    }
    activeLabel = label
    activeDraft = draft
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
    if (window.isDestroyed()) return
    const list = tasks.list()
    window.webContents.send('relay:tasks-changed', list, selected)
    syncJuejinAudits(list)
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
    if (action?.platform === undefined) return 'zhihu'
    if (Object.hasOwn(platformNames, action.platform)) return action.platform
    throw new Error('不支持的发布平台。')
  }

  function articleRun(task: Task, runId?: string): SyncRun & { draftId: string } {
    const run = task.runs.find((item) => item.id === runId)
    if (!run?.draftId || (run.state !== 'published' && run.state !== 'publish-uncertain')) {
      throw new Error('这次同步没有可查看的文章链接。')
    }
    return { ...run, draftId: run.draftId }
  }

  function jianshuDraft(run: SyncRun & { draftId: string }) {
    if (!run.jianshuNotebookId) throw new Error('这次发布缺少简书文集编号。')
    return { id: run.draftId, notebookId: run.jianshuNotebookId }
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

  function syncJuejinAudits(list = tasks.list()): void {
    juejinAuditMonitor.sync(list.flatMap(({ id: taskId }) => tasks.get(taskId).runs.filter(canCheckJuejinAudit)
      .map(({ id: runId }) => ({ taskId, runId }))))
  }

  async function checkJuejinAudit({ taskId, runId }: { taskId: string; runId: string }): Promise<void> {
    const pending = () => tasks.get(taskId).runs.filter(canCheckJuejinAudit).find((run) => run.id === runId)
    if (busy || window.isDestroyed()) return
    const run = pending()
    if (!run) return
    const checked = await juejin.publicationStatus(run.draftId, run.owner, run.articleId)
    if (busy || window.isDestroyed()) return
    await serial(async () => {
      const current = pending()
      if (current === run) await applyJuejinAuditResult(taskId, current, checked)
    })
  }

  function juejinAuditNotice(checked: JuejinPublicationStatus, run: SyncRun): string | undefined {
    const audit = checked.audit ?? run.juejinAudit
    if (audit === 'reviewing') return '掘金已接收文章，正在审核。'
    if (audit === 'rejected') return '掘金审核未通过，可在创作者中心查看原因。'
    if (checked.status) return `掘金发布状态为「${checked.status}」，可在创作者中心核对。`
  }

  async function applyJuejinAuditResult(taskId: string, run: SyncRun & { draftId: string }, checked: JuejinPublicationStatus) {
    if (checked.url) return recordPublished(taskId, { ...run, articleId: checked.id, juejinAudit: undefined }, checked.url)
    const updated = {
      ...run, articleId: checked.id ?? run.articleId, juejinAudit: checked.audit ?? run.juejinAudit,
      error: juejinAuditNotice(checked, run) ?? run.error,
    }
    if (updated.articleId !== run.articleId || updated.juejinAudit !== run.juejinAudit || updated.error !== run.error) {
      await writeRun(taskId, updated)
    }
  }

  async function stopJuejinAutoCheck(taskId: string, run: SyncRun & { draftId: string }) {
    if (run.juejinAutoCheckStopped) return run
    const stopped = { ...run, juejinAutoCheckStopped: true }
    await writeRun(taskId, stopped)
    return stopped
  }

  async function markJianshuDraftIncomplete(taskId: string, run: SyncRun): Promise<string> {
    const notice = '简书草稿的正文未保存。点击「重试发布」可继续同步这份草稿。'
    await writeRun(taskId, { ...run, state: 'failed', finishedAt: new Date().toISOString(), error: notice })
    return notice
  }

  async function refreshPublication(taskId: string, run: SyncRun & { draftId: string }, manual: boolean) {
    if (run.platform === 'jianshu') {
      const result = await jianshu.publication(run.owner, jianshuDraft(run))
      if (result.url) return recordPublished(taskId, run, result.url)
      if (result.needsContent) return { checkNotice: await markJianshuDraftIncomplete(taskId, run) }
      return { checkNotice: '简书尚未确认发布，可以打开草稿编辑器查看。' }
    }
    if (run.platform === 'juejin') {
      const current = manual ? await stopJuejinAutoCheck(taskId, run) : run
      const checked = await juejin.publicationStatus(run.draftId, run.owner, run.articleId)
      const published = await applyJuejinAuditResult(taskId, current, checked)
      return published ?? { checkNotice: juejinAuditNotice(checked, current) ?? '暂未核实发布结果，可以打开掘金页面查看进度。' }
    }
    if (run.platform === 'weibo') {
      const confirmed = await checkWeiboHistory(run)
      if (confirmed && (confirmed.url || run.state === 'publish-uncertain')) {
        return recordPublished(taskId, run, confirmed.url)
      }
      return { checkNotice: run.state === 'published' ? '文章已发布，暂未匹配到公开链接。可打开微博发布记录查看。' :
        '暂未核实发布结果，可以打开微博文章管理查看。' }
    }
    const view = manual ? zhihuView : (zhihuDraftCheckView ??= siteView(zhihuSession, zhihuOrigins, false))
    if (await checkZhihuArticle(view.webContents, run.draftId, manual ? undefined : 3_000)) return recordPublished(taskId, run)
    return { checkNotice: '暂未核实知乎发布结果，可以打开文章链接查看。' }
  }

  async function refreshAfterDraft({ taskId, runId }: NonNullable<typeof activeDraft>): Promise<void> {
    for (const wait of [0, 5_000]) {
      if (wait) await delay(wait, undefined, { ref: false })
      if (window.isDestroyed() || activeView || busy) continue
      const run = tasks.get(taskId).runs.find((item) => item.id === runId)
      const draftId = run?.draftId
      if (!draftId || !run || run.draftMissing || run.juejinAudit ||
          (run.state !== 'publish-uncertain' && !(run.platform === 'weibo' && run.state === 'published' && !run.publishedUrl))) return
      await serial(() => refreshPublication(taskId, { ...run, draftId }, false)).catch(() => {})
    }
  }

  async function deletePublication(task: Task, runId?: string): Promise<void> {
    const local = task.runs.find((run) => run.id === runId)
    if (local?.platform === 'juejin' && local.state !== 'published') {
      await tasks.clearJuejinPublicationHistory(task.id, local.id)
      notifyTasks()
      return
    }
    const run = articleRun(task, runId)
    if (run.state !== 'published') throw new Error('请先核对线上发布结果。')
    const name = platformNames[run.platform]
    const adapter = publicationSites[run.platform]
    const requireOwner = async () => {
      if ((await adapter.account())?.id !== run.owner) throw new Error(`请先登录当时发布文章的${name}账号。`)
    }
    progress(task.id, `正在核对${name}线上文章…`)
    await requireOwner()
    let url: string | undefined
    if (run.platform === 'jianshu') url = jianshuArticleUrl(run.publishedUrl ?? '')
    if (run.platform === 'weibo') url = weiboArticleUrl(run.publishedUrl ?? '') || (await checkWeiboHistory(run))?.url
    if (run.platform === 'zhihu') url = articleUrl(run.draftId)
    if (run.platform === 'juejin') {
      const id = juejinArticleId(run.publishedUrl ?? '')
      if (id) url = juejinArticleUrl(id)
    }
    if (!url) throw new Error(run.platform === 'weibo' ? '没有可核对的微博文章链接，请先补录链接。' :
      `没有可核对的${name}文章链接，请先核对发布结果。`)
    const siteSession = publicationSessions[run.platform]
    const missing = run.platform === 'juejin' ? await juejin.articleMissing(juejinArticleId(url)!) :
      await publicationUrlStatus((address, init) => siteSession.fetch(address, init), url) === 'missing'
    if (!missing) {
      const exists = run.platform === 'weibo'
        ? await checkWeiboArticle(weiboView.webContents, url, run.articleTitle ?? '', run.owner)
        : run.platform === 'juejin'
          ? await juejin.publicArticle(juejinArticleId(url)!, run.draftId).catch(() => false)
          : run.platform === 'jianshu'
            ? (await jianshu.publication(run.owner, jianshuDraft(run)).catch(() => undefined))?.url === url
            : await checkZhihuArticle(zhihuView.webContents, run.draftId)
      throw new Error(exists
        ? `${name}文章仍在线，请先到${name}删除文章。`
        : `暂时无法确认${name}文章已删除。请核对线上文章后重试。`)
    }
    await requireOwner()
    await updateTask(task.id, { runs: clearPublishedRun(task.runs, run) })
  }

  async function publishSavedJuejin(taskId: string, run: SyncRun & { draftId: string }, defaults?: JuejinDefaults) {
    const manual = async (reason: string) => {
      const notice = `${reason}草稿已保留，可打开掘金编辑器继续。`
      await writeRun(taskId, { ...run, state: 'saved', error: notice, finishedAt: new Date().toISOString() })
      return { saved: true, publishNotice: notice }
    }
    const account = await juejin.account().catch(() => undefined)
    if (account?.id !== run.owner) return manual('暂时无法确认保存草稿的掘金账号。')
    const draft = await juejin.draft(run.draftId, run.owner).catch(() => undefined)
    if (draft === null && !run.articleId) {
      const article = await juejin.findArticle(run.draftId, run.owner).catch(() => undefined)
      if (article) return finishJuejinSubmission(taskId, { ...run, articleId: article.id })
      const notice = '掘金草稿已失效。再次发布时会新建草稿。'
      await writeRun(taskId, { ...run, state: 'failed', draftMissing: true, error: notice, finishedAt: new Date().toISOString() }, run.draftId)
      return { publishNotice: notice }
    }

    let articleId = run.articleId
    let diagnostic: JuejinPublishDiagnostic | undefined
    if (!articleId && juejinId(draft?.article_id)) articleId = draft.article_id
    if (!articleId) {
      if (account.canPublish === false) return manual('请先按掘金要求完成手机验证。')
      const title = run.articleTitle ?? tasks.get(taskId).article?.title
      if (!title) return manual('缺少用于核对掘金草稿的标题。')
      resizeBrowser(juejinView)
      let dispatched = false
      observeJuejinDispatch = () => { dispatched = true }
      const response = monitorJuejinPublishResponse(juejinView.webContents.debugger, run.draftId)
      const submission = await publishJuejinDraft(juejinView.webContents, run.draftId, { owner: account.id, title, defaults },
        { beforeConfirm: response.start, submissionRejected: () => response.diagnostic()?.rejected === true }).finally(() => {
        observeJuejinDispatch = undefined
        response.close()
      })
      if (!submission.submitted) {
        const reasons = {
          'missing-defaults': juejinDefaultsRequired,
          'invalid-defaults': '掘金发布默认值已失效，请重新选择分类或标签。',
          'wrong-draft': '未能核对掘金草稿的标题、账号或发布状态。',
          verification: '请先按掘金要求完成手机验证。',
          incomplete: '掘金草稿的正文或发布设置未满足提交要求，请检查摘要等必填项。',
        }
        const reason = submission.reason
        const notice = reason && reason in reasons ? reasons[reason as keyof typeof reasons] : '暂时无法在掘金编辑器核对草稿或提交。'
        return manual(notice)
      }
      articleId = submission.articleId
      if (!articleId) diagnostic = response.diagnostic() ?? { notice: dispatched ? '掘金编辑器已发起发布请求，暂未核实平台结果。' :
        '掘金编辑器尚未观察到发布请求，可打开草稿查看。' }
    }
    return finishJuejinSubmission(taskId, { ...run, articleId }, diagnostic)
  }

  async function finishJuejinSubmission(taskId: string, run: SyncRun & { draftId: string }, diagnostic?: JuejinPublishDiagnostic) {
    progress(taskId, '正在核对掘金发布结果…')
    const checked = await juejin.publicationStatus(run.draftId, run.owner, run.articleId)
    if (checked.url) return recordPublished(taskId, { ...run, articleId: checked.id }, checked.url)
    const saved = diagnostic?.rejected === true && !checked.id && !run.articleId
    const notice = juejinAuditNotice(checked, run) ?? diagnostic?.notice ?? '掘金发布结果待核对，可在创作者中心查看进度。'
    await writeRun(taskId, {
      ...run, articleId: checked.id ?? run.articleId, juejinAudit: checked.audit, state: saved ? 'saved' : 'publish-uncertain',
      error: notice, finishedAt: new Date().toISOString(),
    })
    return { saved, publishNotice: notice, reviewing: checked.audit === 'reviewing' }
  }

  async function publishSaved(taskId: string, run: SyncRun & { draftId: string }, defaults?: JuejinDefaults) {
    assertCanPublish(tasks.get(taskId), run.platform)
    await writeRun(taskId, { ...run, state: 'publishing', finishedAt: undefined, error: undefined })
    const name = platformNames[run.platform]
    progress(taskId, `正在提交${name}文章…`)
    show()
    if (run.platform === 'juejin') return publishSavedJuejin(taskId, run, defaults)
    if (run.platform === 'jianshu') {
      const result = await jianshu.publish(run.owner, jianshuDraft(run)).catch(() => undefined)
      if (result?.url) return recordPublished(taskId, run, result.url)
      if (result?.needsContent) return { publishNotice: await markJianshuDraftIncomplete(taskId, run) }
      const saved = result?.saved === true
      const notice = saved ? '简书未接受发布。草稿已保留，可以打开草稿检查并发布。' :
        '简书发布结果尚未确认，请刷新状态或打开草稿核对。'
      await writeRun(taskId, {
        ...run, state: saved ? 'saved' : 'publish-uncertain', finishedAt: new Date().toISOString(), error: notice,
      })
      return { saved, publishNotice: notice }
    }
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
    const saved = result === 'manual' || result === 'rate-limited'
    const error = result === 'rate-limited' ? '知乎提示近期发布频率过高，请在 24 小时后重试。草稿已保留，可打开草稿。' :
      saved ? `${manualReason ?? '未能自动提交。'}草稿已保留，你可以打开草稿，在${name}编辑器中检查并发布。` :
        `${name}发布结果尚未确认。请在${name}核对文章状态，避免重复发布。`
    await writeRun(taskId, {
      ...run, state: saved ? 'saved' : 'publish-uncertain', finishedAt: new Date().toISOString(), error,
    })
    return result === 'rate-limited' ? { saved: true, publishNotice: error } : { publishNotice: error }
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
      account = await publicationSites[platform].account()
    } catch (error) {
      await writeRun(task.id, { ...base, finishedAt: new Date().toISOString(), state: 'failed', error: errorMessage(error) })
      throw error
    }
    if (!account) {
      await writeRun(task.id, { ...base, finishedAt: new Date().toISOString(), state: 'failed', error: `请先在应用内登录${name}。` })
      return { loginRequired: true }
    }
    const configured = platform === 'juejin' ? await tasks.juejinDefaults(account.id) : undefined
    const tagLimit = 'tagLimit' in account && typeof account.tagLimit === 'number' ? account.tagLimit : undefined
    const defaults = configured ? await juejin.validateDefaults(configured, tagLimit) : undefined
    const owned = task.runs.filter((run) => run.platform === platform && run.owner === account.id && run.draftId &&
      !run.draftMissing && (platform !== 'jianshu' || run.jianshuNotebookId))
    const existing = owned[0]?.draftId
    const saved = owned.find((run) => run.draftId === existing && run.state === 'saved')
    if (existing && saved) return publishSaved(task.id, { ...saved, draftId: existing }, defaults)

    let run: SyncRun = {
      ...base, owner: account.id, account: account.name, draftId: existing,
      jianshuNotebookId: owned[0]?.jianshuNotebookId, articleTitle: article.title,
    }
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
      if (platform === 'jianshu') {
        progress(task.id, '正在同步简书草稿…')
        const draft = await jianshu.saveDraft(account.id, article, existing ? jianshuDraft({ ...run, draftId: existing }) : undefined,
          async ({ id, notebookId }) => {
            run = { ...run, draftId: id, jianshuNotebookId: notebookId }
            await writeRun(task.id, run)
          }, readImage, uploading, {
            toMarkdown: async (html, images) => {
              const converted = await window.webContents.executeJavaScript(
                `(${juejinMarkdown.toString()})(${JSON.stringify(html)}, ${JSON.stringify(images)})`)
              return converted.markdown
            },
            sameRichText: (expected, stored) => window.webContents.executeJavaScript(
              `(${sameJianshuRichText.toString()})(${JSON.stringify(expected)}, ${JSON.stringify(stored)})`),
          })
        draftId = draft.id
      } else if (platform === 'weibo') {
        const content = await weibo.prepareContent(account.id, article, readImage, uploading)
        progress(task.id, '正在保存微博草稿…')
        draftId = await weibo.saveDraft(account.id, article.title, content, existing, saveProgress)
      } else if (platform === 'juejin') {
        const content = await juejin.prepareContent(article, readImage, (completed, total) => {
          const next = completed < total ? `，正在处理第 ${completed + 1} 张` : ''
          progress(task.id, `掘金原图已确认 ${completed}/${total} 张${next}…`)
        }, (html, images) => window.webContents.executeJavaScript(
          `(${juejinMarkdown.toString()})(${JSON.stringify(html)}, ${JSON.stringify(images)})`))
        progress(task.id, '正在保存掘金草稿…')
        draftId = await juejin.saveDraft(account.id, article.title, content, existing, saveProgress, defaults)
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
    return publishSaved(task.id, savedRun, defaults)
  }

  async function juejinSettingsAccount(owner?: string) {
    const account = await juejin.account()
    if (!account) throw new Error('请先在应用内登录掘金。')
    if (owner !== undefined && account.id !== owner) throw new Error('掘金账号已切换，请重新打开发布默认值。')
    return account
  }

  const handlers = {
    'relay:version': () => app.getVersion(),
    'relay:has-update': () => hasUpdate(app.getVersion()),
    'relay:open-releases': () => openGitHub(releasesUrl),
    'relay:open-repository': () => openGitHub(repositoryUrl),
    'relay:settings-open': (action?: Action) => {
      settingsOpen = action?.settingsOpen === true
      activeView?.setVisible(!settingsOpen)
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
    'relay:open-juejin': async () => {
      const alreadyOpen = activeView === juejinView && activeLabel === '掘金账号'
      show(juejinView, '掘金账号')
      const current = juejinView.webContents.getURL()
      if (!alreadyOpen || !current || current === 'about:blank' || current.startsWith('chrome-error:')) {
        await juejinView.webContents.loadURL(juejinHome)
      }
    },
    'relay:open-jianshu': async () => {
      show(jianshuView, '简书账号')
      const contents = jianshuView.webContents
      const current = contents.getURL()
      if (!current || current === 'about:blank' || current.startsWith('chrome-error:') ||
          new URL(current).origin !== new URL(jianshuHome).origin) {
        try {
          await contents.loadURL(jianshuLoginUrl)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') throw error
        }
      }
    },
    'relay:account': async (action?: Action) => {
      const adapter = publicationSites[publicationPlatform(action)]
      return { name: (await adapter.account())?.name ?? null }
    },
    'relay:open-tieba': async () => {
      show(tiebaView, '百度贴吧账号')
      const contents = tiebaView.webContents
      const current = contents.getURL()
      if (!current || current === 'about:blank' || current.startsWith('chrome-error:')) {
        try {
          await contents.loadURL(tiebaHome)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') throw error
        }
      }
    },
    'relay:tieba-account': async () => {
      return { signedIn: await checkTiebaLogin((url, init) => tiebaSession.fetch(url, init)) }
    },
    'relay:juejin-defaults': async () => {
      const account = await juejinSettingsAccount()
      const [categories, defaults] = await Promise.all([juejin.categories(), tasks.juejinDefaults(account.id)])
      return { account, categories, defaults }
    },
    'relay:juejin-tags': async (action?: Action) => {
      if (!juejinId(action?.owner) || typeof action?.query !== 'string') throw new Error('请输入掘金标签名称。')
      await juejinSettingsAccount(action.owner)
      return juejin.searchTags(action.query)
    },
    'relay:save-juejin-defaults': (action?: Action) => serial(async () => {
      const defaults = parseJuejinDefaults(action?.defaults)
      if (!juejinId(action?.owner) || !defaults) throw new Error('请选择一个掘金分类和至少一个标签。')
      const account = await juejinSettingsAccount(action.owner)
      const validated = await juejin.validateDefaults(defaults, account.tagLimit)
      await juejinSettingsAccount(account.id)
      await tasks.saveJuejinDefaults(account.id, validated)
    }),
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
    'relay:hide-browser': (action?: Action) => {
      const draft = action?.returnFromDraft ? activeDraft : undefined
      show()
      if (draft) void refreshAfterDraft(draft).catch(() => {})
    },
    'relay:show-draft': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = task.runs.find((item) => item.id === action?.runId)
      if (!run || !canOpenDraft(run, task.runs)) {
        throw new Error('这次发布没有可打开的草稿。')
      }
      const name = platformNames[run.platform]
      const account = await publicationSites[run.platform].account()
      if (!account || run.owner !== account.id) {
        throw new Error(`请先登录保存这份草稿的${name}账号。`)
      }
      if (run.platform === 'jianshu') {
        const draft = jianshuDraft(run)
        const result = await jianshu.publication(run.owner, draft).catch(() => undefined)
        if (result?.url) return recordPublished(task.id, run, result.url)
        await jianshuView.webContents.loadURL(jianshuDraftUrl(draft))
        if (run.state === 'saved') {
          await writeRun(task.id, {
            ...run, state: 'publish-uncertain', manualHandoff: true,
            error: '已打开简书草稿。提交后请返回工作区核对发布结果。',
          })
        }
        show(jianshuView, '简书草稿编辑器', { taskId: task.id, runId: run.id })
        return
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
        show(weiboView, '微博草稿编辑器', { taskId: task.id, runId: run.id })
        return
      }
      if (run.platform === 'juejin') {
        await juejinView.webContents.loadURL(juejinDraftUrl(run.draftId))
        if (run.state === 'saved') {
          await writeRun(task.id, {
            ...run, state: 'publish-uncertain', manualHandoff: true,
            error: '已打开掘金草稿。提交后请返回工作区核对发布结果。',
          })
        }
        show(juejinView, '掘金草稿编辑器', { taskId: task.id, runId: run.id })
        return
      }
      await zhihuView.webContents.loadURL(draftUrl(run.draftId))
      if (run.state === 'saved') {
        await writeRun(task.id, {
          ...run, state: 'publish-uncertain', manualHandoff: true,
          error: '已交给知乎编辑器处理。请在知乎核对文章状态。',
        })
      }
      show(zhihuView, '知乎草稿编辑器', { taskId: task.id, runId: run.id })
    }),
    'relay:show-article': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = articleRun(task, action?.runId)
      if (action?.openOnly !== true && (run.state === 'publish-uncertain' || (run.platform === 'weibo' && !run.publishedUrl))) {
        progress(task.id, `正在刷新${platformNames[run.platform]}发布状态…`)
        return refreshPublication(task.id, run, true)
      }
      if (run.platform === 'juejin') {
        const id = juejinArticleId(run.publishedUrl ?? '')
        if (!id) throw new Error('这次发布没有可查看的掘金文章链接。')
        await shell.openExternal(juejinArticleUrl(id))
        return { articleOpened: true }
      }
      const url = run.platform === 'weibo' ? weiboArticleUrl(run.publishedUrl ?? '') :
        run.platform === 'jianshu' ? jianshuArticleUrl(run.publishedUrl ?? '') : articleUrl(run.draftId)
      if (!url) throw new Error('这次同步没有可查看的文章链接。')
      try {
        await shell.openExternal(url)
      } catch {
        throw new Error('无法打开系统浏览器。你可以复制同步记录中的文章链接后访问。')
      }
      return { articleOpened: true, needsConfirmation: run.state === 'publish-uncertain' }
    }),
    'relay:open-weibo-result': (action?: Action) => serial(async () => {
      const run = articleRun(selectedTask(action), action?.runId)
      if (run.platform !== 'weibo') throw new Error('这次同步没有可打开的微博页面。')
      const url = weiboArticleUrl(run.publishedUrl ?? '')
      if (url) {
        await shell.openExternal(url)
        return
      }
      show(weiboView, '微博文章管理')
      await weiboView.webContents.loadURL(run.state === 'published' ? weiboHistoryUrl(run.draftId) : weiboEditor)
    }),
    'relay:open-juejin-result': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = articleRun(task, action?.runId)
      if (run.platform !== 'juejin') throw new Error('这次同步没有可打开的掘金页面。')
      if (run.state === 'published') {
        const id = juejinArticleId(run.publishedUrl ?? '')
        if (!id) throw new Error('这次发布没有可查看的掘金文章链接。')
        await shell.openExternal(juejinArticleUrl(id))
        return
      }
      const preview = run.juejinAudit !== 'rejected' && juejinId(run.articleId) ? juejinReviewUrl(run.articleId) : undefined
      show(juejinView, preview ? '掘金审核预览' : '掘金文章管理')
      await juejinView.webContents.loadURL(preview ?? juejinArticles)
    }),
    'relay:mark-published': (action?: Action) => serial(async () => {
      const task = selectedTask(action)
      const run = articleRun(task, action?.runId)
      if (run.platform === 'jianshu') {
        return run.state === 'published' ? { publishedUrl: run.publishedUrl } : refreshPublication(task.id, run, true)
      }
      if (run.platform === 'juejin') {
        if (run.state === 'published') return { publishedUrl: run.publishedUrl }
        const id = juejinArticleId(action?.url ?? '', true)
        if (!id) throw new Error('请输入有效的掘金文章链接。')
        const stopped = await stopJuejinAutoCheck(task.id, run)
        const checked = await juejin.publicationStatus(run.draftId, run.owner, id)
        if (checked.id !== id || (!checked.url && !checked.audit)) throw new Error('未能核实链接对应这份草稿。自动核对已停止。')
        const published = await applyJuejinAuditResult(task.id, stopped, checked)
        return published ?? { checkNotice: juejinAuditNotice(checked, stopped) }
      }
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
  let helpWindow: BrowserWindow | undefined
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === helpUrl) {
      if (helpWindow && !helpWindow.isDestroyed()) {
        if (helpWindow.isMinimized()) helpWindow.restore()
        helpWindow.focus()
      } else {
        helpWindow = new BrowserWindow({
          parent: window, width: 880, height: 760, minWidth: 480, minHeight: 400,
          backgroundColor: '#f3f5f9', autoHideMenuBar: true,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        })
        helpWindow.webContents.on('will-navigate', (event) => event.preventDefault())
        helpWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        void helpWindow.loadURL(helpUrl).catch((error) => console.error('文章同步：帮助页面加载失败。', error))
      }
    }
    return { action: 'deny' }
  })
  window.on('resize', () => resizeBrowser())
  window.on('closed', () => {
    weiboAccountWatch?.abort()
    juejinAuditMonitor.close()
    juejinSession.webRequest.onBeforeRequest(null)
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    zhihuDraftCheckView?.webContents.close()
    for (const view of [sourceView, zhihuView, weiboView, juejinView, jianshuView, tiebaView]) view.webContents.close()
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
  if (initialized) {
    syncJuejinAudits()
    void reconcileWeiboRuns().catch(() => {})
  }
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
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.getParentWindow())
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('window-all-closed', () => app.quit())
}
