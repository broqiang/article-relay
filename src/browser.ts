export function chromiumUserAgent(userAgent: string): string {
  // Preserve Chromium's actual platform and engine versions.
  const parts = /^(.*?\(KHTML, like Gecko\)) .*?\b(Chrome\/[\d.]+)\b.*? (Safari\/[\d.]+)$/.exec(userAgent)
  return parts ? `${parts[1]} ${parts[2]} ${parts[3]}` : userAgent
}

export async function publicationUrlStatus(
  request: (url: string, init: RequestInit) => Promise<Response>, url: string,
): Promise<'missing' | 'unknown'> {
  try {
    const response = await request(url, {
      cache: 'no-store', credentials: 'include', redirect: 'manual', signal: AbortSignal.timeout(8_000),
    })
    void response.body?.cancel().catch(() => {})
    if (!response.redirected && response.url === url && [404, 410].includes(response.status)) return 'missing'
  } catch {
    // Connection and authentication failures do not prove the article was deleted.
  }
  return 'unknown'
}
