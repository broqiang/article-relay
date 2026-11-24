export interface Article {
  title: string
  html: string
  images: string[]
  sourceUrl: string
}

export type PageResult =
  | { state: 'article'; article: Article; imageNodes: number; carouselImages: number; hasCover: boolean }
  | { state: 'carousel-pending'; loaded: number; total: number }
  | { state: 'verification' | 'missing' | 'unsupported-image' }

export function wechatArticleUrl(input: string): string {
  const url = new URL(input.trim())
  if (url.origin !== 'https://mp.weixin.qq.com' || url.username || url.password ||
      !/^\/s(?:\/[\w-]+)?$/.test(url.pathname)) {
    throw new Error('请输入有效的微信公众号文章链接。')
  }
  url.hash = ''
  return url.href
}

// Runs inside the article view. Keep all browser-side helpers within this function.
function inspectWeChatPage(): PageResult {
  if (document.getElementById('js_verify')) return { state: 'verification' }

  const title = ['#activity-name', '.rich_media_title']
    .map((selector) => document.querySelector(selector)?.textContent?.trim())
    .find(Boolean)
  const body = document.querySelector('#js_content')
  if (!title || !body) return { state: 'missing' }

  const allowed = new Set([
    'P', 'DIV', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'STRONG', 'EM', 'S', 'U', 'A',
    'BLOCKQUOTE', 'UL', 'OL', 'LI', 'PRE', 'CODE', 'HR', 'TABLE', 'CAPTION', 'THEAD',
    'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'SUP', 'SUB',
  ])
  const drop = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'SVG', 'OBJECT', 'EMBED', 'NOSCRIPT', 'TEMPLATE'])
  const semantic: Record<string, string> = {
    SECTION: 'DIV', H1: 'H2', B: 'STRONG', I: 'EM', DEL: 'S', FIGCAPTION: 'P',
  }
  const output = document.createElement('div')
  const images: string[] = []
  let unsupportedImage = false

  function webUrl(value: string | null): URL | undefined {
    if (!value) return
    try {
      const url = new URL(value, location.href)
      if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url
    } catch {
      return
    }
  }

  function imageUrl(...values: (string | null | undefined)[]): URL | undefined {
    for (const value of values) {
      const url = webUrl(value ?? null)
      if (url?.protocol === 'https:' && !url.port &&
          /(?:^|\.)(?:qpic\.cn|qlogo\.cn|wx\.qq\.com)$/.test(url.hostname)) return url
    }
  }

  function imageMarker(url: URL): HTMLElement {
    const marker = document.createElement('img')
    marker.setAttribute('data-relay-image', String(images.length))
    images.push(url.href)
    return marker
  }

  function appendClean(node: Node, parent: HTMLElement): void {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(document.createTextNode(node.textContent ?? ''))
      return
    }
    if (!(node instanceof HTMLElement) || drop.has(node.tagName)) return

    if (node.tagName === 'IMG') {
      const url = imageUrl(node.getAttribute('data-src'), node.getAttribute('src'))
      if (!url) {
        unsupportedImage = true
        return
      }
      parent.append(imageMarker(url))
      return
    }

    const tag = semantic[node.tagName] ?? node.tagName
    let target = parent
    if (allowed.has(tag)) {
      target = document.createElement(tag.toLowerCase())
      if (tag === 'A') {
        const href = webUrl(node.getAttribute('href'))
        if (href) target.setAttribute('href', href.href)
      }
      if (tag === 'TABLE') {
        target.setAttribute('data-draft-node', 'block')
        target.setAttribute('data-draft-type', 'table')
        target.setAttribute('data-size', 'normal')
        target.setAttribute('data-row-style', 'normal')
      }
      if (tag === 'TH' || tag === 'TD') {
        for (const attribute of ['rowspan', 'colspan']) {
          const value = node.getAttribute(attribute)
          if (value && /^\d{1,2}$/.test(value)) target.setAttribute(attribute, value)
        }
      }
      if (tag === 'PRE') {
        const classes = node.querySelector('code')?.className ?? ''
        const language = node.getAttribute('lang') || classes.match(/\blanguage-([\w+-]+)/)?.[1]
        if (language && /^[\w+-]+$/.test(language)) target.setAttribute('lang', language)
      }
      parent.append(target)
    }
    for (const child of node.childNodes) appendClean(child, target)
  }

  const description = body.querySelector('#js_image_content #js_image_desc')
  for (const node of description ? [description] : body.childNodes) appendClean(node, output)
  if (unsupportedImage) return { state: 'unsupported-image' }

  let carouselImages = 0
  if (!images.length) {
    const carousel = document.createDocumentFragment()
    const seen = new Set<string>()
    const header = document.getElementById('js_share_content_page_hd')
    const region = header?.querySelector('#page_top_area') ?? header ?? document
    const slides = region.querySelectorAll('.swiper_item')
    const items = slides.length ? slides : region.querySelectorAll('.swiper_item_img')
    for (const slide of items) {
      if (slide.closest('#img_swiper_placeholder')) continue
      const loaded = slide.querySelector(slides.length ? '.swiper_item_img img' : 'img')
      const original = imageUrl(slide.getAttribute('data-src'))
      const url = original ?? imageUrl(loaded?.getAttribute('data-src'), loaded?.getAttribute('src'))
      if (!url) continue
      const key = url.origin + url.pathname
      if (seen.has(key)) continue
      seen.add(key)
      carousel.append(imageMarker(url))
    }
    carouselImages = seen.size
    const total = Number(header?.querySelector('#img_swiper_placeholder .swiper_tips_right')?.textContent)
    if (Number.isSafeInteger(total) && carouselImages < total) {
      return { state: 'carousel-pending', loaded: carouselImages, total }
    }
    output.prepend(carousel)
  }
  if (!output.textContent?.trim() && !images.length) return { state: 'missing' }

  // The target editor treats images as blocks. Split the surrounding text/formatting
  // wrappers before replacing markers with figures, keeping list and table structure.
  const blockParents = new Set(['BLOCKQUOTE', 'LI', 'TD', 'TH'])
  for (const marker of output.querySelectorAll('img[data-relay-image]')) {
    let wrapper = marker.parentElement
    while (wrapper && wrapper !== output && !blockParents.has(wrapper.tagName)) {
      const trailing = wrapper.cloneNode(false)
      while (marker.nextSibling) trailing.appendChild(marker.nextSibling)
      if (trailing.hasChildNodes()) wrapper.after(trailing)
      wrapper.after(marker)
      if (!wrapper.hasChildNodes()) wrapper.remove()
      wrapper = marker.parentElement
    }
  }

  return {
    state: 'article',
    article: { title, html: output.innerHTML, images, sourceUrl: location.href },
    imageNodes: (description ?? body).querySelectorAll('img').length,
    carouselImages,
    hasCover: Boolean(document.querySelector('meta[property="og:image"]')?.getAttribute('content')?.trim()),
  }
}

export const inspectWeChatScript = `(${inspectWeChatPage.toString()})()`
