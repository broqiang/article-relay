const byId = (id) => document.getElementById(id)
const relay = window.relay
const platforms = {
  zhihu: { name: '知乎', icon: 'zhihu.ico', open: () => relay.openZhihu() },
  weibo: { name: '微博', icon: 'weibo.ico', open: () => relay.openWeibo() },
  juejin: { name: '掘金', icon: 'juejin.ico', open: () => relay.openJuejin() },
  jianshu: { name: '简书', icon: 'jianshu.ico', open: () => relay.openJianshu() },
}
const platformEntries = Object.entries(platforms)
const importLabels = {
  pending: '待导入', reading: '读取中', paused: '待继续', downloading: '下载图片中', ready: '已导入', failed: '导入失败',
}
const runLabels = {
  running: '准备发布中', saved: '平台草稿已保存', failed: '发布失败',
  publishing: '发布中', published: '已发布', 'publish-uncertain': '发布结果待核对',
}
const juejinAuditLabels = { reviewing: '已提交 · 审核中', rejected: '审核未通过' }
const accountLabels = { checking: '正在检查登录状态…', signedIn: '已登录', signedOut: '未登录', unknown: '登录状态待确认' }
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
const accounts = Object.fromEntries(platformEntries.map(([id]) => [id, { state: 'checking' }]))
let tasks = []
let selectedId
let busy = false
let screen = 'article'
let importReturnScreen = 'article'
let browserLabel = ''
let pendingMessage = ''
let messageIsError = false
let confirmedWeiboAccount
let juejinSettings

function renderMessage() {
  const target = browserLabel ? 'browser-status' : { article: 'status', accounts: 'account-status', import: 'import-status' }[screen]
  for (const id of ['status', 'account-status', 'import-status', 'browser-status']) {
    const node = byId(id)
    node.textContent = id === target ? pendingMessage : ''
    node.classList.toggle('error', id === target && messageIsError)
  }
}

function message(text, error = false) {
  pendingMessage = text
  messageIsError = error
  renderMessage()
}

function renderScreen() {
  const managing = screen === 'accounts'
  byId('workspace-heading').textContent = browserLabel || { article: '同步工作区', accounts: '发布账号', import: '导入文章' }[screen]
  for (const page of ['article', 'accounts', 'import']) {
    byId(`${page}-workspace`).hidden = screen !== page || Boolean(browserLabel)
  }
  byId('browser-status').hidden = !browserLabel
  byId('back').hidden = !browserLabel && screen === 'article'
  const backToAccounts = browserLabel && managing || screen === 'import' && importReturnScreen === 'accounts'
  byId('back-label').textContent = backToAccounts ? '返回账号列表' : '返回工作区'
  if (managing) byId('open-accounts').setAttribute('aria-current', 'page')
  else byId('open-accounts').removeAttribute('aria-current')
  if (screen === 'import') byId('open-import').setAttribute('aria-current', 'page')
  else byId('open-import').removeAttribute('aria-current')
  renderMessage()
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function buttonIcon(name) {
  const namespace = 'http://www.w3.org/2000/svg'
  const icon = document.createElementNS(namespace, 'svg')
  icon.classList.add('button-icon')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(namespace, 'use')
  use.setAttribute('href', `button-icons.svg#${name}`)
  icon.append(use)
  return icon
}

function button(icon, label, className, handler) {
  const control = element('button', label, className)
  if (icon) control.prepend(buttonIcon(icon))
  control.type = 'button'
  control.disabled = busy
  control.addEventListener('click', handler)
  return control
}

function deletePublicationButton(handler) {
  return button('trash', '删除本地发布记录', 'quiet danger delete-publication', handler)
}

function selectedTask() {
  return tasks.find((task) => task.id === selectedId)
}

function platformRun(runs) {
  return runs.find((run) => run.state === 'published') ??
    runs.find((run) => ['publishing', 'publish-uncertain'].includes(run.state)) ?? runs[0]
}

function runLabel(run) {
  return juejinAuditLabels[run.juejinAudit] || runLabels[run.state]
}

function runClass(run) {
  return `run-state ${run.juejinAudit || run.state}`
}

function taskStatus(task) {
  if (task.importState !== 'ready') {
    return element('span', importLabels[task.importState], `task-status ${task.importState}`)
  }
  const current = platformEntries.map(([id]) => platformRun(task.runs.filter((run) => run.platform === id)))
  const published = current.filter((run) => run?.state === 'published').length
  const checking = current.filter((run) => run?.state === 'publish-uncertain' && !run.juejinAudit).length
  const audit = current.find((run) => run?.juejinAudit)?.juejinAudit
  const working = current.some((run) => ['running', 'publishing'].includes(run?.state))
  const failures = current.filter((run) => run?.state === 'failed').length
  const parts = [
    published && `已发布 ${published} 个平台`,
    checking && `${checking} 个平台待核对`,
    audit && `掘金${audit === 'reviewing' ? '审核中' : '审核未通过'}`,
    working && '发布中',
    failures && `${failures} 个平台发布失败`,
  ].filter(Boolean)
  const status = failures || audit === 'rejected' ? 'failed' :
    published === platformEntries.length ? 'published' : 'in-progress'
  return element('span', parts.join(' · ') || '待发布', `task-status ${status}`)
}

function renderControls(task) {
  document.querySelectorAll('.workspace button, .workspace input, #restart').forEach((control) => { control.disabled = busy })
  const ready = task?.importState === 'ready'
  const canPublish = ready && platformEntries.some(([id]) => {
    const run = platformRun(task.runs.filter((item) => item.platform === id))
    return !['published', 'publish-uncertain', 'publishing'].includes(run?.state)
  })
  byId('publish-all').disabled = busy || !canPublish
  byId('retry-import').hidden = !task || !['pending', 'failed', 'paused'].includes(task.importState)
  byId('refresh-import').hidden = !task?.hasArticle || !ready
  byId('continue').hidden = task?.importState !== 'paused' || browserLabel !== '公众号原文'
  document.querySelectorAll('[data-requires-import]').forEach((control) => { control.disabled = busy || !ready })
}

function platformIcon(platform) {
  const icon = document.createElement('img')
  icon.className = 'platform-icon'
  icon.src = platform.icon
  icon.alt = ''
  icon.width = 40
  icon.height = 40
  return icon
}

function renderAccounts() {
  const states = Object.values(accounts)
  const signedIn = states.filter(({ state }) => state === 'signedIn').length
  const checking = states.some(({ state }) => state === 'checking')
  const unknown = states.filter(({ state }) => state === 'unknown').length
  byId('account-summary').textContent = `${states.length} 个平台可登录 · 已登录 ${signedIn} 个` +
    (checking ? ' · 检测中' : unknown ? ` · ${unknown} 个待确认` : '')
  const rows = platformEntries.map(([id, platform]) => {
    const row = element('div', '', 'account-row')
    const identity = element('div', '', 'platform-identity')
    const account = accounts[id]
    const heading = element('div', '', 'account-row-heading')
    heading.append(
      element('strong', platform.name),
      element('span', accountLabels[account.state], `account-badge ${account.state}`),
    )
    identity.append(heading)
    if (account.name) identity.append(element('small', account.name, 'muted'))
    const actions = element('div', '', 'platform-actions')
    if (id === 'juejin') actions.append(button('check', '发布默认值', 'quiet', () => void runAction(openJuejinDefaults)))
    actions.append(
      button('login', account.state === 'signedOut' ? '登录' : `打开${platform.name}`, 'secondary', () => void runAction(() => openAccount(id))),
      button('search', '检查登录', 'quiet', () => void runAction(async () => {
        message(`正在检查${platform.name}登录状态…`)
        const name = await checkAccount(id)
        message(name ? `${platform.name}已登录。` : `${platform.name}尚未登录。`)
      })),
    )
    row.append(platformIcon(platform), identity, actions)
    return row
  })
  byId('account-list').replaceChildren(...rows)
}

function setAccount(id, state, name) {
  accounts[id] = { state, name }
  renderAccounts()
  const task = selectedTask()
  if (task) renderPlatforms(task)
  renderControls(task)
}

function runTime(run) {
  const time = run.finishedAt || run.startedAt
  const node = element('time', dateFormat.format(new Date(time)), 'publication-time muted')
  node.dateTime = time
  return node
}

function publicationActions(task, id, run, canClearLocalHistory = false, current = true) {
  const actions = element('div', '', 'platform-actions publication-actions')
  if (run?.canOpenDraft) {
    actions.append(button('document', '打开草稿', 'secondary', () => void runAction(() => relay.showDraft(task.id, run.id))))
  }
  const primary = current ? platformAction(task, id, run) : run?.draftId && ['published', 'publish-uncertain'].includes(run.state) ?
    articleButton(task, run) : undefined
  if (primary) actions.append(primary)
  if (run?.state === 'publish-uncertain' && run.platform === 'zhihu' && run.draftId) {
    actions.append(button('check', '标记已发布', 'quiet', () => void runAction(async () => {
      if (window.confirm('确认已在知乎看到这篇文章公开发布？')) {
        await showPublishResult(await relay.markPublished(task.id, run.id), run.platform)
      }
    })))
  }
  if (canClearLocalHistory) {
    actions.append(deletePublicationButton(() => void runAction(async () => {
      if (!window.confirm('删除这篇文章的全部掘金本地发布记录和历史？掘金上的草稿和文章会保留。')) return
      await relay.deletePublication(task.id, run.id)
      message('掘金本地发布记录和历史已删除。')
    })))
  }
  if (run?.state === 'published' && run.draftId) {
    actions.append(deletePublicationButton(() => void runAction(async () => {
      const name = platforms[id].name
      if (!window.confirm(`核对${name}已删除这篇文章后，清理该平台的本地发布记录？清理后可以再次发布。`)) return
      await relay.deletePublication(task.id, run.id)
      message(`${name}的本地发布记录已删除，可以再次发布。`)
    })))
  }
  return actions
}

function articleButton(task, run) {
  const refresh = run.state === 'publish-uncertain' || (run.platform === 'weibo' && !run.publishedUrl)
  const [icon, label] = refresh ? ['restart', '刷新状态'] : ['document', '查看文章']
  return button(icon, label, 'secondary', () => void runAction(async () =>
    showPublishResult(await relay.showArticle(task.id, run.id), run.platform)))
}

function platformLink(href, label, open) {
  const link = element('a', label, 'platform-link')
  link.href = href
  link.addEventListener('click', (event) => {
    event.preventDefault()
    void runAction(open)
  })
  return link
}

function publicationLinks(task, id, run) {
  const links = element('div', '', 'publication-links')
  const line = (label, value) => {
    const row = element('div', '', 'publication-link-row')
    row.append(element('span', `${label}：`, 'muted'), typeof value === 'string' ? element('span', value, 'muted') : value)
    links.append(row)
  }
  const pending = run?.state === 'publish-uncertain'
  const published = run?.state === 'published'
  const zhihuUrl = id === 'zhihu' && run?.draftId && /^[1-9]\d*$/.test(run.draftId) ?
    `https://zhuanlan.zhihu.com/p/${run.draftId}` : ''
  const url = published ? run.publishedUrl || zhihuUrl : ''
  const open = async () => {
    if (id === 'zhihu') {
      await showPublishResult(await relay.openZhihuArticle(task.id, run.id), id)
    } else if (id === 'jianshu') {
      await showPublishResult(await relay.showArticle(task.id, run.id), id)
    } else {
      await (id === 'weibo' ? relay.openWeiboResult(task.id, run.id) : relay.openJuejinResult(task.id, run.id))
      message('')
    }
  }
  if (id === 'juejin' && pending && run.juejinAudit !== 'rejected' && /^[1-9]\d*$/.test(run.articleId ?? '')) {
    const preview = `https://juejin.cn/spost/${run.articleId}`
    line('审核链接', platformLink(preview, preview, open))
  }
  line('文章链接', url ? platformLink(url, url, open) : published ? '待匹配' : pending && !run.juejinAudit ? '待核对' : '未发布')
  if (pending && zhihuUrl) line('核对链接', platformLink(zhihuUrl, zhihuUrl, open))
  if (id === 'weibo' && !url && run?.draftId && (pending || published)) {
    const editor = 'https://card.weibo.com/article/v5/editor'
    links.append(platformLink(published ? `${editor}#/history/${run.draftId}` : editor,
      published ? '打开微博发布记录' : '打开微博文章管理', open))
  }
  if (id === 'juejin' && pending && run.draftId && !run.draftMissing &&
      (run.juejinAudit === 'rejected' || !/^[1-9]\d*$/.test(run.articleId ?? ''))) {
    links.append(platformLink('https://juejin.cn/creator/content/article/essays?status=all', '打开掘金创作者中心', open))
  }
  return links
}

function platformAction(task, id, run) {
  if (run && ['published', 'publish-uncertain'].includes(run.state) && run.draftId) return articleButton(task, run)
  if (run && ['running', 'publishing', 'publish-uncertain', 'published'].includes(run.state)) return
  if (accounts[id].state === 'signedOut') {
    return button('login', '登录', 'secondary', () => void runAction(() => openAccount(id)))
  }
  const retry = run?.state === 'failed' || run?.state === 'saved'
  const publish = button(retry ? 'restart' : 'publish', retry ? '重试发布' : '发布', 'secondary', () => void runAction(async () =>
    showPublishResult(await relay.publishArticle(task.id, id), id)))
  publish.dataset.requiresImport = ''
  return publish
}

function renderPlatforms(task) {
  const list = byId('platform-list')
  const detailsState = new Map([...list.querySelectorAll('details')].map((node) => [node.dataset.detailsKey, node.open]))
  list.replaceChildren(...platformEntries.map(([id, platform]) => {
    const runs = task.runs.filter((run) => run.platform === id)
    const current = platformRun(runs)
    const row = element('article', '', 'platform-row')
    const content = element('div', '', 'platform-row-content')
    const header = element('div', '', 'platform-row-heading')
    const identity = element('div', '', 'platform-identity')
    const account = current?.account && current.account !== '账号未确认' ? current.account :
      accounts[id].name || accountLabels[accounts[id].state]
    const metadata = element('small', '', 'publication-account muted')
    metadata.append(element('span', account))
    if (current) metadata.append(runTime(current))
    const state = current?.state
    const ready = task.importState === 'ready'
    const label = current ? runLabel(current) : ready ? '待发布' : '待导入'
    const labelClass = current ? runClass(current) : ready ? 'run-state pending' : 'run-state'
    identity.append(element('strong', platform.name), metadata, element('span', label, labelClass))
    header.append(platformIcon(platform), identity)
    const canClearLocalHistory = id === 'juejin' && runs.length > 0 &&
      runs.every((run) => ['saved', 'failed', 'publish-uncertain'].includes(run.state))
    const details = element('div', '', 'publication-details')
    details.append(header, publicationLinks(task, id, current))

    if (current?.error && state !== 'published') details.append(element('p', current.error,
      `platform-note ${current.juejinAudit === 'reviewing' ? 'muted' : 'run-error'}`))
    if (id === 'juejin' && state === 'publish-uncertain' && current.draftId && !current.draftMissing) {
      if (current.juejinAudit !== 'rejected') {
        details.append(element('p', current.juejinAutoCheckStopped ? '手动核对后已停止自动核对，可继续刷新状态。' :
          '自动核对：首次 30 秒，之后每分钟一次。关闭应用后暂停，手动刷新后停止。', 'platform-note muted'))
      }
    }
    if (current?.draftMissing) details.append(element('p', '平台草稿已失效。', 'platform-note muted'))
    const actions = publicationActions(task, id, current, canClearLocalHistory)
    content.append(details)
    if (actions.childElementCount) content.append(actions)
    row.append(content)
    const older = runs.filter((run) => run !== current)
    if (older.length) {
      const history = element('details', '', 'platform-history')
      history.dataset.detailsKey = `history-${current.id}`
      history.open = detailsState.get(history.dataset.detailsKey) ?? false
      history.append(element('summary', `历史记录（${older.length}）`, 'muted'))
      for (const run of older) {
        const entry = element('div', '', 'history-entry')
        const heading = element('div', '', 'history-heading')
        heading.append(element('strong', runLabel(run), runClass(run)), element('small', run.account, 'muted'), runTime(run))
        entry.append(heading)
        const historyActions = publicationActions(task, id, run, false, false)
        if (historyActions.childElementCount) entry.append(historyActions)
        entry.append(publicationLinks(task, id, run))
        if (run.draftMissing) entry.append(element('p', '平台草稿已失效。', 'platform-note muted'))
        if (run.error) entry.append(element('p', run.error, 'platform-note muted'))
        history.append(entry)
      }
      row.append(history)
    }
    return row
  }))
}

function render() {
  const task = selectedTask()
  byId('no-tasks').hidden = tasks.length > 0
  const list = byId('task-list')
  list.replaceChildren()
  for (const item of tasks) {
    const row = document.createElement('li')
    const control = button(null, '', 'task-button', () => void runAction(async () => {
      selectedId = item.id
      screen = 'article'
      message('')
      await relay.hideBrowser()
    }))
    if (item === task && screen !== 'import') control.setAttribute('aria-current', 'true')
    control.append(element('strong', item.title || '公众号文章'), taskStatus(item))
    row.append(control)
    list.append(row)
  }
  byId('no-article').hidden = Boolean(task)
  byId('summary').hidden = !task
  byId('platform-results').hidden = !task
  if (task) {
    const importStatus = byId('task-status')
    importStatus.textContent = importLabels[task.importState]
    importStatus.className = `result-status ${task.importState}`
    byId('task-title').textContent = task.title || '公众号文章'
    byId('task-source').textContent = task.sourceUrl
    byId('import-extraction').textContent = task.importState === 'ready' ? '' : task.extraction || ''
    byId('import-progress').textContent = task.importDetail
    const progress = byId('download-progress')
    progress.hidden = !task.total || !['downloading', 'failed'].includes(task.importState)
    progress.max = task.total || 1
    progress.value = task.downloaded
    progress.setAttribute('aria-valuetext', `已下载 ${task.downloaded}/${task.total} 张原图`)
    renderPlatforms(task)
  } else {
    byId('platform-list').replaceChildren()
  }
  renderAccounts()
  renderScreen()
  renderControls(task)
}

function updateTasks(items, selection) {
  tasks = items
  selectedId = selection || selectedTask()?.id || tasks[0]?.id
  if (selection && screen === 'import') {
    screen = 'article'
    byId('source-form').reset()
  }
  render()
}

function errorText(error) {
  return String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

async function runAction(work) {
  if (busy) return
  busy = true
  renderControls(selectedTask())
  try {
    await work()
  } catch (error) {
    message(errorText(error), true)
  } finally {
    busy = false
    render()
  }
}

async function checkAccount(id) {
  const confirmation = confirmedWeiboAccount
  try {
    const { name } = await relay.checkAccount(id)
    if (id === 'weibo' && confirmation !== confirmedWeiboAccount) return confirmedWeiboAccount.name
    setAccount(id, name ? 'signedIn' : 'signedOut', name)
    return name
  } catch (error) {
    if (id === 'weibo' && confirmation !== confirmedWeiboAccount) return confirmedWeiboAccount.name
    setAccount(id, 'unknown')
    throw error
  }
}

async function openAccount(id) {
  screen = 'accounts'
  message(`登录后点击「返回账号列表」检查登录状态。`)
  await platforms[id].open()
}

function juejinSettingsMessage(text, error = false) {
  const node = byId('juejin-defaults-status')
  node.textContent = text
  node.classList.toggle('error', error)
}

function renderJuejinTags() {
  const { tags, found, account, saving, searching } = juejinSettings
  const selected = new Set(tags.map(({ id }) => id))
  const full = account.tagLimit !== undefined && tags.length >= account.tagLimit
  byId('juejin-selected-tags').replaceChildren(...tags.map((tag) => {
    const control = button('close', tag.name, 'quiet juejin-selected-tag', () => {
      juejinSettings.tags = tags.filter(({ id }) => id !== tag.id)
      renderJuejinTags()
      byId('juejin-tag-query').focus()
    })
    control.setAttribute('aria-label', `移除标签 ${tag.name}`)
    control.disabled = saving
    return control
  }))
  byId('juejin-tag-results').replaceChildren(...found.filter(({ id }) => !selected.has(id)).map((tag) => {
    const control = button('check', tag.name, 'secondary', () => {
      juejinSettings.tags.push(tag)
      renderJuejinTags()
    })
    control.disabled = full || saving
    return control
  }))
  byId('juejin-category').disabled = saving
  byId('juejin-tag-query').disabled = saving
  byId('juejin-search-tags').disabled = saving || searching
  byId('juejin-close-defaults').disabled = saving
  byId('juejin-save-defaults').disabled = saving || !byId('juejin-category').value || !tags.length ||
    (account.tagLimit !== undefined && tags.length > account.tagLimit)
}

async function openJuejinDefaults() {
  const { account, categories, defaults } = await relay.getJuejinDefaults()
  juejinSettings = { account, categories, tags: defaults?.tags ?? [], found: [], saving: false, searching: false }
  const select = byId('juejin-category')
  select.replaceChildren(new Option('请选择分类', ''), ...categories.map(({ id, name }) => new Option(name, id)))
  select.value = categories.some(({ id }) => id === defaults?.category.id) ? defaults.category.id : ''
  byId('juejin-defaults-account').textContent = account.tagLimit === undefined ? account.name :
    `${account.name} · 最多 ${account.tagLimit} 个标签`
  byId('juejin-tag-query').value = ''
  juejinSettingsMessage(account.tagLimit === 0 ? '当前掘金账号暂时无法添加标签。' : '')
  renderJuejinTags()
  byId('juejin-defaults-dialog').showModal()
}

async function searchJuejinTags() {
  const settings = juejinSettings
  if (!settings || settings.saving || settings.searching) return
  const query = byId('juejin-tag-query').value.trim()
  if (!query) {
    juejinSettingsMessage('请输入要搜索的标签。', true)
    return
  }
  settings.searching = true
  settings.found = []
  juejinSettingsMessage('正在搜索掘金标签…')
  renderJuejinTags()
  try {
    const tags = await relay.searchJuejinTags(settings.account.id, query)
    if (settings !== juejinSettings || settings.saving) return
    settings.found = tags
    juejinSettingsMessage(tags.length ? '' : '没有找到匹配的标签。')
  } catch (error) {
    if (settings === juejinSettings && !settings.saving) juejinSettingsMessage(errorText(error), true)
  } finally {
    settings.searching = false
    if (settings === juejinSettings) renderJuejinTags()
  }
}

async function importTask(request) {
  message('正在准备公众号文章…')
  await request()
  const task = selectedTask()
  message(task?.importState === 'paused' ? task.importDetail : '')
}

async function showPublishResult(result, id) {
  const { name } = platforms[id]
  if (result.loginRequired) {
    setAccount(id, 'signedOut')
    message(`请先登录${name}，再重试发布。`, true)
  } else if (result.published || result.publishedUrl) {
    message(`${name}文章已发布。`)
  } else if (result.articleOpened) {
    message(result.needsConfirmation
      ? '已在系统浏览器打开链接。看到文章后，可在发布详情中标记为已发布。'
      : `已在系统浏览器打开${name}文章。`)
  } else if (result.checkNotice) {
    message(result.checkNotice)
  } else if (result.publishNotice) {
    message(result.publishNotice, !result.saved && !result.reviewing)
  }
}

async function publishAll() {
  message('正在逐个平台发布…')
  const outcomes = await relay.publishAll(selectedId)
  const labels = {
    published: '已发布', 'already-published': '已发布，跳过', 'login-required': '未登录，登录后可补发',
    'needs-check': '结果待核对', reviewing: '已提交，审核中', saved: '草稿已保存', failed: '发布失败',
  }
  for (const { platform, state } of outcomes) {
    if (state === 'login-required') setAccount(platform, 'signedOut')
  }
  message(outcomes.map(({ platform, state, detail }) =>
    `${platforms[platform].name}：${['failed', 'saved'].includes(state) && detail ? detail : labels[state]}`).join(' · '),
    outcomes.some(({ state }) => state === 'failed'))
}

byId('open-accounts').addEventListener('click', () => void runAction(async () => {
  screen = 'accounts'
  message('')
  await relay.hideBrowser()
}))
byId('open-import').addEventListener('click', async () => {
  if (busy) return
  if (screen !== 'import') {
    await runAction(async () => {
      if (browserLabel) await relay.hideBrowser(true)
      importReturnScreen = screen
      screen = 'import'
      message('')
    })
  }
  if (screen === 'import') byId('source-url').focus()
})
byId('source-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const url = byId('source-url').value.trim()
  void runAction(() => importTask(() => relay.importArticle(url)))
})
byId('continue').addEventListener('click', () => void runAction(() => importTask(() => relay.readArticle(selectedId))))
byId('retry-import').addEventListener('click', () => void runAction(() => importTask(() =>
  selectedTask().importState === 'paused' ? relay.readArticle(selectedId) : relay.importTask(selectedId))))
byId('refresh-import').addEventListener('click', () => void runAction(() => importTask(() => relay.importTask(selectedId, true))))
byId('publish-all').addEventListener('click', () => void runAction(publishAll))
byId('delete-task').addEventListener('click', () => void runAction(async () => {
  const task = selectedTask()
  if (!task || !window.confirm(`删除「${task.title || '公众号文章'}」的本地任务、发布记录和已下载的图片？平台上的文章和草稿将继续保留。`)) return
  const { mediaRemoved } = await relay.deleteTask(task.id)
  message(mediaRemoved ? '已删除任务。' : '任务已删除，部分本地图片未能清理。', !mediaRemoved)
}))
byId('back').addEventListener('click', () => void runAction(async () => {
  message('')
  if (!browserLabel) {
    screen = screen === 'import' ? importReturnScreen : 'article'
    return
  }
  const loginPlatform = platformEntries.find(([, platform]) => browserLabel === `${platform.name}账号`)?.[0]
  await relay.hideBrowser(true)
  if (loginPlatform) void checkAccount(loginPlatform).catch(() => {})
}))
if (relay) {
  const defaultsDialog = byId('juejin-defaults-dialog')
  defaultsDialog.addEventListener('close', () => { juejinSettings = undefined })
  defaultsDialog.addEventListener('cancel', (event) => {
    if (juejinSettings?.saving) event.preventDefault()
  })
  byId('juejin-close-defaults').addEventListener('click', () => defaultsDialog.close())
  byId('juejin-category').addEventListener('change', renderJuejinTags)
  byId('juejin-search-tags').addEventListener('click', () => void searchJuejinTags())
  byId('juejin-tag-query').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    void searchJuejinTags()
  })
  byId('juejin-defaults-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const settings = juejinSettings
    const category = settings?.categories.find(({ id }) => id === byId('juejin-category').value)
    if (!category || !settings.tags.length || settings.saving) return
    settings.saving = true
    juejinSettingsMessage('正在保存发布默认值…')
    renderJuejinTags()
    try {
      await relay.saveJuejinDefaults(settings.account.id, { category, tags: settings.tags })
      defaultsDialog.close()
      message('掘金发布默认值已保存。')
    } catch (error) {
      juejinSettingsMessage(errorText(error), true)
    } finally {
      settings.saving = false
      if (defaultsDialog.open && settings === juejinSettings) renderJuejinTags()
    }
  })

  const releaseLink = byId('open-releases')
  releaseLink.addEventListener('click', () => {
    void relay.openReleases().catch((error) => message(errorText(error), true))
  })
  const repository = byId('open-repository')
  repository.disabled = false
  repository.addEventListener('click', () => {
    void relay.openRepository().catch((error) => message(errorText(error), true))
  })

  const settings = byId('settings-popover')
  const settingsStatus = byId('settings-status')
  byId('open-settings').disabled = false
  settings.addEventListener('beforetoggle', (event) => {
    if (event.newState === 'open') settingsStatus.textContent = ''
  })
  settings.addEventListener('toggle', (event) => {
    const open = event.newState === 'open'
    void relay.setSettingsOpen(open).catch((error) => {
      if (open) settings.hidePopover()
      message(errorText(error), true)
    })
  })
  byId('restart').addEventListener('click', () => void runAction(async () => {
    settingsStatus.textContent = ''
    try {
      await relay.restart()
    } catch (error) {
      settingsStatus.textContent = errorText(error)
    }
  }))

  relay.onProgress((taskId, label) => {
    if (taskId !== selectedId) return
    message(label)
  })
  relay.onBrowser((label) => {
    browserLabel = label
    renderScreen()
    renderControls(selectedTask())
  })
  relay.onWeiboAccountChanged((name) => {
    confirmedWeiboAccount = { name }
    setAccount('weibo', name ? 'signedIn' : 'signedOut', name)
  })
  relay.onTasksChanged(updateTasks)
  void runAction(async () => updateTasks(await relay.listTasks()))
  void relay.getVersion().then((version) => {
    byId('app-version').textContent = `v${version}`
    releaseLink.hidden = false
    return relay.hasUpdate()
  }).then((hasUpdate) => {
    byId('update-badge').hidden = !hasUpdate
  }).catch(() => {})
  for (const [id] of platformEntries) void checkAccount(id).catch(() => {})
} else {
  busy = true
  for (const [id] of platformEntries) accounts[id] = { state: 'unknown' }
  message('应用连接未能启动，请关闭并重新打开应用。', true)
  render()
}
document.documentElement.dataset.relayReady = 'true'
