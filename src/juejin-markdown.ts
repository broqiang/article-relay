// Runs in the workspace renderer, where the browser can parse the imported HTML.
export function juejinMarkdown(html: string, images: string[]): { markdown: string; summary: string } {
  const body = new DOMParser().parseFromString(html, 'text/html').body
  const block = (value: string) => value.trim() ? `\n\n${value.trim()}\n\n` : ''
  const escape = (value: string) => value.replace(/[\\`*_~\[\]<>]/g, '\\$&')
    .replace(/(^|\n)(\s*)([#>+\-]|\d+[.)])(?=\s|$)/g, (_match, start, space, prefix: string) =>
      start + space + (prefix.length === 1 ? `\\${prefix}` : `${prefix.slice(0, -1)}\\${prefix.slice(-1)}`))
  const ticks = (value: string, minimum: number) => '`'.repeat(Math.max(minimum, ...[...value.matchAll(/`+/g)].map(([run]) => run.length + 1)))
  const target = (url: string) => `<${url.replace(/[<>\s]/g, encodeURIComponent)}>`
  const children = (node: Node): string => Array.from(node.childNodes, render).join('')

  function table(element: HTMLTableElement): string {
    const rows = Array.from(element.rows, (row) => Array.from(row.cells, (cell) =>
      children(cell).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')))
    const columns = Math.max(0, ...rows.map((row) => row.length))
    if (!columns) return ''
    const row = (cells: string[]) => `| ${Array.from({ length: columns }, (_, index) => cells[index] ?? '').join(' | ')} |`
    const hasHeader = Array.from(element.rows[0].cells).some((cell) => cell.tagName === 'TH')
    const header = hasHeader ? rows.shift()! : []
    const caption = element.caption ? block(children(element.caption)) : ''
    return caption + block([row(header), row(Array<string>(columns).fill('---')), ...rows.map(row)].join('\n'))
  }

  function render(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return escape((node.textContent ?? '').replace(/\s+/g, ' '))
    if (!(node instanceof HTMLElement)) return ''
    const tag = node.tagName
    if (tag === 'TABLE' && node instanceof HTMLTableElement) return table(node)
    if (tag === 'IMG') {
      const index = node.getAttribute('data-relay-image')
      const url = index === null ? undefined : images[Number(index)]
      if (!url) throw new Error('公众号正文与图片列表不一致，请重新导入。')
      return block(`![](${url})`)
    }
    if (tag === 'PRE' || tag === 'CODE') {
      const code = node.textContent ?? ''
      if (tag === 'PRE') {
        const fence = ticks(code, 3)
        const language = node.getAttribute('lang') ?? ''
        return block(`${fence}${/^[\w+-]+$/.test(language) ? language : ''}\n${code.replace(/\n$/, '')}\n${fence}`)
      }
      const fence = ticks(code, 1)
      const padding = /^[` ]|[` ]$/.test(code) && code.trim() ? ' ' : ''
      return `${fence}${padding}${code}${padding}${fence}`
    }
    if (tag === 'OL' || tag === 'UL') {
      const items = Array.from(node.children).filter((item) => item.tagName === 'LI')
      const entries = items.map((item, index) => {
        const prefix = tag === 'OL' ? `${index + 1}. ` : '- '
        const indent = ' '.repeat(prefix.length)
        return prefix + children(item).trim().split('\n').map((line, lineIndex) =>
          lineIndex && line ? indent + line : line).join('\n')
      })
      return block(entries.join('\n'))
    }

    const value = children(node)
    const content = value.trim()
    if (/^H[1-6]$/.test(tag)) return block(`${'#'.repeat(Number(tag[1]))} ${content}`)
    if (tag === 'P' || tag === 'DIV') return block(value)
    if (tag === 'BR') return '  \n'
    if (tag === 'HR') return block('---')
    if (tag === 'BLOCKQUOTE') return block(content.split('\n').map((line) => line ? `> ${line}` : '>').join('\n'))
    if (tag === 'A') {
      const href = node.getAttribute('href') ?? ''
      return /^https?:\/\//i.test(href) && content ? `[${content}](${target(href)})` : value
    }
    const delimiter = tag === 'STRONG' ? '**' : tag === 'EM' ? '*' : tag === 'S' ? '~~' : ''
    return delimiter && content ? value.replace(content, () => `${delimiter}${content}${delimiter}`) : value
  }

  const markers = Array.from(body.querySelectorAll('img'))
  if (markers.length !== images.length || markers.some((image, index) => image.getAttribute('data-relay-image') !== String(index))) {
    throw new Error('公众号正文与图片列表不一致，请重新导入。')
  }
  const summary = Array.from((body.textContent ?? '').trim().replace(/\s+/g, ' ')).slice(0, 100).join('')
  return { markdown: Array.from(body.childNodes, render).filter((value) => value.trim()).join('').trim(), summary }
}
