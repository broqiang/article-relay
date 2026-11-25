import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import { articleUrl, draftUrl } from './zhihu.js'

type PageState = 'waiting' | 'submitted' | 'published' | 'manual' | 'rate-limited'
export type PublishResult = 'published' | 'manual' | 'uncertain' | 'rate-limited'

type Phase = 'open' | 'confirm' | 'observe'

function publishInEditor(editor: string, article: string, phase: Phase, expiresAt: number): PageState {
  const current = location.origin + location.pathname.replace(/\/$/, '')
  if (current === article) {
    return document.querySelector('h1.Post-Title, .Post-Main h1, article h1') ? 'published' : 'waiting'
  }
  if (current !== editor) return 'manual'
  const visible = (node: HTMLElement) =>
    node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible' && !node.closest('[inert], [aria-hidden="true"]')
  if (phase !== 'open') {
    const notices = [...document.querySelectorAll<HTMLElement>('.Toast, [role="status"], [role="alert"]')]
    if (notices.some((node) => ['发布成功', '文章发布成功', '文章已发布'].includes(node.textContent?.trim() ?? ''))) {
      return 'published'
    }
    if (notices.some((node) => visible(node) && /^近期发布频率过高[，,]请24小时后重试[~～。！!]*$/.test(
      (node.textContent ?? '').replace(/\s+/g, '')))) return 'rate-limited'
  }
  if (phase === 'observe' || Date.now() >= expiresAt) return 'waiting'

  const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open], .Modal')].filter(visible)
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
    visible(button) && !button.matches(':disabled, [aria-disabled="true"]'))
  const label = (button: HTMLButtonElement) => (button.textContent ?? '').trim().replace(/\s+/g, '')
  const candidates = phase === 'open'
    ? buttons.filter((button) => ['发布', '发布文章'].includes(label(button)) && !dialogs.some((dialog) => dialog.contains(button)))
    : buttons.filter((button) => label(button) === '确认发布' && dialogs.some((dialog) => dialog.contains(button)))

  if (phase === 'open' && dialogs.length) return 'manual'
  if (candidates.length !== 1) return 'waiting'
  candidates[0].click()
  return 'submitted'
}

type Editor = Pick<WebContents, 'loadURL' | 'getURL' | 'executeJavaScriptInIsolatedWorld' | 'stop'>

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('知乎页面响应超时。')), Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function inspectEditor(contents: Editor, editor: string, article: string, phase: Phase, deadline: number) {
  const args = JSON.stringify([editor, article, phase, deadline])
  const code = `(${publishInEditor.toString()})(...${args})`
  const result: PageState = await beforeDeadline(
    contents.executeJavaScriptInIsolatedWorld(1001, [{ code }], phase !== 'observe'), deadline)
  return result
}

async function waitForPage(deadline: number): Promise<void> {
  await delay(Math.max(0, Math.min(250, deadline - Date.now())))
}

export async function checkZhihuArticle(contents: Editor, id: string, waitMs = 8_000): Promise<boolean> {
  const article = articleUrl(id)
  const deadline = Date.now() + waitMs
  try {
    await beforeDeadline(contents.loadURL(article), deadline)
  } catch (error) {
    // Chromium can cancel the original load when the site starts a replacement navigation.
    if ((error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') return false
  }
  while (Date.now() < deadline) {
    try {
      // An empty editor URL keeps this check read-only, even if the article redirects to its editor.
      if (await inspectEditor(contents, '', article, 'observe', deadline) === 'published') return true
    } catch {
      // A replacement navigation can temporarily make the document unavailable.
    }
    await waitForPage(deadline)
  }
  return false
}

export async function publishZhihuDraft(contents: Editor, id: string, waitMs = 15_000): Promise<PublishResult> {
  const editor = draftUrl(id)
  const article = articleUrl(id)
  const page = () => contents.getURL().split(/[?#]/, 1)[0].replace(/\/$/, '')
  try {
    await beforeDeadline(contents.loadURL(editor), Date.now() + waitMs)
  } catch {
    contents.stop()
    return 'manual'
  }

  let phase: Phase = 'open'
  let deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const url = page()
    if (url !== editor && url !== article && phase === 'open') return 'manual'
    let state: PageState
    try {
      state = await inspectEditor(contents, editor, article, phase, deadline)
    } catch {
      // Navigation triggered by a click can interrupt the script before it returns.
      phase = 'observe'
      state = 'waiting'
    }
    if (state === 'published' || state === 'rate-limited') return state
    if (state === 'manual' && phase === 'open') return 'manual'
    if (state === 'submitted') {
      phase = phase === 'open' ? 'confirm' : 'observe'
      deadline = Date.now() + waitMs
    }
    await waitForPage(deadline)
  }
  return phase === 'open' ? 'manual' : 'uncertain'
}
