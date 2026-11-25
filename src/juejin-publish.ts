import { setTimeout as delay } from 'node:timers/promises'
import { juejinArticleId, juejinDraftUrl, juejinId, type JuejinDefaults } from './juejin.js'

type Editor = {
  loadURL(url: string): Promise<void>
  getURL(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

type ExpectedDraft = { owner: string; title: string; defaults?: JuejinDefaults }
type EditorStep = 'waiting' | 'clicked' | 'prepared' | 'wrong-draft' | 'verification' | 'missing-defaults' | 'invalid-defaults' | 'incomplete'

function editorStep(url: string, draftId: string, expected: ExpectedDraft, step: 'open' | 'prepare' | 'confirm', deadline: number): EditorStep {
  if (Date.now() >= deadline || `${location.origin}${location.pathname}` !== url) return 'waiting'
  type Tag = { id: string; title?: string; tag_id?: string }
  type Category = { id: string; title?: string }
  type Popup = {
    userId?: string; isDraft?: boolean; canPublish?: boolean; tagLimit?: number; summaryLoading?: boolean;
    categoryList?: Category[]; handleTagsChange?: (tags: Tag[]) => void;
    post?: { id?: string; title?: string; markdown?: string; html?: string; category?: Category; tags?: Tag[]; brief_content?: string };
  }
  const scope = document.querySelector<HTMLElement & { __vue__?: Popup }>('.editor-header .publish-popup')
  const popup = scope?.__vue__
  const post = popup?.post
  if (!scope || !popup || !post?.id || !popup.userId || typeof popup.isDraft !== 'boolean') return 'waiting'
  if (!popup.isDraft || post.id !== draftId || popup.userId !== expected.owner || post.title?.trim() !== expected.title.trim()) return 'wrong-draft'
  if (popup.canPublish === false) return 'verification'
  const hasCategory = Boolean(post.category?.id && post.category.id !== '0')
  const hasTags = Boolean(post.tags?.length)
  if (step === 'prepare') {
    if (!hasCategory || !hasTags) {
      if (!expected.defaults) return 'missing-defaults'
      if (!popup.categoryList?.length || typeof popup.handleTagsChange !== 'function') return 'waiting'
      const category = popup.categoryList.find(({ id }) => id === expected.defaults?.category.id)
      if ((!hasCategory && !category) || (!hasTags && typeof popup.tagLimit === 'number' && expected.defaults.tags.length > popup.tagLimit)) {
        return 'invalid-defaults'
      }
      if (!hasCategory && category) post.category = category
      if (!hasTags) popup.handleTagsChange(expected.defaults.tags.map(({ id, name }) => ({ id, title: name })))
    }
    if (popup.summaryLoading) return 'waiting'
    return 'prepared'
  }
  const confirm = step === 'confirm'
  if (confirm && (!hasCategory || !hasTags || (post.brief_content?.trim().length ?? 0) < 50 ||
      ![post.markdown, post.html].some((body) => body?.trim()))) return 'incomplete'
  const buttons = Array.from(scope.querySelectorAll('button')).filter((button) =>
    button.textContent?.trim() === (confirm ? '确定并发布' : '发布') &&
    Boolean(button.closest('.panel')) === confirm && button.getClientRects().length &&
    !button.disabled && button.getAttribute('aria-disabled') !== 'true')
  if (buttons.length !== 1) return 'waiting'
  buttons[0].click()
  return 'clicked'
}

export async function publishJuejinDraft(contents: Editor, draftId: string, expected: ExpectedDraft,
  { waitMs = 12_000, resultWaitMs = 45_000, beforeConfirm, submissionRejected }: {
    waitMs?: number; resultWaitMs?: number; beforeConfirm?: () => Promise<void>; submissionRejected?: () => boolean
  } = {}): Promise<{
  submitted: boolean; articleId?: string; reason?: EditorStep
}> {
  const url = juejinDraftUrl(draftId)
  let deadline = Date.now() + waitMs
  let confirmationStarted = false

  async function timed<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('掘金编辑器响应超时。')), Math.max(0, deadline - Date.now()))
      })])
    } finally {
      clearTimeout(timer)
    }
  }

  function onDraft(): boolean {
    try {
      const current = new URL(contents.getURL())
      return `${current.origin}${current.pathname}` === url
    } catch { return false }
  }

  async function runStep(step: 'open' | 'prepare' | 'confirm'): Promise<EditorStep> {
    while (Date.now() < deadline && onDraft()) {
      if (step === 'confirm') confirmationStarted = true
      const args = [url, draftId, expected, step, deadline].map((value) => JSON.stringify(value)).join(', ')
      const result = await timed(contents.executeJavaScript(`(${editorStep.toString()})(${args})`, true)) as EditorStep
      if (step === 'confirm' && result !== 'clicked') confirmationStarted = false
      if (result !== 'waiting') return result
      await delay(150)
    }
    return 'waiting'
  }

  try {
    await timed(contents.loadURL(url))
    const opened = await runStep('open')
    if (opened !== 'clicked') return { submitted: false, reason: opened }
    const prepared = await runStep('prepare')
    if (prepared !== 'prepared') return { submitted: false, reason: prepared }
    if (beforeConfirm) {
      const startedAt = Date.now()
      await beforeConfirm()
      deadline += Date.now() - startedAt
    }
    const confirmed = await runStep('confirm')
    if (confirmed !== 'clicked') return { submitted: false, reason: confirmed }
  } catch {
    if (!confirmationStarted) return { submitted: false }
  }

  // The editor updates images and saves the draft before sending the publication request.
  deadline = Date.now() + resultWaitMs
  while (Date.now() < deadline) {
    try {
      const current = contents.getURL()
      const articleId = juejinArticleId(current, true)
      if (articleId) return { submitted: true, articleId }
      const address = new URL(current)
      if (address.origin === 'https://juejin.cn' && /^\/published\/?$/.test(address.pathname)) {
        const id = await timed(contents.executeJavaScript(`(() => {
          const info = JSON.parse(sessionStorage.getItem('PUB_INFO') || 'null');
          return info?.type === 'post' ? info.id : null;
        })()`))
        if (juejinId(id)) return { submitted: true, articleId: id }
      }
    } catch { /* The renderer can be temporarily unavailable while the result page loads. */ }
    if (submissionRejected?.()) break
    await delay(Math.min(150, Math.max(0, deadline - Date.now())))
  }
  return { submitted: true }
}
