export function chromiumUserAgent(userAgent: string): string {
  // Preserve Chromium's actual platform and engine versions.
  const parts = /^(.*?\(KHTML, like Gecko\)) .*?\b(Chrome\/[\d.]+)\b.*? (Safari\/[\d.]+)$/.exec(userAgent)
  return parts ? `${parts[1]} ${parts[2]} ${parts[3]}` : userAgent
}
