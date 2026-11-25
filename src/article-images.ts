import type { Article } from './wechat.js'

export async function replaceArticleImages(
  article: Article,
  upload: (url: string, index: number, total: number) => Promise<string>,
): Promise<string> {
  const marker = /<img data-relay-image="(\d+)">/g
  const matches = [...article.html.matchAll(marker)]
  if (matches.length !== article.images.length || matches.some((match, index) => match[1] !== String(index))) {
    throw new Error('公众号正文与图片列表不一致，请重新导入。')
  }
  const replacements = new Map<string, string>()
  const images = [...new Set(article.images)]
  for (const [index, url] of images.entries()) {
    replacements.set(url, await upload(url, index + 1, images.length))
  }
  return article.html.replace(marker, (_match, index: string) => replacements.get(article.images[Number(index)])!)
}
