// A sandboxed preload provides require('electron') without CommonJS exports.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron')

contextBridge.exposeInMainWorld('relay', {
  openZhihu: () => ipcRenderer.invoke('relay:open-zhihu'),
  checkAccount: () => ipcRenderer.invoke('relay:account'),
  listTasks: () => ipcRenderer.invoke('relay:tasks'),
  deleteTask: (taskId: string) => ipcRenderer.invoke('relay:delete-task', { taskId }),
  importArticle: (url: string) => ipcRenderer.invoke('relay:import', { url }),
  importTask: (taskId: string, refresh = false) => ipcRenderer.invoke('relay:import', { taskId, refresh }),
  readArticle: (taskId: string) => ipcRenderer.invoke('relay:read', { taskId }),
  showDraft: (taskId: string, runId: string) => ipcRenderer.invoke('relay:show-draft', { taskId, runId }),
  hideBrowser: () => ipcRenderer.invoke('relay:hide-browser'),
  publishArticle: (taskId: string) => ipcRenderer.invoke('relay:publish', { taskId }),
  showArticle: (taskId: string, runId: string) => ipcRenderer.invoke('relay:show-article', { taskId, runId }),
  markPublished: (taskId: string, runId: string) => ipcRenderer.invoke('relay:mark-published', { taskId, runId }),
  onProgress: (callback: (taskId: string, label: string) => void) => {
    ipcRenderer.on('relay:progress', (_event, taskId, label) => callback(taskId, label))
  },
  onTasksChanged: (callback: (tasks: unknown, selected?: string) => void) => {
    ipcRenderer.on('relay:tasks-changed', (_event, tasks, selected) => callback(tasks, selected))
  },
  onBrowser: (callback: (label: string) => void) => {
    ipcRenderer.on('relay:browser', (_event, label: string) => callback(label))
  },
})
