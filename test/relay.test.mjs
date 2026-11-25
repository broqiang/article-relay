import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { wechatArticleUrl } from '../dist/wechat.js'
import { draftUrl, Zhihu } from '../dist/zhihu.js'
import { checkZhihuArticle, publishZhihuDraft } from '../dist/zhihu-publish.js'
import { chromiumUserAgent } from '../dist/browser.js'
import { TaskStore, taskSummary } from '../dist/tasks.js'

test('initializes the bridge without CommonJS exports in a sandboxed preload', async () => {
  const preload = readFileSync(new URL('../dist/preload.js', import.meta.url), 'utf8')
  let bridge
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'relay')
        bridge = api
      },
    },
    ipcRenderer: { invoke: async (channel, args) => args ? { channel, args } : channel },
  }
  runInNewContext(preload, { require: (name) => {
    assert.equal(name, 'electron')
    return electron
  } })
  assert.equal(await bridge.getVersion(), 'relay:version')
  assert.equal(await bridge.openReleases(), 'relay:open-releases')
  assert.equal(await bridge.restart(), 'relay:restart')
  assert.equal(await bridge.openZhihu(), 'relay:open-zhihu')
  assert.equal(await bridge.checkAccount(), 'relay:account')
  assert.equal(JSON.stringify(await bridge.deleteTask('task')), '{"channel":"relay:delete-task","args":{"taskId":"task"}}')
  assert.equal(JSON.stringify(await bridge.publishArticle('task')), '{"channel":"relay:publish","args":{"taskId":"task"}}')
  assert.equal(JSON.stringify(await bridge.showDraft('task', 'run')), '{"channel":"relay:show-draft","args":{"taskId":"task","runId":"run"}}')
  assert.equal(JSON.stringify(await bridge.markPublished('task', 'run')), '{"channel":"relay:mark-published","args":{"taskId":"task","runId":"run"}}')
})

test('submits only recognized Zhihu publication controls and requires a matching article page', async (t) => {
  const id = '123'
  const publicUrl = 'https://zhuanlan.zhihu.com/p/123'
  function editor({ confirm = false, resultUrl, modalLabel, abortAfterClick = false, successToast = false } = {}) {
    let url
    let dialogOpen = Boolean(modalLabel)
    const clicks = []
    const visible = { getClientRects: () => [1], closest: () => null, matches: () => false }
    function button(label, onClick) {
      return { ...visible, textContent: label, click: () => { clicks.push(label); onClick() } }
    }
    const publish = button('发布', () => {
      if (confirm) dialogOpen = true
      else if (resultUrl) url = resultUrl
    })
    const settings = button('发布设置', () => assert.fail('clicked publish settings'))
    const confirmation = button(modalLabel || '确认发布', () => { url = resultUrl })
    const dialog = { ...visible, contains: (node) => node === confirmation }
    return {
      clicks,
      loadURL: async (address) => { assert.equal(address, draftUrl(id)); url = address },
      getURL: () => url,
      stop: () => {},
      executeJavaScriptInIsolatedWorld: async (world, scripts, userGesture) => {
        assert.equal(world, 1001)
        if (clicks.length === 0) assert.equal(userGesture, true)
        const result = runInNewContext(scripts[0].code, {
          location: new URL(url),
          getComputedStyle: () => ({ visibility: 'visible' }),
          document: {
            querySelectorAll: (selector) => {
              if (selector === 'button') return [publish, settings, ...(dialogOpen ? [confirmation] : [])]
              if (selector.startsWith('.Toast')) return successToast && clicks.length ? [{ textContent: '文章发布成功' }] : []
              return dialogOpen ? [dialog] : []
            },
            querySelector: () => url === publicUrl ? {} : null,
          },
        })
        if (result === 'submitted' && abortAfterClick) throw new Error('Navigation interrupted the script')
        return result
      },
    }
  }
  await t.test('publishes with a single click when the editor has no confirmation', async () => {
    const page = editor({ resultUrl: publicUrl, abortAfterClick: true })
    assert.equal(await publishZhihuDraft(page, id, 1000), 'published')
    assert.deepEqual(page.clicks, ['发布'])
  })
  await t.test('handles one explicit confirmation', async () => {
    const page = editor({ resultUrl: publicUrl, confirm: true })
    assert.equal(await publishZhihuDraft(page, id, 1000), 'published')
    assert.deepEqual(page.clicks, ['发布', '确认发布'])
  })
  await t.test('accepts an explicit success toast while the editor remains open', async () => {
    const page = editor({ successToast: true })
    assert.equal(await publishZhihuDraft(page, id, 1000), 'published')
    assert.deepEqual(page.clicks, ['发布'])
  })
  await t.test('leaves an existing modal for the user', async () => {
    const page = editor({ modalLabel: '安全验证' })
    assert.equal(await publishZhihuDraft(page, id, 1000), 'manual')
    assert.deepEqual(page.clicks, [])
  })
  await t.test('never repeats a submission when it cannot be confirmed', async () => {
    const page = editor()
    assert.equal(await publishZhihuDraft(page, id, 300), 'uncertain')
    assert.deepEqual(page.clicks, ['发布'])
  })
  await t.test('rejects an unexpected article URL as publication evidence', async () => {
    const page = editor({ resultUrl: 'https://zhuanlan.zhihu.com/p/999' })
    assert.equal(await publishZhihuDraft(page, id, 300), 'uncertain')
    assert.deepEqual(page.clicks, ['发布'])
  })
})

test('rechecks an aborted article navigation without clicking or trusting the aborted load', async () => {
  const id = '2108876760586757938'
  const address = `https://zhuanlan.zhihu.com/p/${id}`
  let current = 'https://www.zhihu.com/'
  let probes = 0
  const page = {
    loadURL: async (url) => {
      assert.equal(url, address)
      throw Object.assign(new Error('Provisional load canceled'), { code: 'ERR_ABORTED' })
    },
    executeJavaScriptInIsolatedWorld: async (_world, scripts, userGesture) => {
      assert.equal(userGesture, false)
      if (++probes === 2) current = address
      return runInNewContext(scripts[0].code, {
        location: new URL(current),
        document: { querySelector: () => ({}) },
      })
    },
  }
  assert.equal(await checkZhihuArticle(page, id, 1000), true)
  assert.equal(probes, 2)
  page.executeJavaScriptInIsolatedWorld = async (_world, scripts) =>
    runInNewContext(scripts[0].code, { location: new URL(draftUrl(id)), document: {} })
  assert.equal(await checkZhihuArticle(page, id, 60), false)
})

test('accepts the supplied WeChat article and rejects lookalike origins', () => {
  const url = 'https://mp.weixin.qq.com/s/H4NBO9wkVsbMxiyQdw135A'
  assert.equal(wechatArticleUrl(` ${url}#top `), url)
  assert.throws(() => wechatArticleUrl('https://mp.weixin.qq.com.example/s/test'))
  assert.throws(() => wechatArticleUrl('https://mp.weixin.qq.com/s/test/extra'))
})

test('uses the actual Chromium version and platform for site browser user agents', () => {
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)'
  assert.equal(chromiumUserAgent(`${mac} 文章同步/0.1.0 Chrome/156.0.8078.49 Electron/45.4.1 Safari/537.36`),
    `${mac} Chrome/156.0.8078.49 Safari/537.36`)
  assert.equal(chromiumUserAgent(`${windows} Chrome/157.0.8182.27 Electron/46.0.0 Safari/537.36`),
    `${windows} Chrome/157.0.8182.27 Safari/537.36`)
  assert.equal(chromiumUserAgent('unknown format'), 'unknown format')
})

test('uploads each distinct image once and preserves order in the saved draft', async () => {
  const calls = []
  let imageNumber = 0
  const zhihu = new Zhihu(async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/me')) return Response.json({ id: 'account', name: '测试账号' })
    if (url === 'https://api.zhihu.com/images') return Response.json({ upload_file: { state: 1, image_id: String(++imageNumber) } })
    if (url === 'https://api.zhihu.com/images/1') {
      return Response.json({ status: 'success', original_src: '//picx.zhimg.com/a.png', src: 'https://pic4.zhimg.com/a-preview.png' })
    }
    if (url === 'https://api.zhihu.com/images/2') return Response.json({ original_hash: 'b.png' })
    if (url.endsWith('/drafts')) return new Response('{"id":9876543210123456789}')
    return new Response(null, { status: 204 })
  })
  const a = 'https://mmbiz.qpic.cn/a.png'
  const b = 'https://mmbiz.qpic.cn/b.png'
  const progress = []
  const reads = []
  const html = await zhihu.prepareContent({
    title: '图文', sourceUrl: 'https://mp.weixin.qq.com/s/test', images: [a, b, a],
    html: '<p>正文</p><img data-relay-image="0"><img data-relay-image="1"><img data-relay-image="2">',
  }, async (url) => {
    reads.push(url)
    return new Blob([url], { type: 'image/png' })
  }, (index, total) => progress.push([index, total]))
  assert.deepEqual(reads, [a, b])
  assert.deepEqual(progress, [[1, 2], [2, 2]])
  assert.deepEqual([...html.matchAll(/src="([^"]+)"/g)].map((match) => match[1]), [
    'https://picx.zhimg.com/a.png', 'https://pic4.zhimg.com/b.png', 'https://picx.zhimg.com/a.png',
  ])
  assert.deepEqual(await zhihu.account(), { id: 'account', name: '测试账号' })
  const id = await zhihu.createDraft('图文')
  await zhihu.updateDraft(id, '图文', html)
  assert.equal(draftUrl(id), 'https://zhuanlan.zhihu.com/p/9876543210123456789/edit')
  assert.equal(calls.length, 7)
  const update = calls.at(-1)
  assert.equal(update.url, 'https://zhuanlan.zhihu.com/api/articles/9876543210123456789/draft')
  assert.equal(update.init.method, 'PATCH')
  assert.equal(update.init.credentials, 'include')
  assert.deepEqual(JSON.parse(update.init.body), { title: '图文', content: html })
})

test('uses the processed Zhihu image URL when the original URL is unusable', async () => {
  const zhihu = new Zhihu(async (url) => {
    if (url === 'https://api.zhihu.com/images') return Response.json({ upload_file: { state: 1, image_id: '1' } })
    return Response.json({
      status: 'success',
      original_src: 'https://pic4.zhimg.com.example/a.png',
      src: 'https://pic1.zhimg.com/a.png',
    })
  })
  const html = await zhihu.prepareContent({
    title: '图文', sourceUrl: 'https://mp.weixin.qq.com/s/test',
    images: ['https://mmbiz.qpic.cn/a.png'], html: '<img data-relay-image="0">',
  }, async () => new Blob(['file'], { type: 'image/png' }), () => {})
  assert.equal(html, '<figure><img src="https://pic1.zhimg.com/a.png"></figure>')
})

test('reuses a Zhihu CDN image only after checking that the URL serves an image', async () => {
  const hash = createHash('md5').update('file').digest('hex')
  const cdn = `https://picx.zhimg.com/v2-${hash}`
  const article = {
    title: '图文', sourceUrl: 'https://mp.weixin.qq.com/s/test',
    images: ['https://mmbiz.qpic.cn/a.png'], html: '<img data-relay-image="0">',
  }
  const read = async () => new Blob(['file'], { type: 'image/png' })
  const adapter = (type) => new Zhihu(async (url, init) => {
    if (url === 'https://api.zhihu.com/images') return Response.json({ upload_file: { state: 1, image_id: '1' } })
    if (url === 'https://api.zhihu.com/images/1') return Response.json({ status: 'success' })
    assert.equal(url, cdn)
    assert.equal(init.method, 'HEAD')
    assert.equal(init.credentials, 'omit')
    return new Response(null, { headers: { 'content-type': type } })
  })
  assert.equal(await adapter('image/png').prepareContent(article, read, () => {}), `<figure><img src="${cdn}"></figure>`)
  await assert.rejects(adapter('text/html').prepareContent(article, read, () => {}), /知乎未返回可用的图片链接/)
})

test('reports image transfer errors with the affected image index', async () => {
  const zhihu = new Zhihu(async () => new Response(null, { status: 500 }))
  await assert.rejects(zhihu.prepareContent({
    title: '图文', sourceUrl: 'https://mp.weixin.qq.com/s/test',
    images: ['https://mmbiz.qpic.cn/a.png'], html: '<img data-relay-image="0">',
  }, async () => new Blob(['file'], { type: 'image/png' }), () => {}), /上传图片 1\/1：请求图片上传凭证失败（HTTP 500）/)
})

test('reports dropped image markers before transferring any images', async () => {
  const zhihu = new Zhihu(async () => assert.fail('unexpected transfer'))
  await assert.rejects(zhihu.prepareContent({
    title: '图文', sourceUrl: 'https://mp.weixin.qq.com/s/test',
    images: ['https://mmbiz.qpic.cn/a.png'], html: '<p>正文</p>',
  }, () => assert.fail('unexpected local read'), () => {}), /公众号正文与图片列表不一致/)
})

test('uploads local bytes without requesting the source URL from the target adapter', async () => {
  const source = 'https://mmbiz.qpic.cn/carousel.jpg'
  const bytes = new Uint8Array([255, 216, 255, 217])
  const calls = []
  const zhihu = new Zhihu(async (url, init) => {
    calls.push(url)
    if (url === 'https://api.zhihu.com/images') {
      assert.equal(init.credentials, 'include')
      assert.equal(JSON.parse(init.body).image_hash, createHash('md5').update(bytes).digest('hex'))
      return Response.json({ upload_file: { state: 0, object_key: 'v2-photo.jpg' }, upload_token: {
        access_id: 'test-id', access_key: 'test-secret', access_token: 'test-token',
      } })
    }
    assert.equal(url, 'https://zhihu-pics-upload.zhimg.com/v2-photo.jpg')
    assert.equal(init.method, 'PUT')
    assert.equal(init.credentials, 'omit')
    assert.deepEqual(new Uint8Array(init.body), bytes)
    const date = init.headers['x-oss-date']
    const signature = createHmac('sha1', 'test-secret').update([
      'PUT', '', 'image/jpeg', date, `x-oss-date:${date}`,
      'x-oss-security-token:test-token', 'x-oss-user-agent:aliyun-sdk-js/6.8.0', '/zhihu-pics/v2-photo.jpg',
    ].join('\n')).digest('base64')
    assert.equal(init.headers.Authorization, `OSS test-id:${signature}`)
    return new Response(null, { status: 200 })
  })
  const progress = []
  const content = await zhihu.prepareContent({
    title: '图文', sourceUrl: 'https://mp.weixin.qq.com/s/test', images: [source],
    html: '<img data-relay-image="0"><p>正文</p>',
  }, async (url) => {
    assert.equal(url, source)
    return new Blob([bytes], { type: 'image/jpeg' })
  }, (...args) => progress.push(args))
  assert.equal(calls.length, 2)
  assert.deepEqual(progress, [[1, 1]])
  assert.equal(content, '<figure><img src="https://pic4.zhimg.com/v2-photo.jpg"></figure><p>正文</p>')
})

test('resumes a partially downloaded import across application restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'article-relay-task-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = 'https://mmbiz.qpic.cn/first.png'
  const second = 'https://mmbiz.qpic.cn/second.png'
  let store = await TaskStore.open(root)
  const url = 'https://mp.weixin.qq.com/s/one'
  const task = await store.findOrCreate(`${url}?scene=1`)
  await store.update(task.id, {
    title: '图文', article: { title: '图文', images: [first, second, first], html: '', sourceUrl: url },
  })
  const calls = []
  const image = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })
  await assert.rejects(store.downloadImages(task.id, async (address, options) => {
    calls.push(address)
    assert.equal(options.referrer, 'https://mp.weixin.qq.com/')
    return address === second ? new Response(null, { status: 503 }) : image()
  }, () => {}), /下载图片 2\/2失败/)
  assert.equal(taskSummary(store.get(task.id)).downloaded, 1)
  store = await TaskStore.open(root)
  assert.equal((await store.findOrCreate(`${url}?scene=2`)).id, task.id)
  await store.downloadImages(task.id, async (address) => { calls.push(address); return image() }, () => {})
  assert.deepEqual(calls, [first, second, second])
  assert.equal(store.list()[0].importState, 'ready')
  store = await TaskStore.open(root)
  await store.downloadImages(task.id, () => assert.fail('unexpected redownload'), () => {})
  assert.deepEqual(new Uint8Array(await (await store.readImage(task.id, first)).arrayBuffer()), new Uint8Array([1, 2, 3]))
})

test('preserves the legacy draft and task history across restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'article-relay-legacy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const url = 'https://mp.weixin.qq.com/s/legacy'
  await writeFile(join(root, 'last-draft.json'), JSON.stringify({ source: url, title: '旧稿', owner: 'account', id: '123', saved: true }))
  let store = await TaskStore.open(root)
  const task = await store.findOrCreate(url)
  assert.equal(task.runs[0].draftId, '123')
  assert.equal(task.importState, 'pending')
  await store.update(task.id, { importState: 'reading', runs: [
    { ...task.runs[0], id: 'new-run', state: 'running' },
    { ...task.runs[0], id: 'publish-run', state: 'publishing', draftId: '456' },
    ...task.runs,
  ] })
  store = await TaskStore.open(root)
  const restored = store.get(task.id)
  assert.equal(restored.importState, 'failed')
  assert.deepEqual(restored.runs.map((run) => run.state), ['failed', 'publish-uncertain', 'saved'])
  assert.equal(restored.runs[1].draftId, '456')
  assert.match(restored.runs[1].error, /尚未确认发布结果/)
  assert.equal(restored.runs[2].draftId, '123')
  assert.equal(store.list()[0].runs[2].owner, undefined)
})

test('deletes only the selected task and its media, and allows the source to be imported again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'article-relay-delete-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await TaskStore.open(root)
  const source = 'https://mp.weixin.qq.com/s/delete-test'
  const image = 'https://mmbiz.qpic.cn/shared.png'
  const removed = await store.findOrCreate(source)
  const kept = await store.findOrCreate('https://mp.weixin.qq.com/s/keep-test')
  for (const task of [removed, kept]) {
    await store.update(task.id, { article: { title: '图片', images: [image], html: '', sourceUrl: task.sourceUrl } })
    await store.downloadImages(task.id, async () => new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'image/png' },
    }), () => {})
  }
  assert.deepEqual(await store.delete(removed.id), { mediaRemoved: true })
  await assert.rejects(access(join(root, 'media', removed.id)), { code: 'ENOENT' })
  const reopened = await TaskStore.open(root)
  assert.deepEqual(reopened.list().map((task) => task.id), [kept.id])
  assert.deepEqual(new Uint8Array(await (await reopened.readImage(kept.id, image)).arrayBuffer()), new Uint8Array([1, 2, 3]))
  const recreated = await reopened.findOrCreate(source)
  assert.equal(recreated.id, removed.id)
  assert.equal(recreated.importState, 'pending')
  assert.deepEqual(recreated.runs, [])
})

test('recreates a deleted draft once using the same prepared content', async () => {
  const calls = []
  const photos = '<figure><img src="https://pic4.zhimg.com/photo.png"></figure>'
  const zhihu = new Zhihu(async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/111/draft')) return new Response(null, { status: 404 })
    if (url.endsWith('/drafts')) return Response.json({ id: '222' })
    assert.match(url, /\/222\/draft$/)
    return new Response(null, { status: 204 })
  })
  const changes = []
  const id = await zhihu.saveDraft('标题', photos, '111', async (next) => { changes.push(next) })
  assert.equal(id, '222')
  assert.deepEqual(changes, [undefined, '222'])
  assert.deepEqual(calls.map((call) => call.init.method), ['PATCH', 'POST', 'PATCH'])
  assert.equal(calls[0].init.body, calls[2].init.body)
})

test('does not create a new draft for authorization errors or loop when a new draft is missing', async () => {
  let requests = 0
  const denied = new Zhihu(async () => { requests++; return new Response(null, { status: 403 }) })
  await assert.rejects(denied.saveDraft('标题', '<p>正文</p>', '111', () => assert.fail('unexpected draft switch')), /403/)
  assert.equal(requests, 1)
  const missing = new Zhihu(async (_url, init) => {
    requests++
    return init.method === 'POST' ? Response.json({ id: '222' }) : new Response(null, { status: 404 })
  })
  await assert.rejects(missing.saveDraft('标题', '<p>正文</p>', '111', async () => {}), /刚创建的草稿无法写入/)
  assert.equal(requests, 4)
})
