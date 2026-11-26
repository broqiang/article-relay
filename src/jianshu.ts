export const jianshuHome = 'https://www.jianshu.com/'
export const jianshuLoginUrl = new URL('sign_in', jianshuHome).href

export async function checkJianshuAccount(
  request: (url: string, init: RequestInit) => Promise<Response>,
): Promise<{ id: string; name: string } | null> {
  const response = await request(jianshuHome, {
    cache: 'no-store', credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`检查简书登录失败（HTTP ${response.status}）。`)

  const html = await response.text()
  const pageData = /<script\b[^>]*\bdata-name=["']page-data["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1]
  const invalid = '简书未返回可识别的登录状态，请在应用内打开简书后重试。'
  let data: { user_signed_in?: unknown; current_user?: { id?: unknown; nickname?: unknown } } | null
  try {
    data = pageData ? JSON.parse(pageData) : null
  } catch {
    throw new Error(invalid)
  }
  if (data?.user_signed_in === false) return null
  if (data?.user_signed_in !== true) throw new Error(invalid)
  const user = data.current_user
  const id = user?.id
  if (!(typeof id === 'string' && id.trim()) && !(Number.isSafeInteger(id) && Number(id) > 0)) {
    throw new Error(invalid)
  }
  const nickname = typeof user?.nickname === 'string' ? user.nickname.trim() : ''
  return { id: String(id), name: nickname || '简书账号' }
}
