import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { apply } from '../index.js'

function host(t) {
  const tools = new Map()
  const effects = []
  let rpc
  let imageName
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    effect(effect) { effects.push(effect()) },
    get() {
      return { saveImage: async ({ name }) => {
        imageName = name
        return { attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
      } }
    },
    inject([dependency], mount) {
      if (dependency === 'connection') mount({
        get() {},
        extend() { return { connection: { rpc: { handle(_channel, handler) { rpc = handler } } } } },
      })
      if (dependency === 'attachments') mount(ctx)
    },
  }
  apply(ctx)
  const lifetime = new AbortController()
  t.after(() => { lifetime.abort(); effects.forEach((dispose) => dispose()) })
  const poll = (clientId = 'client') => rpc('poll', { clientId, sessions: ['session'] }, lifetime.signal)
  const invoke = (name, args, signal = lifetime.signal) => tools.get(name).execute(args, { agent: { id: 'session' }, signal })
  return { rpc, poll, invoke, lifetime, imageName: () => imageName }
}

test('cancelled commands are removed from the Host queue', async (t) => {
  const h = host(t)
  const initial = h.poll()
  const call = h.invoke('browser_tabs', {})
  const { value: { command } } = await initial
  await h.rpc('start', { clientId: 'client', callId: command.callId })
  await h.rpc('result', { clientId: 'client', callId: command.callId, ok: true, value: {} })
  await call
  const controller = new AbortController()
  const cancelled = h.invoke('browser_act', { kind: 'click', target: { ref: 'old' } }, controller.signal)
  const rejected = assert.rejects(cancelled, /已取消/)
  controller.abort()
  await rejected
  const next = h.poll()
  const fresh = h.invoke('browser_tabs', {})
  const reply = await next
  assert.equal(reply.value.command.op, 'tabs')
  h.lifetime.abort()
  await assert.rejects(fresh, /已取消/)
})

test('a command already delivered to a worker cannot start after cancellation', async (t) => {
  const h = host(t)
  const poll = h.poll()
  const controller = new AbortController()
  const result = h.invoke('browser_act', { kind: 'click', target: { ref: 'old' } }, controller.signal)
  const { value: { command } } = await poll
  const rejected = assert.rejects(result, /已取消/)
  controller.abort()
  await rejected
  const reply = await h.rpc('start', { clientId: 'client', callId: command.callId })
  assert.equal(reply.value.accepted, false)
})

test('Host timeout removes queued commands before a later poll', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = host(t)
  const initial = h.poll()
  const first = h.invoke('browser_tabs', {})
  const { value: { command } } = await initial
  await h.rpc('start', { clientId: 'client', callId: command.callId })
  await h.rpc('result', { clientId: 'client', callId: command.callId, ok: true, value: {} })
  await first
  const expired = h.invoke('browser_act', { kind: 'click', target: { ref: 'old' } })
  const rejected = assert.rejects(expired, /超时/)
  t.mock.timers.tick(40000)
  await rejected
  const next = h.poll()
  const fresh = h.invoke('browser_tabs', {})
  const cancelled = assert.rejects(fresh, /已取消/)
  assert.equal((await next).value.command.op, 'tabs')
  h.lifetime.abort()
  await cancelled
})

test('start rejects expired commands and commands owned by another client', async (t) => {
  const h = host(t)
  const poll = h.poll()
  const result = h.invoke('browser_tabs', {})
  const rejected = assert.rejects(result, /已取消/)
  const { value: { command } } = await poll
  assert.equal((await h.rpc('start', { clientId: 'other', callId: command.callId })).value.accepted, false)
  const now = Date.now
  try {
    Date.now = () => command.expiresAt
    assert.equal((await h.rpc('start', { clientId: 'client', callId: command.callId })).value.accepted, false)
  } finally { Date.now = now }
  h.lifetime.abort()
  await rejected
})

test('Host and Client agree on press, screenshot identity, and a single wheel scroll', async (t) => {
  const h = host(t)
  const shell = new JSDOM('<div data-sidebar-right-tab="tab-real"><webview data-sidebar-browser-frame="webview"></webview></div>', { runScripts: 'dangerously', url: 'https://harness.example' })
  const page = new JSDOM('<input id="q"><div id="scroll"></div>', { runScripts: 'dangerously', url: 'https://example.com' })
  t.after(() => { shell.window.close(); page.window.close() })
  const w = page.window
  w.Element.prototype.getClientRects = () => [{}]
  w.Element.prototype.getBoundingClientRect = () => ({ left: 10, top: 10, width: 100, height: 30 })
  w.Element.prototype.scrollIntoView = () => {}
  w.document.elementFromPoint = () => null
  let domScrolls = 0
  w.Element.prototype.scrollBy = () => { domScrolls += 1 }
  const events = []
  const guest = shell.window.document.querySelector('webview')
  Object.assign(guest, {
    getURL: () => 'https://example.com', getTitle: () => 'Example', isLoading: () => false,
    executeJavaScript: async (code) => w.eval(code),
    sendInputEvent: (event) => events.push(event),
    capturePage: async () => ({ getSize: () => ({ width: 1, height: 1 }), toDataURL: () => 'data:image/png;base64,AQ==' }),
  })
  let client
  shell.window.CSS = { escape: (value) => value }
  shell.window.__ModuleLoader__ = { load({ factory }) { client = factory() } }
  shell.window.eval(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))
  client.apply({
    effect(effect) { t.after(effect()) },
    sidebarRight: {
      openTabs: { getSnapshot: () => [{ kind: 'browser', sessionId: 'session', tabId: 'tab-real' }] },
      mounted: { getSnapshot: () => 'session' }, isExpanded: () => true,
    },
    connection: { rpc: { call: (_channel, endpoint, payload, signal) => h.rpc(endpoint, payload, signal) } },
  })
  const press = await h.invoke('browser_act', { kind: 'press', target: { css: '#q' }, value: 'Enter' })
  assert.match(press.outcome, /sent Enter/)
  assert.deepEqual(events.map((event) => [event.type, event.keyCode]), [['keyDown', 'Enter'], ['keyUp', 'Enter']])
  const screenshot = await h.invoke('browser_screenshot', {})
  assert.equal(screenshot.tab_id, 'tab-real')
  assert.equal(h.imageName(), 'browser-tab-real.png')
  await h.invoke('browser_act', { kind: 'scroll', target: { css: '#scroll' }, delta: 300 })
  assert.equal(domScrolls, 0)
  assert.equal(events.filter((event) => event.type === 'mouseWheel').length, 1)
  assert.equal(events.at(-1).deltaY, 300)
})
