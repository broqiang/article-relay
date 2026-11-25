import { createHash, createHmac, randomInt } from 'node:crypto'
import { crc32 } from 'node:zlib'

const imagex = 'https://imagex.bytedanceapi.com/'
const region = 'cn-north-1'
const serviceId = '73owjymdk6'

interface Credentials {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
}

type Request = (url: string, init: RequestInit) => Promise<Response>
type ImageApi = <T>(path: string, query: URLSearchParams) => Promise<T>

function uploadHostname(hosts: unknown): string {
  // ImageX chooses the upload line per request. Its HTTPS response supplies the host and storage credential.
  const candidate: unknown = Array.isArray(hosts) ? hosts[0] : undefined
  const host = typeof candidate === 'string' ? /^(?:https:\/\/)?([a-z\d.-]+)\/?$/i.exec(candidate.trim())?.[1].toLowerCase() : undefined
  if (!host || host.length > 253 || !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,63}$/.test(host) ||
      /\.(?:localhost|local|internal|invalid|test|example|onion)$/.test(host)) {
    throw new Error('掘金申请图片直传地址失败，ImageX 未返回有效的 HTTPS 上传主机。')
  }
  return host
}

async function imagexRequest<T>(request: Request, token: Credentials, method: 'GET' | 'POST', params: Record<string, string>): Promise<T> {
  const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = date.slice(0, 8)
  const scope = `${day}/${region}/imagex/aws4_request`
  const fields = { ...params, ServiceId: serviceId, Version: '2018-08-01' }
  const query = Object.entries(fields).sort(([left], [right]) => left < right ? -1 : left === right ? 0 : 1)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  const signedHeaders = 'x-amz-date;x-amz-security-token'
  const canonical = [method, '/', query, `x-amz-date:${date}\nx-amz-security-token:${token.SessionToken}\n`, signedHeaders, hash('')].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', date, scope, hash(canonical)].join('\n')
  const key = [day, region, 'imagex', 'aws4_request'].reduce<Buffer>((current, value) =>
    createHmac('sha256', current).update(value).digest(), Buffer.from(`AWS4${token.SecretAccessKey}`))
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  const response = await request(`${imagex}?${query}`, {
    method, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: {
      'x-amz-date': date,
      'x-amz-security-token': token.SessionToken,
      Authorization: `AWS4-HMAC-SHA256 Credential=${token.AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  })
  if (!response.ok) throw new Error(`掘金图片服务请求失败（HTTP ${response.status}）。`)
  return await response.json() as T
}

export interface JuejinImage { pic_uri: string; pic_url: string }

export async function uploadJuejinImage(api: ImageApi, request: Request, file: Blob): Promise<JuejinImage> {
  const uuid = `${Date.now()}${randomInt(1_000_000).toString().padStart(6, '0')}`
  const query = new URLSearchParams({ uuid })
  const { token } = await api<{ token?: Credentials }>('/imagex/v2/gen_token', new URLSearchParams({ uuid, client: 'web' }))
  if (!token?.AccessKeyId || !token.SecretAccessKey || !token.SessionToken) throw new Error('掘金未返回图片上传凭证。')

  const applied = await imagexRequest<{ Result?: { UploadAddress?: {
    SessionKey: string; UploadHosts?: string[]; StoreInfos: { StoreUri: string; Auth: string }[]
  } } }>(request, token, 'GET', { Action: 'ApplyImageUpload' })
  const address = applied.Result?.UploadAddress
  const store = address?.StoreInfos?.[0]
  if (!address?.SessionKey || !store?.Auth || !/^tos-cn-i-73owjymdk6\/[\w-]+$/.test(store.StoreUri)) {
    throw new Error('掘金申请图片直传地址失败，未返回有效的上传凭证或图片编号。')
  }
  const host = uploadHostname(address.UploadHosts)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type]
  const transferred = await request(`https://${host}/${store.StoreUri}`, {
    method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: store.Auth,
      'Content-Type': 'application/octet-stream',
      'Content-CRC32': crc32(bytes).toString(16).padStart(8, '0'),
      'Content-Disposition': `attachment; filename="image.${extension ?? 'bin'}"`,
    },
    body: bytes,
  })
  if (!transferred.ok) throw new Error(`掘金图片上传失败（HTTP ${transferred.status}）。`)
  void transferred.body?.cancel().catch(() => {})

  const committed = await imagexRequest<{ Result?: { Results?: { UriStatus: number }[] } }>(request, token, 'POST', {
    Action: 'CommitImageUpload', SessionKey: address.SessionKey,
  })
  if (committed.Result?.Results?.[0]?.UriStatus !== 2000) throw new Error('掘金未确认图片上传成功。')

  query.set('uri', store.StoreUri)
  query.set('img_type', 'private')
  const { main_url: imageUrl } = await api<{ main_url?: string }>('/imagex/v2/get_img_url', query)
  if (!imageUrl) throw new Error('掘金未返回可用的图片链接。')
  const url = new URL(imageUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(?:^|\.)(?:byteimg\.com|juejin\.cn|bytecdn\.cn)$/.test(url.hostname)) {
    throw new Error('掘金返回了无法识别的图片链接。')
  }
  return { pic_uri: store.StoreUri, pic_url: url.href }
}
