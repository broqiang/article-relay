const byId = (id) => document.getElementById(id)
const relay = window.relay
const platforms = {
  zhihu: { name: '知乎', icon: 'zhihu.ico', open: () => relay.openZhihu() },
  weibo: { name: '微博', icon: 'weibo.ico', open: () => relay.openWeibo() },
}
const platformEntries = Object.entries(platforms)
const importLabels = {
  pending: '待导入', reading: '读取中', paused: '待继续', downloading: '下载图片中', ready: '已导入', failed: '导入失败',
}
const runLabels = {
  running: '准备发布中', saved: '平台草稿已保存', failed: '发布失败',
  publishing: '发布中', published: '已发布', 'publish-uncertain': '发布结果待核对',
}
const accountLabels = { checking: '正在检查登录状态…', signedIn: '已登录', signedOut: '未登录', unknown: '登录状态待确认' }
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
const accounts = Object.fromEntries(platformEntries.map(([id]) => [id, { state: 'checking' }]))
let tasks = []
let selectedId
let busy = false
let screen = 'article'
let browserLabel = ''
let pendingMessage = ''
let messageIsError = false
let confirmedWeiboAccount

function renderMessage() {
  const target = browserLabel ? 'browser-status' : screen === 'accounts' ? 'account-status' : 'status'
  for (const id of ['status', 'account-status', 'browser-status']) {
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
  byId('workspace-heading').textContent = browserLabel || (managing ? '发布账号' : '同步工作区')
  byId('article-workspace').hidden = managing || Boolean(browserLabel)
  byId('accounts-workspace').hidden = !managing || Boolean(browserLabel)
  byId('browser-status').hidden = !browserLabel
  byId('back').hidden = !browserLabel && !managing
  byId('back-label').textContent = browserLabel && managing ? '返回账号列表' : '返回工作区'
  if (managing) byId('open-accounts').setAttribute('aria-current', 'page')
  else byId('open-accounts').removeAttribute('aria-current')
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
  control.prepend(buttonIcon(icon))
  control.type = 'button'
  control.disabled = busy
  control.addEventListener('click', handler)
  return control
}

function selectedTask() {
  return tasks.find((task) => task.id === selectedId)
}

function platformRun(runs) {
  return runs.find((run) => run.state === 'published') ??
    runs.find((run) => ['publishing', 'publish-uncertain'].includes(run.state)) ?? runs[0]
}

function taskLabel(task) {
  if (task.importState !== 'ready') return importLabels[task.importState]
  const current = platformEntries.map(([id]) => platformRun(task.runs.filter((run) => run.platform === id)))
  const published = current.filter((run) => run?.state === 'published').length
  const checking = current.filter((run) => run?.state === 'publish-uncertain').length
  const working = current.some((run) => ['running', 'publishing'].includes(run?.state))
  const failures = current.filter((run) => run?.state === 'failed').length
  const parts = [
    published && `已发布 ${published} 个平台`,
    checking && `${checking} 个平台待核对`,
    working && '发布中',
    failures && `${failures} 个平台发布失败`,
  ].filter(Boolean)
  return parts.join(' · ') || '待发布'
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
  byId('account-summary').textContent = `支持 ${states.length} 个平台 · 已登录 ${signedIn} 个` +
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

function runInformation(task, run, platform, pendingLinks) {
  const body = element('div', '', 'run-detail')
  const time = run.finishedAt || run.startedAt
  body.append(element('p', [run.account, dateFormat.format(new Date(time))].filter(Boolean).join(' · '), 'muted'))
  if (run.error) body.append(element('p', run.error, 'run-error'))
  if (run.draftMissing) body.append(element('p', '平台草稿已失效。', 'muted'))
  const url = run.publishedUrl || (run.platform === 'zhihu' && run.draftId && ['published', 'publish-uncertain'].includes(run.state)
    ? `https://zhuanlan.zhihu.com/p/${run.draftId}` : '')
  if (url) body.append(element('p', url, 'muted source-link'))

  const actions = element('div', '', 'platform-actions')
  const closed = task.runs.some((item) => item.platform === run.platform && item.account === run.account &&
    item.draftId === run.draftId && ['publishing', 'published', 'publish-uncertain'].includes(item.state))
  if (run.draftId && !run.draftMissing && run.error &&
      ((run.state === 'saved' && !closed) || (run.state === 'publish-uncertain' && run.manualHandoff))) {
    actions.append(button('document', '打开平台草稿', 'secondary', () => void runAction(() => relay.showDraft(task.id, run.id))))
  }
  if (run.state === 'publish-uncertain' && run.platform === 'zhihu' && run.draftId) {
    actions.append(button('check', '标记已发布', 'quiet', () => void runAction(async () => {
      if (window.confirm('确认已在知乎看到这篇文章公开发布？')) {
        await showPublishResult(await relay.markPublished(task.id, run.id), run.platform)
      }
    })))
  }
  if (run.state === 'published' && run.draftId) {
    actions.append(button('trash', '删除本地发布记录', 'quiet danger delete-publication', () => void runAction(async () => {
      if (!window.confirm(`核对${platform.name}已删除这篇文章后，清理该平台的本地发布记录？清理后可以再次发布。`)) return
      await relay.deletePublication(task.id, run.id)
      message(`${platform.name}的本地发布记录已删除，可以再次发布。`)
    })))
  }
  if (actions.childElementCount) body.append(actions)

  if (run.platform === 'weibo' && run.draftId && !url && ['published', 'publish-uncertain'].includes(run.state)) {
    const form = element('form', '', 'article-check')
    const input = document.createElement('input')
    input.type = 'url'
    input.required = true
    input.placeholder = '粘贴微博头条文章链接'
    input.setAttribute('aria-label', '微博头条文章链接')
    input.dataset.runId = run.id
    input.value = pendingLinks.get(run.id) || ''
    const submit = element('button', '核对链接', 'secondary')
    submit.prepend(buttonIcon('link'))
    submit.type = 'submit'
    form.append(input, submit)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void runAction(async () => showPublishResult(await relay.markPublished(task.id, run.id, input.value.trim()), run.platform))
    })
    body.append(form)
  }
  return body
}

function articleButton(task, run) {
  const [icon, label] = run.state === 'publish-uncertain' ? ['search', '核对结果'] :
    run.platform === 'weibo' && !run.publishedUrl ? ['link', '查找文章链接'] : ['document', '查看文章']
  return button(icon, label, 'secondary', () => void runAction(async () =>
    showPublishResult(await relay.showArticle(task.id, run.id), run.platform)))
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
  const pendingLinks = new Map([...list.querySelectorAll('[data-run-id]')].map((input) => [input.dataset.runId, input.value]))
  const expanded = new Set([...list.querySelectorAll('details[open]')].map((node) => node.dataset.detailsKey))
  list.replaceChildren(...platformEntries.map(([id, platform]) => {
    const runs = task.runs.filter((run) => run.platform === id)
    const current = platformRun(runs)
    const row = element('article', '', 'platform-row')
    const content = element('div', '', 'platform-row-content')
    const header = element('div', '', 'platform-row-heading')
    const identity = element('div', '', 'platform-identity')
    const account = current?.account && current.account !== '账号未确认' ? current.account :
      accounts[id].name || accountLabels[accounts[id].state]
    identity.append(element('strong', platform.name), element('small', account, 'muted'))
    const state = current?.state
    const label = current ? runLabels[state] : task.importState === 'ready' ? '待发布' : '待导入'
    const actions = element('div', '', 'platform-actions')
    const primary = platformAction(task, id, current)
    actions.append(element('span', label, `run-state ${state || ''}`))
    if (primary) actions.append(primary)
    header.append(identity, actions)
    content.append(header)
    row.append(platformIcon(platform), content)

    if (current?.error && state !== 'published') content.append(element('p', current.error, 'platform-note run-error'))
    if (runs.length) {
      const details = document.createElement('details')
      details.dataset.detailsKey = current.id
      details.open = expanded.has(current.id)
      details.append(element('summary', '发布详情', 'muted'), runInformation(task, current, platform, pendingLinks))
      const older = runs.filter((run) => run !== current)
      if (older.length) {
        const history = element('details', '', 'platform-history')
        history.dataset.detailsKey = `history-${current.id}`
        history.open = expanded.has(history.dataset.detailsKey)
        history.append(element('summary', `历史记录（${older.length}）`, 'muted'))
        for (const run of older) {
          const entry = element('div', '', 'history-entry')
          entry.append(element('strong', runLabels[run.state], `run-state ${run.state}`))
          if (['published', 'publish-uncertain'].includes(run.state) && run.draftId) entry.append(articleButton(task, run))
          entry.append(runInformation(task, run, platform, pendingLinks))
          history.append(entry)
        }
        details.append(history)
      }
      content.append(details)
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
    const control = button('document', '', 'task-button', () => void runAction(async () => {
      selectedId = item.id
      screen = 'article'
      message('')
      await relay.hideBrowser()
    }))
    if (item === task) control.setAttribute('aria-current', 'true')
    control.append(element('strong', item.title || '公众号文章'), element('small', taskLabel(item)))
    row.append(control)
    list.append(row)
  }
  byId('summary').hidden = !task
  byId('platform-results').hidden = !task
  if (task) {
    byId('task-status').textContent = importLabels[task.importState]
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
    message(result.publishNotice, true)
  }
}

async function publishAll() {
  message('正在逐个平台发布…')
  const outcomes = await relay.publishAll(selectedId)
  const labels = {
    published: '已发布', 'already-published': '已发布，跳过', 'login-required': '未登录，登录后可补发',
    'needs-check': '结果待核对', failed: '发布失败',
  }
  for (const { platform, state } of outcomes) {
    if (state === 'login-required') setAccount(platform, 'signedOut')
  }
  message(outcomes.map(({ platform, state, detail }) =>
    `${platforms[platform].name}：${state === 'failed' && detail ? detail : labels[state]}`).join(' · '),
    outcomes.some(({ state }) => state === 'failed'))
}

byId('open-accounts').addEventListener('click', () => void runAction(async () => {
  screen = 'accounts'
  message('')
  await relay.hideBrowser()
}))
byId('source-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void runAction(async () => {
    const input = byId('source-url')
    await importTask(() => relay.importArticle(input.value.trim()))
    input.value = ''
  })
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
    screen = 'article'
    return
  }
  const loginPlatform = platformEntries.find(([, platform]) => browserLabel === `${platform.name}账号`)?.[0]
  await relay.hideBrowser()
  if (loginPlatform) void checkAccount(loginPlatform).catch(() => {})
}))
if (relay) {
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
