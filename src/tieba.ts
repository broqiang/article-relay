export const tiebaHome = 'https://tieba.baidu.com/'
const tiebaOrigin = new URL(tiebaHome).origin
const accountUrl = new URL('f/user/json_userinfo', tiebaHome).href
const loginStatusUrl = new URL('dc/common/tbs', tiebaHome).href
const unknownLoginStatus = '未能确认百度贴吧登录状态，请在应用内打开百度贴吧，按页面提示操作后重试。'

export async function checkTiebaLogin(
  request: (url: string, init: RequestInit) => Promise<Response>,
): Promise<boolean> {
  async function readJson(url: string) {
    const response = await request(url, {
      cache: 'no-store', credentials: 'same-origin', mode: 'same-origin', redirect: 'follow',
      headers: { Origin: tiebaOrigin }, signal: AbortSignal.timeout(5_000),
    }).catch((cause: unknown) => {
      throw new Error(unknownLoginStatus, { cause })
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error(`${unknownLoginStatus}（HTTP ${response.status}）`)
    }
    return response.json().catch(() => undefined)
  }

  const account = await readJson(accountUrl).catch(() => undefined)
  if (account === null) return false
  if (typeof account?.data?.user_portrait === 'string' && account.data.user_portrait.trim()) return true

  const data = await readJson(loginStatusUrl)
  if (data?.is_login === 0) return false
  if (data?.is_login === 1) return true
  throw new Error(unknownLoginStatus)
}
