const byId = (id) => document.getElementById(id)
const relay = window.relay
const status = byId('status')
const accountName = byId('account-name')
const appVersion = byId('app-version')
const importLabels = {
  pending: '待导入', reading: '读取中', paused: '待继续', downloading: '下载图片中', ready: '已保存到本地', failed: '导入失败',
}
const runLabels = {
  running: '同步中', saved: '草稿已保存', failed: '同步失败',
  publishing: '发布中', published: '已发布', 'publish-uncertain': '发布结果待核对',
}
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
let tasks = []
let selectedId
let busy = false
let browserLabel = ''
let activeProgress = ''

function message(text, error = false) {
  status.textContent = text
  status.classList.toggle('error', error)
}

function browser(label) {
  browserLabel = label
  byId('workspace-heading').textContent = label || '同步工作区'
  byId('back').hidden = !label
}

function element(tag, text, className) {
  const node = document.createElement(tag)
  node.textContent = text
  if (className) node.className = className
  return node
}

function button(label, className, handler) {
  const control = element('button', label, className)
  control.type = 'button'
  control.addEventListener('click', handler)
  return control
}

function selectedTask() {
  return tasks.find((task) => task.id === selectedId)
}

function taskLabel(task) {
  if (task.importState !== 'ready') return importLabels[task.importState]
  const latest = task.runs[0]
  return latest ? runLabels[latest.state] : importLabels.ready
}

function renderControls(task) {
  document.querySelectorAll('button, input').forEach((control) => { control.disabled = busy })
  byId('publish').disabled = busy || task?.importState !== 'ready'
  byId('retry-import').hidden = !task || !['pending', 'failed', 'paused'].includes(task.importState)
  byId('refresh-import').hidden = !task?.hasArticle || task.importState !== 'ready'
  byId('continue').hidden = task?.importState !== 'paused' || browserLabel !== '公众号原文'
}

function renderRuns(task) {
  byId('no-runs').hidden = task.runs.length > 0
  const list = byId('run-list')
  list.replaceChildren()
  const closedDrafts = new Set(task.runs.filter((run) =>
    ['publishing', 'published', 'publish-uncertain'].includes(run.state)).map((run) => run.draftId))
  for (const run of task.runs) {
    const row = document.createElement('li')
    const heading = document.createElement('div')
    heading.className = 'run-heading'
    heading.append(element('strong', `知乎 · ${run.account}`), element('span', runLabels[run.state], `run-state ${run.state}`))
    row.append(heading, element('p', dateFormat.format(new Date(run.startedAt)), 'muted'))
    if (run.error) row.append(element('p', run.error, 'run-error'))
    if (['running', 'publishing'].includes(run.state) && activeProgress) row.append(element('p', activeProgress, 'muted'))
    if (run.draftMissing) row.append(element('p', '该草稿链接已失效。', 'muted'))
    if (run.state === 'saved' && run.error && run.draftId && !run.draftMissing && !closedDrafts.has(run.draftId)) {
      const actions = document.createElement('div')
      actions.className = 'history-actions'
      actions.append(button('打开草稿', 'secondary', () => void runAction(() => relay.showDraft(task.id, run.id))))
      row.append(actions)
    }
    if (run.draftId && ['published', 'publish-uncertain'].includes(run.state)) {
      row.append(element('p', `https://zhuanlan.zhihu.com/p/${run.draftId}`, 'muted source-link'))
      const actions = document.createElement('div')
      actions.className = 'history-actions'
      actions.append(
        button(run.state === 'published' ? '查看文章' : '核对发布结果', 'secondary', () =>
          void runAction(async () => { await showPublishResult(await relay.showArticle(task.id, run.id)) })),
      )
      if (run.state === 'publish-uncertain') {
        actions.append(button('标记已发布', 'quiet', () => void runAction(async () => {
          if (window.confirm('请确认你已在知乎看到这篇文章公开发布。现在将同步记录标记为已发布？')) {
            await showPublishResult(await relay.markPublished(task.id, run.id))
          }
        })))
      }
      row.append(actions)
    }
    list.append(row)
  }
}

function render() {
  const task = selectedTask()
  byId('no-tasks').hidden = tasks.length > 0
  const list = byId('task-list')
  list.replaceChildren()
  for (const item of tasks) {
    const row = document.createElement('li')
    const control = button('', 'task-button', () => void runAction(async () => {
      selectedId = item.id
      activeProgress = ''
      message('')
      await relay.hideBrowser()
    }))
    if (item === task) control.setAttribute('aria-current', 'true')
    control.append(element('strong', item.title || '公众号文章'), element('small', taskLabel(item)))
    row.append(control)
    list.append(row)
  }
  byId('summary').hidden = !task
  byId('empty').hidden = Boolean(task)
  if (task) {
    byId('task-status').textContent = taskLabel(task)
    byId('task-title').textContent = task.title || '公众号文章'
    byId('task-source').textContent = task.sourceUrl
    byId('import-extraction').textContent = task.extraction || ''
    byId('import-progress').textContent = task.importDetail
    const progress = byId('download-progress')
    progress.hidden = task.total === 0
    progress.max = task.total || 1
    progress.value = task.downloaded
    progress.setAttribute('aria-valuetext', `已下载 ${task.downloaded}/${task.total} 张原图`)
    renderRuns(task)
  }
  renderControls(task)
}

function updateTasks(items, selection) {
  tasks = items
  selectedId = selection || selectedTask()?.id || tasks[0]?.id
  render()
}

async function runAction(work) {
  if (busy) return
  busy = true
  renderControls(selectedTask())
  try {
    await work()
  } catch (error) {
    message(String(error.message).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), true)
  } finally {
    busy = false
    render()
  }
}

async function checkAccount() {
  try {
    const { name } = await relay.checkAccount()
    accountName.textContent = name || '尚未登录'
    return name
  } catch (error) {
    accountName.textContent = '暂时无法确认登录状态'
    throw error
  }
}

async function importTask(request) {
  activeProgress = ''
  message('正在准备公众号素材…')
  await request()
  const task = selectedTask()
  if (task) message(task.importDetail, task.importState === 'failed')
}

async function showPublishResult(result) {
  if (result.loginRequired) {
    await relay.openZhihu()
    message('请在右侧登录知乎后重试。')
  } else if (result.publishedUrl) {
    message('知乎文章已发布。')
  } else if (result.articleOpened) {
    message(result.needsConfirmation
      ? '已在系统浏览器打开链接。看到文章后，可回来点「标记已发布」。'
      : '已在系统浏览器打开知乎文章。')
  } else if (result.publishNotice) {
    message(result.publishNotice, true)
  }
}

byId('source-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void runAction(() => importTask(() => relay.importArticle(byId('source-url').value.trim())))
})
byId('continue').addEventListener('click', () => void runAction(() => importTask(() => relay.readArticle(selectedId))))
byId('retry-import').addEventListener('click', () => void runAction(() => importTask(() => {
  return selectedTask().importState === 'paused' ? relay.readArticle(selectedId) : relay.importTask(selectedId)
})))
byId('refresh-import').addEventListener('click', () => void runAction(() => importTask(() => relay.importTask(selectedId, true))))
byId('delete-task').addEventListener('click', () => void runAction(async () => {
  const task = selectedTask()
  if (!task || !window.confirm(`删除「${task.title || '公众号文章'}」的本地任务、同步记录和已下载的图片？知乎上的草稿和文章将继续保留。`)) return
  const { mediaRemoved } = await relay.deleteTask(task.id)
  activeProgress = ''
  message(mediaRemoved ? '已删除任务。' : '任务已删除，部分本地图片未能清理。', !mediaRemoved)
}))

byId('publish').addEventListener('click', () => void runAction(async () => {
  await showPublishResult(await relay.publishArticle(selectedId))
}))

byId('login').addEventListener('click', () => void runAction(async () => {
  message('正在打开知乎…')
  await relay.openZhihu()
  message('登录后点击「检查登录」。')
}))
byId('check').addEventListener('click', () => void runAction(async () => {
  message('正在检查知乎登录状态…')
  const name = await checkAccount()
  if (name && browserLabel === '知乎账号') await relay.hideBrowser()
  message(name ? '知乎账号已连接。' : '当前应用会话尚未登录知乎。')
}))
byId('back').addEventListener('click', () => void runAction(() => relay.hideBrowser()))
byId('open-releases').addEventListener('click', () => void runAction(() => relay.openReleases()))
byId('restart').addEventListener('click', () => void runAction(() => relay.restart()))

if (relay) {
  relay.onProgress((taskId, label) => {
    if (taskId !== selectedId) return
    activeProgress = label
    message(label)
    render()
  })
  relay.onBrowser((label) => {
    browser(label)
    renderControls(selectedTask())
  })
  relay.onTasksChanged(updateTasks)
  void runAction(async () => updateTasks(await relay.listTasks()))
  void relay.getVersion().then((version) => {
    appVersion.textContent = `版本 ${version}`
  }).catch(() => { appVersion.textContent = '版本未读取' })
  accountName.textContent = '正在检查登录状态…'
  void checkAccount().catch(() => {})
} else {
  appVersion.textContent = '版本未读取'
  accountName.textContent = '应用连接未初始化'
  message('应用连接未能启动，请关闭并重新打开应用。', true)
  document.querySelectorAll('button, input').forEach((control) => { control.disabled = true })
}
document.documentElement.dataset.relayReady = 'true'
