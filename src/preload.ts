// A sandboxed preload provides require('electron') without CommonJS exports.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')
type RelayPlatform = import('./tasks.js').Platform
type JuejinDefaults = import('./juejin.js').JuejinDefaults

contextBridge.exposeInMainWorld('relay', {
  getVersion: () => ipcRenderer.invoke('relay:version'),
  hasUpdate: () => ipcRenderer.invoke('relay:has-update'),
  openReleases: () => ipcRenderer.invoke('relay:open-releases'),
  openRepository: () => ipcRenderer.invoke('relay:open-repository'),
  setSettingsOpen: (settingsOpen: boolean) => ipcRenderer.invoke('relay:settings-open', { settingsOpen }),
  getEnabledPlatforms: () => ipcRenderer.invoke('relay:enabled-platforms'),
  saveEnabledPlatforms: (enabledPlatforms: RelayPlatform[]) => ipcRenderer.invoke('relay:save-enabled-platforms', { enabledPlatforms }),
  restart: () => ipcRenderer.invoke('relay:restart'),
  openZhihu: () => ipcRenderer.invoke('relay:open-zhihu'),
  openWeibo: () => ipcRenderer.invoke('relay:open-weibo'),
  openJuejin: () => ipcRenderer.invoke('relay:open-juejin'),
  openJianshu: () => ipcRenderer.invoke('relay:open-jianshu'),
  openDouban: () => ipcRenderer.invoke('relay:open-douban'),
  getJuejinDefaults: () => ipcRenderer.invoke('relay:juejin-defaults'),
  searchJuejinTags: (owner: string, query: string) => ipcRenderer.invoke('relay:juejin-tags', { owner, query }),
  saveJuejinDefaults: (owner: string, defaults: JuejinDefaults) => ipcRenderer.invoke('relay:save-juejin-defaults', { owner, defaults }),
  checkAccount: (platform?: RelayPlatform) => platform
    ? ipcRenderer.invoke('relay:account', { platform }) : ipcRenderer.invoke('relay:account'),
  listTasks: () => ipcRenderer.invoke('relay:tasks'),
  deleteTask: (taskId: string) => ipcRenderer.invoke('relay:delete-task', { taskId }),
  deletePublication: (taskId: string, runId: string) => ipcRenderer.invoke('relay:delete-publication', { taskId, runId }),
  importArticle: (url: string) => ipcRenderer.invoke('relay:import', { url }),
  importTask: (taskId: string, refresh = false) => ipcRenderer.invoke('relay:import', { taskId, refresh }),
  readArticle: (taskId: string) => ipcRenderer.invoke('relay:read', { taskId }),
  showDraft: (taskId: string, runId: string) => ipcRenderer.invoke('relay:show-draft', { taskId, runId }),
  hideBrowser: (returnFromDraft = false) => returnFromDraft
    ? ipcRenderer.invoke('relay:hide-browser', { returnFromDraft }) : ipcRenderer.invoke('relay:hide-browser'),
  publishArticle: (taskId: string, platform?: RelayPlatform) =>
    ipcRenderer.invoke('relay:publish', platform ? { taskId, platform } : { taskId }),
  publishAll: (taskId: string) => ipcRenderer.invoke('relay:publish-all', { taskId }),
  showArticle: (taskId: string, runId: string) => ipcRenderer.invoke('relay:show-article', { taskId, runId }),
  openZhihuArticle: (taskId: string, runId: string) => ipcRenderer.invoke('relay:show-article', { taskId, runId, openOnly: true }),
  openDoubanResult: (taskId: string, runId: string) => ipcRenderer.invoke('relay:open-douban-result', { taskId, runId }),
  openWeiboResult: (taskId: string, runId: string) => ipcRenderer.invoke('relay:open-weibo-result', { taskId, runId }),
  openJuejinResult: (taskId: string, runId: string) => ipcRenderer.invoke('relay:open-juejin-result', { taskId, runId }),
  markPublished: (taskId: string, runId: string, url?: string) =>
    ipcRenderer.invoke('relay:mark-published', url ? { taskId, runId, url } : { taskId, runId }),
  onProgress: (callback: (taskId: string, label: string) => void) => {
    ipcRenderer.on('relay:progress', (_event, taskId, label) => callback(taskId, label))
  },
  onTasksChanged: (callback: (tasks: unknown, selected?: string) => void) => {
    ipcRenderer.on('relay:tasks-changed', (_event, tasks, selected) => callback(tasks, selected))
  },
  onBrowser: (callback: (label: string) => void) => {
    ipcRenderer.on('relay:browser', (_event, label: string) => callback(label))
  },
  onWeiboAccountChanged: (callback: (name: string | null) => void) => {
    ipcRenderer.on('relay:weibo-account-changed', (_event, name: string | null) => callback(name))
  },
})
