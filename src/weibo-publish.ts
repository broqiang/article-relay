import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import { weiboArticleUrl, weiboDraftUrl } from './weibo.js'

type Editor = Pick<WebContents, 'loadURL' | 'executeJavaScriptInIsolatedWorld' | 'stop'>
type Phase = 'next' | 'submit' | 'observe' | 'verify'
type PageResult = { clicked?: true; article?: string; link?: string; historyOpened?: true }
type PublishResult =
  | { state: 'published'; url: string }
  | { state: 'manual'; step: 'load' | 'next' | 'submit' }
  | { state: 'uncertain' }

function inspectPage(editor: string, title: string, owner: string, phase: Phase, deadline: number): PageResult {
  const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const heading = document.querySelector('[node-type="articleTitle"]')
  const author = heading?.parentElement?.querySelector<HTMLAnchorElement>('.authorinfo .author1 a[href]')
  if ((phase === 'observe' || phase === 'verify') &&
      heading && normalize(heading.textContent ?? '') === normalize(title) &&
      author?.pathname === '/u/' + owner) {
    return { article: location.href }
  }
  if (phase === 'verify') return {}
  const draft = new URL(editor)
  if (location.origin !== draft.origin || location.pathname !== draft.pathname) return {}

  const visible = (node: HTMLElement) =>
    node.getClientRects().length > 0 && getComputedStyle(node).visibility === 'visible' &&
    !node.closest('[inert], [aria-hidden="true"]')
  const label = (node: HTMLElement) => normalize(node.innerText || node.textContent || '')
  const dialogs = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], .woo-modal-main')].filter(visible)
  const buttons = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].filter((button) =>
    visible(button) && !button.matches(':disabled, [aria-disabled="true"]'))
  const next = buttons.find((button) => label(button) === '下一步')
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>('textarea[placeholder*="标题"], input[placeholder*="标题"]')
  if (phase === 'observe') {
    for (const dialog of dialogs) {
      if (!/发布成功|文章已发布/.test(label(dialog))) continue
      const links = [...dialog.querySelectorAll<HTMLAnchorElement>('a[href]')].filter((link) =>
        visible(link) && ['查看文章', '查看长文', '查看头条文章'].includes(label(link)))
      if (links.length === 1) return { link: links[0].href }
    }
    const historyHash = draft.hash.replace('#/draft/', '#/history/')
    return location.hash === historyHash ? { historyOpened: true } : {}
  }
  if (Date.now() >= deadline || location.hash !== draft.hash) return {}
  let candidates: HTMLElement[]
  if (phase === 'next') {
    if (dialogs.length || !field || normalize(field.value) !== normalize(title)) return {}
    candidates = buttons.filter((button) => label(button) === '下一步')
  } else {
    const announcement = `发布了头条文章:《${normalize(title)}》`
    const composers = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('textarea, [contenteditable="true"]')]
      .filter((node) => visible(node) && normalize(node.value ?? node.textContent ?? '').replace(/:\s*/, ':').startsWith(announcement))
    const settings = [...document.querySelectorAll<HTMLElement>('h1, h2, h3, h4, header, div, span')]
      .find((node) => visible(node) && label(node) === '发布设置' && (!dialogs.length || dialogs.some((dialog) => dialog.contains(node))))
    let panel: HTMLElement | undefined
    candidates = buttons.filter((button) => {
      if (!['发布', '确认发布'].includes(label(button))) return false
      for (let parent = button.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if ((next && parent.contains(next)) || (field && parent.contains(field))) break
        if (composers.some((composer) => parent.contains(composer)) ||
            (settings && dialogs.includes(parent) && parent.contains(settings))) {
          panel = parent
          return true
        }
      }
      return Boolean(settings && !dialogs.length)
    })
    if (candidates.length !== 1) return {}
    const followLabel = /关注\s*@\s*头条文章/
    let followPanel = panel
    while (followPanel && followPanel !== document.body && !followLabel.test(label(followPanel))) {
      const parent: HTMLElement | null = followPanel.parentElement
      followPanel = parent && !(next && parent.contains(next)) && !(field && parent.contains(field)) ? parent : undefined
    }
    if (followPanel && followPanel !== document.body && followLabel.test(label(followPanel))) {
      const option = [...followPanel.querySelectorAll<HTMLElement>('label, [role="checkbox"]')]
        .find((node) => visible(node) && followLabel.test(label(node)))
      const controls = followPanel.querySelectorAll<HTMLElement>('input[type="checkbox"], [role="checkbox"]')
      const checkbox = (option as HTMLLabelElement | undefined)?.control ?? option?.querySelector('input[type="checkbox"]') ??
        (option?.matches('[role="checkbox"]') ? option : undefined) ??
        (controls.length === 1 ? controls[0] : undefined)
      if (!checkbox || (!checkbox.matches('input[type="checkbox"]') && !checkbox.hasAttribute('aria-checked'))) return {}
      const checked = () => (checkbox as HTMLInputElement).checked ?? checkbox.getAttribute('aria-checked') === 'true'
      if (checked()) {
        checkbox.click()
        if (checked()) return {}
      }
    }
  }
  if (candidates.length !== 1) return {}
  candidates[0].click()
  return { clicked: true }
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('微博页面响应超时。')), Math.max(0, deadline - Date.now()))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function inspect(contents: Editor, editor: string, title: string, owner: string, phase: Phase, deadline: number): Promise<PageResult> {
  const args = JSON.stringify([editor, title, owner, phase, deadline])
  return beforeDeadline(contents.executeJavaScriptInIsolatedWorld(1001, [
    { code: `(${inspectPage.toString()})(...${args})` },
  ], phase === 'next' || phase === 'submit'), deadline)
}

export async function checkWeiboArticle(contents: Editor, input: string, title: string, owner: string, waitMs = 8_000): Promise<boolean> {
  const url = weiboArticleUrl(input)
  if (!url) return false
  const deadline = Date.now() + waitMs
  try {
    await beforeDeadline(contents.loadURL(url), deadline)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') {
      contents.stop()
      return false
    }
  }
  while (Date.now() < deadline) {
    const result = await inspect(contents, '', title, owner, 'verify', deadline).catch(() => undefined)
    if (result?.article && weiboArticleUrl(result.article) === url) return true
    await delay(200)
  }
  return false
}

export async function publishWeiboDraft(contents: Editor, id: string, title: string, owner: string, waitMs = 10_000): Promise<PublishResult> {
  const editor = weiboDraftUrl(id)
  try {
    await beforeDeadline(contents.loadURL(editor), Date.now() + waitMs)
  } catch {
    contents.stop()
    return { state: 'manual', step: 'load' }
  }

  let deadline = Date.now() + waitMs
  let phase: Phase = 'next'
  while (Date.now() < deadline) {
    try {
      const result = await inspect(contents, editor, title, owner, phase, deadline)
      const confirmedUrl = result.article && weiboArticleUrl(result.article)
      if (confirmedUrl) return { state: 'published', url: confirmedUrl }
      const linkedUrl = result.link && weiboArticleUrl(result.link)
      if (linkedUrl && await checkWeiboArticle(contents, linkedUrl, title, owner, waitMs)) {
        return { state: 'published', url: linkedUrl }
      }
      if (result.historyOpened) return { state: 'uncertain' }
      if (result.clicked) {
        phase = phase === 'next' ? 'submit' : 'observe'
        deadline = Date.now() + waitMs
      }
    } catch {
      if (phase === 'submit') {
        // The click may have started a navigation before the script returned.
        phase = 'observe'
        deadline = Date.now() + waitMs
      }
    }
    await delay(200)
  }
  return phase === 'observe' ? { state: 'uncertain' } : { state: 'manual', step: phase }
}
