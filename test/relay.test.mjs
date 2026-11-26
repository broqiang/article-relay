import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { wechatArticleUrl } from '../dist/wechat.js'
import { draftUrl, Zhihu } from '../dist/zhihu.js'
import { checkZhihuArticle, publishZhihuDraft } from '../dist/zhihu-publish.js'
import { Weibo, findWeiboPublishedUrl, isWeiboSsoCallback, weiboArticleUrl, weiboDraftUrl, weiboEditor, weiboHistoryUrl } from '../dist/weibo.js'
import { checkWeiboArticle, publishWeiboDraft } from '../dist/weibo-publish.js'
import { chromiumUserAgent, publicationUrlStatus } from '../dist/browser.js'
import { checkJianshuAccount, jianshuHome } from '../dist/jianshu.js'
import { blockingPublication, canCheckJuejinAudit, canOpenDraft, clearPublishedRun, publishMissingPlatforms, TaskStore, taskSummary } from '../dist/tasks.js'
import { Juejin, juejinArticleId, juejinDraftUrl, parseJuejinDefaults } from '../dist/juejin.js'
import { uploadJuejinImage } from '../dist/juejin-images.js'
import { publishJuejinDraft } from '../dist/juejin-publish.js'
import { monitorJuejinPublishResponse } from '../dist/juejin-publish-response.js'
import { monitorJuejinAudits } from '../dist/juejin-audit.js'

test('initializes the bridge without CommonJS exports in a sandboxed preload', async () => {
  const preload = readFileSync(new URL('../dist/preload.js', import.meta.url), 'utf8')
  let bridge
  let weiboAccountChanged
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'relay')
        bridge = api
      },
    },
    ipcRenderer: {
      invoke: async (channel, args) => args ? { channel, args } : channel,
      on(channel, listener) {
        assert.equal(channel, 'relay:weibo-account-changed')
        weiboAccountChanged = listener
      },
    },
  }
  runInNewContext(preload, { require: (name) => {
    assert.equal(name, 'electron')
    return electron
  } })
  assert.equal(await bridge.getVersion(), 'relay:version')
  assert.equal(await bridge.hasUpdate(), 'relay:has-update')
  assert.equal(await bridge.openReleases(), 'relay:open-releases')
  assert.equal(await bridge.openRepository(), 'relay:open-repository')
  assert.equal(JSON.stringify(await bridge.setSettingsOpen(false)), '{"channel":"relay:settings-open","args":{"settingsOpen":false}}')
  assert.equal(await bridge.restart(), 'relay:restart')
  assert.equal(await bridge.openZhihu(), 'relay:open-zhihu')
  assert.equal(await bridge.openWeibo(), 'relay:open-weibo')
  assert.equal(await bridge.openJuejin(), 'relay:open-juejin')
  assert.equal(await bridge.openJianshu(), 'relay:open-jianshu')
  assert.equal(await bridge.getJuejinDefaults(), 'relay:juejin-defaults')
  assert.equal(JSON.stringify(await bridge.searchJuejinTags('123', 'JavaScript')),
    '{"channel":"relay:juejin-tags","args":{"owner":"123","query":"JavaScript"}}')
  assert.equal(await bridge.checkAccount(), 'relay:account')
  assert.equal(JSON.stringify(await bridge.checkAccount('jianshu')),
    '{"channel":"relay:account","args":{"platform":"jianshu"}}')
  assert.equal(JSON.stringify(await bridge.deleteTask('task')), '{"channel":"relay:delete-task","args":{"taskId":"task"}}')
  assert.equal(JSON.stringify(await bridge.deletePublication('task', 'run')), '{"channel":"relay:delete-publication","args":{"taskId":"task","runId":"run"}}')
  assert.equal(JSON.stringify(await bridge.publishAll('task')), '{"channel":"relay:publish-all","args":{"taskId":"task"}}')
  assert.equal(JSON.stringify(await bridge.publishArticle('task')), '{"channel":"relay:publish","args":{"taskId":"task"}}')
  assert.equal(JSON.stringify(await bridge.publishArticle('task', 'weibo')), '{"channel":"relay:publish","args":{"taskId":"task","platform":"weibo"}}')
  assert.equal(JSON.stringify(await bridge.showDraft('task', 'run')), '{"channel":"relay:show-draft","args":{"taskId":"task","runId":"run"}}')
  assert.equal(JSON.stringify(await bridge.hideBrowser(true)),
    '{"channel":"relay:hide-browser","args":{"returnFromDraft":true}}')
  assert.equal(JSON.stringify(await bridge.openZhihuArticle('task', 'run')),
    '{"channel":"relay:show-article","args":{"taskId":"task","runId":"run","openOnly":true}}')
  assert.equal(JSON.stringify(await bridge.openJuejinResult('task', 'run')),
    '{"channel":"relay:open-juejin-result","args":{"taskId":"task","runId":"run"}}')
  assert.equal(JSON.stringify(await bridge.openWeiboResult('task', 'run')),
    '{"channel":"relay:open-weibo-result","args":{"taskId":"task","runId":"run"}}')
  assert.equal(JSON.stringify(await bridge.markPublished('task', 'run')), '{"channel":"relay:mark-published","args":{"taskId":"task","runId":"run"}}')
  const accounts = []
  bridge.onWeiboAccountChanged((name) => accounts.push(name))
  weiboAccountChanged({ sender: 'internal event' }, '微博账号')
  weiboAccountChanged({ sender: 'internal event' }, null)
  assert.deepEqual(accounts, ['微博账号', null])
})

test('reads Jianshu account state without treating invalid pages as signed out', async () => {
  const page = (data) => new Response(
    `<script type="application/json" data-name="page-data">${JSON.stringify(data)}</script>`,
  )
  const signedOut = await checkJianshuAccount(async (url, init) => {
    assert.equal(url, jianshuHome)
    assert.equal(init.credentials, 'include')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.redirect, 'manual')
    return page({ user_signed_in: false })
  })
  assert.equal(signedOut, null)
  assert.deepEqual(await checkJianshuAccount(async () =>
    page({ user_signed_in: true, current_user: { id: 123, nickname: '测试账号' } })),
  { id: '123', name: '测试账号' })
  await assert.rejects(checkJianshuAccount(async () => page({ user_signed_in: true })), /无法识别|未返回可识别/)
  await assert.rejects(checkJianshuAccount(async () => new Response('<html>验证码</html>')), /未返回可识别/)
  await assert.rejects(checkJianshuAccount(async () => new Response(null, { status: 403 })), /HTTP 403/)
})

test('publishes only eligible platforms, keeps going after failures, and includes a cleared platform on retry', async () => {
  const published = { id: 'wb', platform: 'weibo', owner: 'original', draftId: '9', state: 'published' }
  const relatedFailure = { ...published, id: 'wb-failed', state: 'failed' }
  const zhihuFailure = { id: 'zh-failed', platform: 'zhihu', state: 'failed' }
  const task = { importState: 'ready', article: {}, runs: [relatedFailure, zhihuFailure, published] }
  const attempts = []
  const batch = (publish) => publishMissingPlatforms(() => task, async (current, platform) => {
    attempts.push(platform)
    return publish(current, platform)
  })
  const states = (outcomes) => outcomes.map(({ state }) => state)

  assert.equal(blockingPublication(task.runs, 'weibo'), published)
  assert.deepEqual(states(await batch(() => ({ loginRequired: true }))), ['login-required', 'already-published', 'login-required'])
  assert.deepEqual(attempts, ['zhihu', 'juejin'])

  task.runs = clearPublishedRun(task.runs, published)
  assert.deepEqual(task.runs, [zhihuFailure])
  attempts.length = 0
  const retried = await batch((_task, platform) => {
    if (platform === 'zhihu') throw new Error('连接失败')
    if (platform === 'juejin') return { saved: true, publishNotice: '请补齐分类和标签。' }
    return { published: true }
  })
  assert.deepEqual(states(retried), ['failed', 'published', 'saved'])
  assert.equal(retried[0].detail, '连接失败')
  assert.deepEqual(attempts, ['zhihu', 'weibo', 'juejin'])

  task.runs = [{ ...zhihuFailure, state: 'publish-uncertain' }, published]
  attempts.length = 0
  task.runs.push({ platform: 'juejin', state: 'publish-uncertain' })
  assert.deepEqual(states(await batch(() => assert.fail('unexpected publication'))), ['needs-check', 'already-published', 'needs-check'])
  assert.deepEqual(attempts, [])
})

test('checks the Juejin account and reuses only its own draft with the saved publishing fields', async () => {
  const id = '7325611798135062578'
  const owner = '254742430764728'
  let account = null
  const draft = { id, user_id: owner, article_id: '0', category_id: '123', tag_ids: ['456'], brief_content: '原来的摘要' }
  const changed = []
  const requests = []
  const juejin = new Juejin(async (input, init) => {
    const url = new URL(input)
    assert.equal(url.origin, 'https://api.juejin.cn')
    assert.equal(url.searchParams.get('aid'), '2608')
    assert.equal(init.credentials, 'include')
    if (url.pathname.endsWith('/user/get')) return Response.json({ err_no: 0, data: account })
    const body = JSON.parse(init.body)
    requests.push([url.pathname, body])
    if (url.pathname.endsWith('/detail')) return Response.json({ err_no: 0, data: draft })
    if (url.pathname.endsWith('/update')) return Response.json({ err_no: 0, data: null })
    if (url.pathname.endsWith('/create')) return Response.json({ err_no: 0, data: { id, user_id: owner } })
    assert.fail(`Unexpected URL ${url}`)
  })
  assert.equal(await juejin.account(), null)
  account = { user_id: owner, user_name: '测试作者' }
  assert.equal((await juejin.account()).name, '测试作者')
  const content = { markdown: '## 正文', summary: '摘要', images: [] }
  const remember = async (next) => changed.push(next)
  assert.equal(await juejin.saveDraft(owner, '标题', content, undefined, remember), id)
  assert.deepEqual(changed, [id])
  assert.equal(requests[0][1].category_id, '0')
  assert.deepEqual(requests[0][1].tag_ids, [])
  assert.equal(await juejin.saveDraft(owner, '标题', content, id, remember), id)
  assert.equal(requests[2][1].id, id)
  assert.equal(requests[2][1].mark_content, content.markdown)
  assert.equal(requests[2][1].brief_content, '原来的摘要')
  assert.deepEqual(requests[2][1].tag_ids, ['456'])
  await assert.rejects(juejin.saveDraft('987', '标题', content, id, remember), /无法核对/)
  assert.equal(requests.length, 4)
})

test('loads and validates Juejin defaults and saves them with a new draft', async () => {
  const id = '7325611798135062578'
  const owner = '254742430764728'
  const category = { id: '6809637767543259144', name: '前端' }
  const tag = { id: '6809640408797167623', name: 'JavaScript' }
  const changed = []
  const juejin = new Juejin(async (input, init) => {
    const path = new URL(input).pathname
    if (path.endsWith('/user/get')) return Response.json({ err_no: 0, data: { user_id: owner, can_tag_cnt: 1 } })
    if (path.endsWith('/query_category_list')) return Response.json({ err_no: 0, data: [
      { category: { category_id: category.id, category_name: category.name } },
    ] })
    if (path.endsWith('/query_tag_list')) {
      assert.deepEqual(JSON.parse(init.body), { cursor: '0', key_word: tag.name, limit: 20, sort_type: 1 })
      return Response.json({ err_no: 0, data: [{ tag: { tag_id: tag.id, tag_name: tag.name } }] })
    }
    assert.ok(path.endsWith('/create'))
    const body = JSON.parse(init.body)
    assert.equal(body.category_id, category.id)
    assert.deepEqual(body.tag_ids, [tag.id])
    assert.equal(body.brief_content, '正文摘要')
    return Response.json({ err_no: 0, data: { id, user_id: owner } })
  })
  const defaults = await juejin.validateDefaults({ category, tags: [tag] }, (await juejin.account()).tagLimit)
  assert.deepEqual(defaults, { category, tags: [tag] })
  await assert.rejects(juejin.validateDefaults({ category, tags: [tag] }, 0), /无法添加标签/)
  await assert.rejects(juejin.validateDefaults({ category, tags: [{ ...tag, id: '456' }] }, 1), /已失效/)
  assert.equal(parseJuejinDefaults({ category, tags: [tag, tag] }), undefined)
  assert.equal(await juejin.saveDraft(owner, '标题', { markdown: '正文', summary: '正文摘要', images: [] }, undefined,
    async (next) => changed.push(next), defaults), id)
  assert.deepEqual(changed, [id])
})

test('isolates Juejin defaults by account and retains them across restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'article-relay-juejin-defaults-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = { category: { id: '11', name: '前端' }, tags: [{ id: '12', name: 'JavaScript' }] }
  const second = { category: { id: '21', name: '后端' }, tags: [{ id: '22', name: 'Java' }] }
  const store = await TaskStore.open(root)
  assert.equal(await store.juejinDefaults('1'), undefined)
  await store.saveJuejinDefaults('1', first)
  await store.saveJuejinDefaults('2', second)
  const reopened = await TaskStore.open(root)
  assert.deepEqual(await reopened.juejinDefaults('1'), first)
  assert.deepEqual(await reopened.juejinDefaults('2'), second)
  assert.equal(await reopened.juejinDefaults('3'), undefined)
})

test('reads native Juejin draft details only for the expected owner', async () => {
  let draftOwner = '123'
  const juejin = new Juejin(async (input, init) => {
    const path = new URL(input).pathname
    assert.ok(path.endsWith('/detail'))
    assert.deepEqual(JSON.parse(init.body), { draft_id: '456' })
    return Response.json({ err_no: 0, data: {
      article_draft: { id: '456', article_id: '0', mark_content: '正文' }, author_user_info: { user_id: draftOwner },
      category: { category: { category_id: '789' } }, tags: [{ tag_id: '321' }],
    } })
  })
  const draft = await juejin.draft('456', '123')
  assert.equal(draft.category_id, '789')
  assert.deepEqual(draft.tag_ids, ['321'])
  draftOwner = '999'
  await assert.rejects(juejin.draft('456', '123'), /无法核对/)
})

test('clears all local Juejin publication attempts while preserving the task, other platforms and other tasks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'article-relay-juejin-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await TaskStore.open(root)
  const task = await store.findOrCreate('https://mp.weixin.qq.com/s/juejin-history')
  const other = await store.findOrCreate('https://mp.weixin.qq.com/s/another-article')
  const attempt = { id: 'pending', platform: 'juejin', owner: '123', account: '掘金账号', startedAt: new Date().toISOString(),
    state: 'publish-uncertain', draftId: '456', articleId: '789' }
  const history = [attempt, { ...attempt, id: 'saved', state: 'saved', owner: '999' }, { ...attempt, id: 'failed', state: 'failed' }]
  const otherPlatform = { ...attempt, id: 'weibo', platform: 'weibo', state: 'published' }
  const article = { title: '原文', html: '<p>正文</p>', images: [], sourceUrl: task.sourceUrl }
  await store.update(task.id, { article, runs: [...history, otherPlatform] })
  await store.update(other.id, { runs: [attempt] })

  await assert.rejects(store.clearJuejinPublicationHistory(task.id, 'weibo'), /无法清理/)
  await store.update(task.id, { runs: [...history, otherPlatform, { ...attempt, id: 'published', state: 'published' }] })
  await assert.rejects(store.clearJuejinPublicationHistory(task.id, 'pending'), /无法清理/)
  await store.update(task.id, { runs: [...history, otherPlatform] })
  await store.clearJuejinPublicationHistory(task.id, 'pending')
  const reopened = await TaskStore.open(root)
  assert.deepEqual(reopened.get(task.id).runs, [otherPlatform])
  assert.deepEqual(reopened.get(task.id).article, article)
  assert.deepEqual(reopened.get(other.id).runs, [attempt])
})

test('requires a publicly accessible Juejin article with the exact draft and article identifiers', async () => {
  const id = '7099412338641469453'
  const draftId = '7099392333216481311'
  const url = `https://juejin.cn/post/${id}`
  assert.equal(juejinArticleId(`${url}?utm_source=relay`), id)
  assert.equal(juejinArticleId(`https://juejin.cn/spost/${id}`), undefined)
  assert.equal(juejinArticleId(`https://juejin.cn.example.com/post/${id}`), undefined)
  let html = `<article class="article" data-entry-id="${id}" data-draft-id="${draftId}">正文</article>`
  const juejin = new Juejin(async (address, options) => {
    assert.equal(address, url)
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    return { ok: true, url: '', text: async () => html }
  })
  assert.equal(await juejin.publicArticle(id, draftId), true)
  assert.equal(await juejin.publicArticle(id, '999'), false)
  html = `<p>审核中</p><article data-entry-id="${id}"></article>`
  assert.equal(await juejin.publicArticle(id, draftId), false)
})

test('uploads each distinct Juejin image through ImageX and passes the native image references to the draft', async () => {
  const uri = 'tos-cn-i-73owjymdk6/test-picture'
  const cdn = `https://p3-juejin.byteimg.com/${uri}~tplv-73owjymdk6-image.image`
  const stages = []
  const progress = []
  let reads = 0
  const juejin = new Juejin(async (input, init) => {
    const url = new URL(input)
    if (url.hostname === 'api.juejin.cn') {
      assert.equal(init.credentials, 'include')
      if (url.pathname.endsWith('/gen_token')) {
        stages.push('token')
        return Response.json({ err_no: 0, data: { token: {
          AccessKeyId: 'test-id', SecretAccessKey: 'test-secret', SessionToken: 'test-token',
        } } })
      }
      assert.equal(url.searchParams.get('uri'), uri)
      stages.push('image-url')
      return Response.json({ err_no: 0, data: { main_url: cdn } })
    }
    assert.equal(init.credentials, 'omit')
    assert.equal(init.redirect, 'error')
    if (url.hostname === 'imagex.bytedanceapi.com') {
      assert.match(init.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=test-id\//)
      if (url.searchParams.get('Action') === 'ApplyImageUpload') {
        stages.push('apply')
        return Response.json({ Result: { UploadAddress: {
          SessionKey: Buffer.from(JSON.stringify({ uploadHost: 'https://unsupported.example' })).toString('base64'),
          UploadHosts: ['tos-lq-x.bytedancevod.com'],
          StoreInfos: [{ StoreUri: uri, Auth: 'transfer-token' }],
        } } })
      }
      stages.push('commit')
      assert.equal(init.method, 'POST')
      return Response.json({ Result: { Results: [{ UriStatus: 2000 }] } })
    }
    stages.push('upload')
    assert.equal(url.href, `https://tos-lq-x.bytedancevod.com/${uri}`)
    assert.equal(init.method, 'POST')
    assert.equal(init.headers.Authorization, 'transfer-token')
    assert.equal(init.headers['Content-CRC32'], 'cbf43926')
    assert.equal(Buffer.from(init.body).toString(), '123456789')
    return new Response(null, { status: 200 })
  })
  const content = await juejin.prepareContent({ html: '导入正文', images: ['local-a', 'local-a'] }, async () => {
    reads++
    return new Blob(['123456789'], { type: 'image/png' })
  }, (completed, total) => progress.push([completed, total]), async (html, images) => {
    assert.equal(html, '导入正文')
    assert.deepEqual(images, [uri, uri])
    return { markdown: `![](${uri})`, summary: '导入正文' }
  })
  assert.equal(reads, 1)
  assert.deepEqual(progress, [[0, 1], [1, 1]])
  assert.deepEqual(stages, ['token', 'apply', 'upload', 'commit', 'image-url'])
  assert.deepEqual(content.images, [{ pic_uri: uri, pic_url: cdn }])
})

test('uses the first ImageX upload host across domain families and rejects malformed destinations', async () => {
  const api = async () => ({ token: { AccessKeyId: 'test-id', SecretAccessKey: 'test-secret', SessionToken: 'test-token' } })
  const uri = 'tos-cn-i-73owjymdk6/test-picture'
  const cases = [
    { hosts: ['https://tos-lf-x-tob.bytecdn.cn/'], expected: `https://tos-lf-x-tob.bytecdn.cn/${uri}` },
    { hosts: ['https://tos-d-x-lf.douyin.com', 'tos-d-x-hl.snssdk.com'],
      expected: `https://tos-d-x-lf.douyin.com/${uri}` },
    { hosts: ['tos-lq-x.bytedancevod.com'], expected: `https://tos-lq-x.bytedancevod.com/${uri}` },
    { hosts: ['upload-test.net'], expected: `https://upload-test.net/${uri}` },
    ...[undefined, [], ['https://user@upload-test.net'], ['http://upload-test.net'], ['upload-test.net:8080'],
      ['upload-test.net/redirect'], ['upload-test.net?token=private'], ['127.0.0.1'], ['[::1]'], ['app.localhost'],
      ['unsupported.example', 'tos-d-x-hl.snssdk.com']].map((hosts) => ({ hosts })),
  ]
  const sessionKey = Buffer.from(JSON.stringify({ uploadHost: 'tos-d-x-hl.snssdk.com' })).toString('base64')
  for (const { hosts, expected } of cases) {
    const calls = []
    const request = async (input, init) => {
      calls.push(input)
      if (calls.length === 1) return Response.json({ Result: { UploadAddress: {
        UploadHosts: hosts, SessionKey: sessionKey, StoreInfos: [{ StoreUri: uri, Auth: 'transfer-token' }],
      } } })
      assert.equal(input, expected)
      assert.equal(init.redirect, 'error')
      return new Response(null, { status: 500 })
    }
    await assert.rejects(uploadJuejinImage(api, request, new Blob(['test'])),
      expected ? /图片上传失败（HTTP 500）/ : /ImageX 未返回有效的 HTTPS 上传主机/)
    assert.equal(calls.length, expected ? 2 : 1)
  }
})

test('uses different ImageX upload hosts per image and leaves an invalid fourth image unconfirmed', async () => {
  const progress = []
  const hosts = ['tos-d-x-hl.snssdk.com', 'tos-d-x-lf.douyin.com', 'tos-lq-x.bytedancevod.com', '127.0.0.1']
  const uploadedHosts = []
  let image = 0
  const juejin = new Juejin(async (input) => {
    const url = new URL(input)
    if (url.pathname.endsWith('/gen_token')) {
      image++
      return Response.json({ err_no: 0, data: { token: {
        AccessKeyId: 'test-id', SecretAccessKey: 'test-secret', SessionToken: 'test-token',
      } } })
    }
    if (url.searchParams.get('Action') === 'ApplyImageUpload') {
      return Response.json({ Result: { UploadAddress: {
        SessionKey: 'opaque', UploadHosts: [hosts[image - 1]],
        StoreInfos: [{ StoreUri: `tos-cn-i-73owjymdk6/test-${image}`, Auth: 'transfer-token' }],
      } } })
    }
    assert.ok(image < 4)
    if (url.searchParams.get('Action') === 'CommitImageUpload') {
      return Response.json({ Result: { Results: [{ UriStatus: 2000 }] } })
    }
    if (url.pathname.endsWith('/get_img_url')) {
      return Response.json({ err_no: 0, data: { main_url: `https://p3-juejin.byteimg.com/tos-cn-i-73owjymdk6/test-${image}` } })
    }
    uploadedHosts.push(url.hostname)
    return new Response(null, { status: 200 })
  })
  await assert.rejects(juejin.prepareContent({ html: '', images: ['1', '2', '3', '4'] }, async () => new Blob(['test']),
    (completed, total) => progress.push([completed, total]), async () => assert.fail('正文转换应在全部图片确认后开始')),
  /第 4\/4 张图片失败，已确认 3 张.*ImageX 未返回有效的 HTTPS 上传主机/)
  assert.deepEqual(progress, [[0, 4], [1, 4], [2, 4], [3, 4]])
  assert.deepEqual(uploadedHosts, hosts.slice(0, 3))
})

test('matches Juejin creator history by draft identifier and reports the audit status', async () => {
  const owner = '123456'
  const juejin = new Juejin(async (input) => {
    const path = new URL(input).pathname
    if (path.endsWith('/user/get')) return Response.json({ err_no: 0, data: { user_id: owner } })
    if (path.endsWith('/detail')) return Response.json({ err_no: 0, data: { id: '111', user_id: owner, article_id: '0' } })
    assert.ok(path.endsWith('/list_by_user'))
    return Response.json({ err_no: 0, data: [
      { article_info: { article_id: '999', draft_id: '222', audit_status: 2 } },
      { article_info: { article_id: '333', draft_id: '111', audit_status: 1 } },
    ] })
  })
  assert.deepEqual(await juejin.findArticle('111', owner), { id: '333', status: '审核中', audit: 'reviewing' })
})

test('extracts a Juejin publish error only from the current draft and keeps only safe diagnostics', async () => {
  const debuggerClient = new EventEmitter()
  let attached = false
  const inspected = []
  Object.assign(debuggerClient, {
    isAttached: () => attached,
    attach: () => { attached = true },
    detach: () => { attached = false },
    async sendCommand(method, params) {
      if (method === 'Network.enable') return {}
      assert.equal(method, 'Network.getResponseBody')
      inspected.push(params.requestId)
      return { base64Encoded: true, body: Buffer.from(JSON.stringify({
        err_no: 123, err_msg: '发布受限 https://example.com/?token=hidden cookie=secret', data: { content: '隐藏正文' },
      })).toString('base64') }
    },
  })
  const url = 'https://api.juejin.cn/content_api/v1/article/publish?aid=2608'
  const observer = monitorJuejinPublishResponse(debuggerClient, '456')
  await observer.start()
  const emit = (method, args) => debuggerClient.emit('message', {}, `Network.${method}`, args)
  for (const [requestId, method, address, draftId] of [
    ['other-draft', 'POST', url, '999'], ['preflight', 'OPTIONS', url, '456'],
    ['other-host', 'POST', url.replace('api.juejin.cn', 'api.juejin.cn.example.org'), '456'], ['publish', 'POST', url, '456'],
  ]) {
    emit('requestWillBeSent', { requestId, request: { url: address, method, postData: JSON.stringify({ draft_id: draftId }) } })
    emit('responseReceived', { requestId, response: { url: address, status: 200 } })
    emit('loadingFinished', { requestId })
  }
  await Promise.resolve()
  observer.close()
  assert.deepEqual(inspected, ['publish'])
  const diagnostic = observer.diagnostic()
  assert.equal(diagnostic.rejected, true)
  assert.match(diagnostic.notice, /HTTP 200，业务码 123.*发布受限 〔链接〕 〔凭证〕/)
  assert.doesNotMatch(diagnostic.notice, /hidden|secret|隐藏正文/)
  assert.equal(debuggerClient.listenerCount('message'), 0)
  assert.equal(attached, false)
})

test('distinguishes a verified Juejin review preview, an explicit rejection, and a public article', async () => {
  const draft = '111'
  const article = '222'
  const owner = '333'
  const markup = `<article data-entry-id="${article}" data-draft-id="${draft}">正文</article>`
  let auditStatus
  let preview = markup
  let publicStatus = 404
  let previewReads = 0
  const juejin = new Juejin(async (input, init) => {
    const path = new URL(input).pathname
    if (path === `/post/${article}`) {
      assert.equal(init.credentials, 'omit')
      return new Response(markup, { status: publicStatus })
    }
    if (path === `/spost/${article}`) {
      assert.equal(init.credentials, 'include')
      assert.equal(init.redirect, 'error')
      previewReads++
      return new Response(preview)
    }
    if (path.endsWith('/user/get')) return Response.json({ err_no: 0, data: { user_id: owner } })
    if (path.endsWith('/detail')) return Response.json({ err_no: 0, data: { id: draft, user_id: owner, article_id: article } })
    assert.ok(path.endsWith('/list_by_user'))
    return Response.json({ err_no: 0, data: auditStatus === undefined ? [] : [
      { article_info: { article_id: article, draft_id: draft, audit_status: auditStatus } },
    ] })
  })
  assert.deepEqual(await juejin.publicationStatus(draft, owner, article), { id: article, audit: 'reviewing', status: '审核中' })
  assert.equal(previewReads, 1)
  assert.deepEqual(await juejin.publicationStatus(draft, '987', article), {})
  assert.equal(previewReads, 1)
  preview = markup.replace(`data-draft-id="${draft}"`, 'data-draft-id="999"')
  assert.deepEqual(await juejin.publicationStatus(draft, owner), { id: article })
  auditStatus = -1
  assert.deepEqual(await juejin.publicationStatus(draft, owner, article), { id: article, audit: 'rejected', status: '审核未通过' })
  assert.equal(previewReads, 2)
  publicStatus = 200
  assert.deepEqual(await juejin.publicationStatus(draft, owner, article), { id: article, url: `https://juejin.cn/post/${article}` })
})

test('checks Juejin audits after 30 seconds and every minute until a manual check or window close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = { taskId: 'task', runId: 'first' }
  const second = { taskId: 'task', runId: 'second' }
  const checked = []
  let finishSecond
  const monitor = monitorJuejinAudits(async (target) => {
    checked.push(target.runId)
    if (target === second) await new Promise((resolve) => { finishSecond = resolve })
  })
  monitor.sync([first])
  t.mock.timers.tick(29_999)
  assert.deepEqual(checked, [])
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.deepEqual(checked, ['first'])
  monitor.sync([first, second])
  t.mock.timers.tick(30_000)
  assert.deepEqual(checked, ['first', 'second'])
  monitor.sync([first])
  finishSecond()
  await Promise.resolve()
  t.mock.timers.tick(30_000)
  await Promise.resolve()
  assert.deepEqual(checked, ['first', 'second', 'first'])
  monitor.close()
  monitor.sync([first, second])
  t.mock.timers.tick(120_000)
  assert.deepEqual(checked, ['first', 'second', 'first'])
})

test('keeps Juejin audit tracking disabled after reopening a manually checked record', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'article-relay-juejin-audit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await TaskStore.open(root)
  const task = await store.findOrCreate('https://mp.weixin.qq.com/s/review')
  const run = { id: 'run', platform: 'juejin', owner: '123', account: '掘金账号', startedAt: new Date().toISOString(),
    draftId: '456', state: 'publish-uncertain', juejinAudit: 'reviewing' }
  assert.equal(canCheckJuejinAudit(run), true)
  assert.equal(blockingPublication([run], 'juejin'), run)
  assert.equal(canCheckJuejinAudit({ ...run, juejinAudit: 'rejected' }), false)
  assert.equal(canCheckJuejinAudit({ ...run, state: 'published' }), false)
  await store.update(task.id, { runs: [{ ...run, juejinAutoCheckStopped: true }] })
  const reopened = await TaskStore.open(root)
  const restored = reopened.get(task.id).runs[0]
  assert.equal(restored.juejinAutoCheckStopped, true)
  assert.equal(canCheckJuejinAudit(restored), false)
})

test('hides the draft action for submitted or published drafts, including older attempts', () => {
  const saved = { id: 'saved', platform: 'juejin', draftId: '456', state: 'saved' }
  const opened = { ...saved, id: 'current', state: 'publish-uncertain', manualHandoff: true }
  assert.equal(canOpenDraft(saved, [saved]), true)
  assert.equal(canOpenDraft(opened, [opened, saved]), true)
  const reviewing = { ...opened, articleId: '789', juejinAudit: 'reviewing' }
  assert.equal(canOpenDraft(reviewing, [reviewing, saved]), false)
  assert.equal(canOpenDraft(saved, [reviewing, saved]), false)
  const published = { ...reviewing, id: 'published', state: 'published', juejinAudit: undefined }
  assert.equal(canOpenDraft(opened, [published, opened]), false)
  assert.equal(canOpenDraft(opened, [{ ...published, draftId: '999' }, opened]), true)
  const task = { images: [], runs: [reviewing, saved] }
  assert.deepEqual(taskSummary(task).runs.map(({ canOpenDraft }) => canOpenDraft), [false, false])
})

test('clicks only the exact Juejin draft controls and treats losing the reply as an uncertain submission', async () => {
  const id = '7325611798135062578'
  const articleId = '7327100727163174950'
  const draft = juejinDraftUrl(id)
  const defaults = { category: { id: '456', name: '前端' }, tags: [{ id: '789', name: 'JavaScript' }] }
  for (const behavior of ['redirect', 'redirect-after-abort', 'published-route', 'unknown', 'unavailable', 'other-draft',
    'wrong-owner', 'wrong-title', 'missing-defaults', 'short-summary']) {
    let url = ''
    let opened = false
    let resultReads = 0
    const clicks = []
    const post = { id, title: behavior === 'wrong-title' ? '另一篇文章' : '标题', markdown: '## 正文',
      category: { id: '0' }, tags: [], brief_content: '摘要'.repeat(behavior === 'short-summary' ? 5 : 25) }
    const popup = { post, userId: behavior === 'wrong-owner' ? '999' : '123', isDraft: true, canPublish: true, tagLimit: 1,
      categoryList: [{ id: defaults.category.id, title: defaults.category.name }],
      handleTagsChange(tags) { post.tags = Array.from(tags, (tag) => ({ ...tag })) },
    }
    const controls = [false, true].filter((confirm) => !confirm || behavior !== 'unavailable').map((confirm) => ({
      textContent: confirm ? '确定并发布' : '发布', closest: () => confirm,
      getClientRects: () => confirm && !opened ? [] : [{}], getAttribute: () => null,
      click() {
        clicks.push(confirm)
        if (!confirm) { opened = true; return }
        assert.deepEqual(post.category, popup.categoryList[0])
        assert.deepEqual(post.tags, [{ id: '789', title: 'JavaScript' }])
        if (behavior === 'unknown') throw new Error('导航中断')
        url = behavior === 'published-route' ? 'https://juejin.cn/published/?source=editor' : `https://juejin.cn/spost/${articleId}`
        if (behavior === 'redirect-after-abort') throw new Error('导航中断')
      },
    }))
    const page = {
      async loadURL(address) { url = behavior === 'other-draft' ? juejinDraftUrl('123') : address },
      getURL() { return url },
      async executeJavaScript(script) {
        if (script.includes("sessionStorage.getItem('PUB_INFO')")) {
          if (resultReads++ === 0) throw new Error('结果页面正在加载')
          return articleId
        }
        assert.ok(script.includes(draft))
        return runInNewContext(script, {
          location: new URL(url), document: { querySelector: () => ({ __vue__: popup, querySelectorAll: () => controls }) },
        })
      },
    }
    const result = await publishJuejinDraft(page, id, { owner: '123', title: '标题',
      defaults: behavior === 'missing-defaults' ? undefined : defaults }, { waitMs: 240, resultWaitMs: 450 })
    const confirmed = ['redirect', 'redirect-after-abort', 'published-route'].includes(behavior)
    assert.equal(result.submitted, confirmed || behavior === 'unknown')
    assert.equal(result.articleId, confirmed ? articleId : undefined)
    assert.deepEqual(clicks, ['other-draft', 'wrong-owner', 'wrong-title'].includes(behavior) ? [] :
      confirmed || behavior === 'unknown' ? [false, true] : [false])
  }
})

test('accepts missing-article status only from the exact, non-redirected publication URL', async () => {
  const url = 'https://zhuanlan.zhihu.com/p/123456'
  const probe = (status, finalUrl = url, redirected = false) => publicationUrlStatus(async (address, options) => {
    assert.equal(address, url)
    assert.equal(options.redirect, 'manual')
    assert.equal(options.cache, 'no-store')
    return { status, url: finalUrl, redirected }
  }, url)
  assert.equal(await probe(404), 'missing')
  assert.equal(await probe(410), 'missing')
  for (const status of [200, 302, 401, 403, 429, 500]) assert.equal(await probe(status), 'unknown')
  assert.equal(await probe(404, 'https://www.zhihu.com/signin'), 'unknown')
  assert.equal(await probe(404, url, true), 'unknown')
  assert.equal(await publicationUrlStatus(async () => { throw new Error('超时') }, url), 'unknown')
})

test('allows only the observed HTTPS Weibo SSO callback paths', () => {
  for (const host of ['passport.weibo.cn', 'passport.sina.cn', 'passport.krcom.cn']) {
    assert.equal(isWeiboSsoCallback(new URL(`https://${host}/sso/crossdomain?action=logout`)), true)
  }
  for (const url of [
    'http://passport.weibo.cn/sso/crossdomain',
    'https://passport.weibo.cn/sso/other',
    'https://passport.weibo.cn.example.com/sso/crossdomain',
    'https://user@passport.weibo.cn/sso/crossdomain',
  ]) {
    assert.equal(isWeiboSsoCallback(new URL(url)), false)
  }
})

test('uploads local Weibo images once and records a replacement draft before saving', async () => {
  const source = 'https://mmbiz.qpic.cn/image'
  const uploads = []
  const drafts = []
  const saved = []
  const progress = []
  const adapter = new Weibo(async (address, init) => {
    assert.equal(init.credentials, 'include')
    const url = new URL(address)
    if (address === weiboEditor) {
      return new Response(String.raw`<script>var props = { config: JSON.parse('{"uid":"90","nick":"O\'Neil"}') };</script>`)
    }
    if (url.hostname === 'picupload.weibo.com') {
      uploads.push(await init.body.text())
      return Response.json({ data: { pics: { pic_1: { pid: 'aBc123' } } } })
    }
    assert.equal(url.searchParams.get('uid'), '90')
    assert.equal(init.headers['SN-REQID'], url.searchParams.get('_rid'))
    if (url.pathname.endsWith('/create')) return new Response('{"code":100000,"data":{"id":9876543210123456789}}')
    assert.ok(url.pathname.endsWith('/save'))
    const id = url.searchParams.get('id')
    if (id === '15') return new Response(null, { status: 404 })
    assert.deepEqual(drafts, [undefined, id])
    assert.equal(init.body.get('id'), id)
    saved.push(init.body)
    return Response.json({ code: '100000' })
  })
  assert.deepEqual(await adapter.account(), { id: '90', name: "O'Neil" })
  const article = { title: '图文', images: [source, source], html: '<p>图文</p><img data-relay-image="0"><img data-relay-image="1">' }
  const content = await adapter.prepareContent('90', article, async (url) => {
    assert.equal(url, source)
    return new Blob(['local original'], { type: 'image/jpeg' })
  }, (...args) => progress.push(args))
  assert.deepEqual(uploads, ['local original'])
  assert.deepEqual(progress, [[1, 1]])
  assert.equal(await adapter.saveDraft('90', article.title, content, '15', async (id) => drafts.push(id)), '9876543210123456789')
  assert.equal(saved[0].get('cover'), 'https://wx3.sinaimg.cn/large/aBc123.jpg')
  assert.equal(saved[0].get('content').match(/data-pid="aBc123"/g).length, 2)
  assert.equal(saved[0].get('status'), '0')

  const loggedOut = new Weibo(async () => new Response('<meta http-equiv="refresh" content="0; url=https://weibo.com/">'))
  assert.equal(await loggedOut.account(), null)
})

test('uses the exact Weibo draft ID and published status from the account history', async () => {
  const adapter = new Weibo(async (address, init) => {
    const url = new URL(address)
    assert.equal(url.origin, 'https://card.weibo.com')
    assert.equal(url.pathname, '/article/v5/aj/editor/draft/historylist')
    assert.equal(url.searchParams.get('uid'), '90')
    assert.equal(url.searchParams.get('allow_pay'), '1')
    assert.equal(init.credentials, 'include')
    assert.equal(init.method, undefined)
    assert.equal(init.headers['SN-REQID'], url.searchParams.get('_rid'))
    return Response.json({ code: 100000, data: { list: [
      { id: '4172993', title: '同名文章', updated: '2026-11-25 13:08:17', status: 1, error_code: 0 },
      { id: '4172994', title: '同名文章', status: 0, error_code: 0 },
      { id: '4172995', status: 1, error_code: 1 },
      { id: '4172996', status: 2, error_code: 0 },
    ] } })
  })
  assert.deepEqual(await adapter.publishedDrafts('90'), new Map([
    ['4172993', { title: '同名文章', updatedAt: Date.parse('2026-11-25T13:08:17+08:00') }],
  ]))
  assert.equal(weiboHistoryUrl('4172993'), `${weiboEditor}#/history/4172993`)
})

test('resolves published Weibo links without confusing same-title posts from different times or accounts', async () => {
  const title = '这种"自由"为什么还没被广泛接受？'
  const first = '2309405369125521719456'
  const second = '2309405369127853752547'
  const articleUrl = (id) => `https://weibo.com/ttarticle/p/show?id=${id}`
  const post = (id, time, owner = '90') => ({
    user: { idstr: owner },
    created_at: `Wed Nov 25 ${time} +0800 2026`,
    page_info: { object_type: 'article', page_id: id },
    url_struct: [{ url_title: title.replaceAll('"', '″'), page_id: id, long_url: articleUrl(id) }],
  })
  const adapter = new Weibo(async (address, init) => {
    const url = new URL(address)
    assert.equal(url.pathname, '/ajax/statuses/mymblog')
    assert.equal(url.searchParams.get('uid'), '90')
    assert.equal(init.credentials, 'include')
    if (url.searchParams.get('page') === '2') return new Response(null, { status: 503 })
    return Response.json({ ok: 1, data: { since_id: 'more', list: [
      post(first, '12:59:00'), post(second, '13:08:16'),
      post('2309405369127853752548', '13:08:16', '91'),
      { ...post('2309405369127853752549', '13:08:16'), retweeted_status: {} },
    ] } })
  })
  const drafts = new Map([
    ['15', { title, updatedAt: Date.parse('2026-11-25T12:59:01+08:00') }],
    ['16', { title, updatedAt: Date.parse('2026-11-25T13:08:17+08:00') }],
  ])
  const articles = await adapter.publishedArticles('90')
  assert.equal(articles.length, 2)
  assert.equal(findWeiboPublishedUrl('15', drafts, articles), articleUrl(first))
  assert.equal(findWeiboPublishedUrl('16', drafts, articles), articleUrl(second))
  drafts.set('17', { ...drafts.get('16') })
  assert.equal(findWeiboPublishedUrl('16', drafts, articles), undefined)
})

test('submits a Weibo draft only within its publish settings and confirms the public article separately', async (t) => {
  const draftId = '123'
  const articleUrl = 'https://weibo.com/ttarticle/p/show?id=2309404803154729631808'
  const title = '带"引号"的图文标题'
  const owner = '90'

  function editor({ articleAuthor = owner, settings = true, navigate = true, interrupted = false, history = false } = {}) {
    let url
    let settingsOpen = false
    let historyOpen = false
    const clicks = []
    const visible = { getClientRects: () => [1], closest: () => null, matches: () => false }
    const body = {}
    const button = (label, click) => ({
      ...visible, textContent: label, click: () => { clicks.push(label); click() },
    })
    const next = button('下一步', () => { settingsOpen = settings })
    const checkbox = {
      ...visible, checked: true, matches: (selector) => selector === 'input[type="checkbox"]',
      click() { this.checked = !this.checked },
    }
    const publish = button('发布', () => {
      assert.equal(checkbox.checked, false)
      if (navigate) url = articleUrl
      if (history) {
        settingsOpen = false
        historyOpen = true
        url = weiboHistoryUrl(draftId)
      }
    })
    const composer = { ...visible, value: `发布了头条文章：《${title}》` }
    const panel = {
      ...visible, parentElement: body, textContent: '关注@头条文章 第一时间获取官方通知',
      contains: (node) => [composer, publish].includes(node),
      querySelectorAll: () => [{ ...visible, textContent: '关注@头条文章', control: checkbox }],
    }
    publish.parentElement = panel
    const unrelated = button('发布', () => assert.fail('clicked an unrelated publish action'))
    const author = { pathname: `/u/${articleAuthor}` }
    return {
      clicks,
      loadURL: async (address) => { url = address },
      stop: () => {},
      executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
        const result = runInNewContext(scripts[0].code, {
          URL,
          location: new URL(url),
          getComputedStyle: () => ({ visibility: 'visible' }),
          document: {
            body,
            querySelector: (selector) => selector === '[node-type="articleTitle"]'
              ? url === articleUrl ? { textContent: title.replaceAll('"', '″'), parentElement: { querySelector: () => author } } : null
              : historyOpen ? null : { ...visible, value: title },
            querySelectorAll: (selector) => {
              if (selector.startsWith('button,')) return historyOpen ? [] : settingsOpen ? [next, publish, unrelated] : [next, unrelated]
              if (selector.startsWith('textarea,')) return settingsOpen ? [composer] : []
              return []
            },
          },
        })
        if (interrupted && result.clicked && clicks.at(-1) === '发布') throw new Error('Navigation interrupted the script')
        return result
      },
    }
  }

  assert.equal(weiboDraftUrl(draftId), `${weiboEditor}#/draft/${draftId}`)
  assert.equal(weiboArticleUrl('https://card.weibo.com/article/m/show/id/2309404803154729631808?_wb_client_=1'), articleUrl)
  assert.equal(weiboArticleUrl('https://weibo.example/ttarticle/p/show?id=2309404803154729631808'), undefined)

  await t.test('confirms navigation to a public article after the final click', async () => {
    const page = editor({ interrupted: true })
    const result = await publishWeiboDraft(page, draftId, title, owner, 600)
    assert.equal(result.state, 'published')
    assert.equal(result.url, articleUrl)
    assert.deepEqual(page.clicks, ['下一步', '发布'])
  })
  await t.test('leaves unrecognized settings to the user and never repeats the final click', async () => {
    const manual = editor({ settings: false })
    const result = await publishWeiboDraft(manual, draftId, title, owner, 300)
    assert.deepEqual(result, { state: 'manual', step: 'submit' })
    assert.deepEqual(manual.clicks, ['下一步'])
    const uncertain = editor({ navigate: false })
    assert.equal((await publishWeiboDraft(uncertain, draftId, title, owner, 300)).state, 'uncertain')
    assert.deepEqual(uncertain.clicks, ['下一步', '发布'])
  })
  await t.test('rejects public article links belonging to another author', async () => {
    assert.equal(await checkWeiboArticle(editor({ articleAuthor: '91' }), articleUrl, title, owner, 60), false)
    assert.equal(await checkWeiboArticle(editor(), articleUrl, title, owner, 600), true)
  })
  await t.test('hands an editor history preview off to the account history check', async () => {
    const page = editor({ navigate: false, history: true })
    assert.deepEqual(await publishWeiboDraft(page, draftId, title, owner, 600), { state: 'uncertain' })
    assert.deepEqual(page.clicks, ['下一步', '发布'])
  })
})

test('submits only recognized Zhihu publication controls and requires a matching article page', async (t) => {
  const id = '123'
  const publicUrl = 'https://zhuanlan.zhihu.com/p/123'
  function editor({ confirm = false, resultUrl, modalLabel, abortAfterClick = false, successToast = false, notice } = {}) {
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
              if (selector.startsWith('.Toast')) {
                const textContent = successToast ? '文章发布成功' : clicks.length >= (confirm ? 2 : 1) ? notice : undefined
                return textContent && clicks.length ? [{ ...visible, textContent }] : []
              }
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
  await t.test('recognizes the 24-hour rate limit and stops after the first submission', async () => {
    const page = editor({ notice: '近期发布频率过高，请 24 小时后重试~' })
    assert.equal(await publishZhihuDraft(page, id, 1000), 'rate-limited')
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
