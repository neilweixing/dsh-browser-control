// Smoke-test the in-page agent against a jsdom document.
// jsdom has no layout engine, so geometry is stubbed; everything else — roles,
// accessible names, locators, actions, reading, waiting — is the real code.
import { JSDOM } from 'jsdom'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('const AGENT = `')
const end = source.indexOf('/** Wrap one page-side expression')
if (start < 0 || end < 0) throw new Error('cannot locate the AGENT template')
const raw = source.slice(start + 'const AGENT = `'.length, source.lastIndexOf('`', end))
// The template interpolates the agent version once; splicing it back in keeps
// the extracted script identical to what the guest actually receives.
const version = source.match(/const AGENT_VERSION = '([^']+)'/)[1]
const agent = raw.replace('${JSON.stringify(AGENT_VERSION)}', JSON.stringify(version))

const results = []
function check(name, condition, detail) {
  results.push({ name, ok: condition === true, detail: condition === true ? '' : JSON.stringify(detail) })
}

async function main() {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Shop</title></head><body>
      <header><nav aria-label="Main"><a href="/home">Home</a><a href="/orders">Orders</a></nav></header>
      <main>
        <h2>Products</h2>
        <section aria-label="Filters">
          <label for="q">Search products</label>
          <input id="q" placeholder="Type to search" />
          <label>Max price <input id="price" type="number" value="10" /></label>
          <select id="color"><option value="red">Red</option><option value="green">Green</option></select>
          <input type="checkbox" id="stock" /><label for="stock">In stock only</label>
          <button data-testid="apply">Apply</button>
          <button>Reset</button>
        </section>
        <ul>
          <li><a href="/p/1">Laptop</a></li>
          <li><a href="/p/2">Phone</a></li>
        </ul>
        <button aria-expanded="false">More</button>
        <button disabled>Sold out</button>
        <div style="display:none"><button>Hidden action</button></div>
        <p>The phone is in stock.</p>
      </main>
    </body></html>`,
    { runScripts: 'dangerously' },
  )
  const { window } = dom
  const document = window.document

  // Stub geometry: every element renders as a 100x30 box at a fixed position.
  const rect = { left: 10, top: 10, width: 100, height: 30, right: 110, bottom: 40, x: 10, y: 10 }
  window.Element.prototype.getBoundingClientRect = () => ({ ...rect, toJSON: () => rect })
  window.Element.prototype.getClientRects = () => [{ ...rect, toJSON: () => rect }]
  window.Element.prototype.scrollIntoView = function () {}
  window.HTMLElement.prototype.scrollBy = function () { this.scrollTop += 10 }
  window.scrollBy = (_x, y) => { document.documentElement.scrollTop += y }
  window.document.elementFromPoint = () => null

  window.eval(agent)
  const agentHandle = window.__dshbc
  check('agent installs', agentHandle !== undefined, null)
  check('install is idempotent', window.eval(agent) === true && window.__dshbc.refs.size >= 0, null)

  // ---- snapshot -------------------------------------------------------
  const snapshot = agentHandle.snapshot({ maxNodes: 300, maxChars: 8000 })
  check('snapshot ok', snapshot.ok === true, snapshot)
  const text = snapshot.text
  for (const probe of [
    'navigation "Main"',
    'link "Home"',
    'heading "Products"',
    'textbox "Search products"',
    'combobox',
    'checkbox',
    'button "Apply"',
    'button "Reset"',
    'button "More"',
    'link "Laptop"',
    'paragraph',
  ]) {
    check(`snapshot shows ${probe}`, text.includes(probe), text.slice(0, 1500))
  }
  check('snapshot hides display:none button', !text.includes('Hidden action'), text)
  check('snapshot marks disabled', /"Sold out" \[disabled\]/.test(text), text)
  check('snapshot marks unchecked', /"In stock only" \[unchecked\]/.test(text), text)
  check('snapshot marks collapsed', /"More" \[collapsed\]/.test(text), text)
  check('snapshot carries refs', /\[ref=e[\da-f-]+\]/.test(text), text)
  check('snapshot lists select options', /options=\*"red"\|"green"/.test(text), text)

  // ---- locators -------------------------------------------------------
  const byRole = agentHandle.locate({ role: 'button', name: 'Apply' })
  check('role+name matches once', byRole.ok === true && byRole.count === 1, byRole)

  const byRoleSubstring = agentHandle.locate({ role: 'button', name: 'app' })
  check('role+name is substring by default', byRoleSubstring.ok === true && byRoleSubstring.count === 1, byRoleSubstring)

  const byRoleExactMiss = agentHandle.locate({ role: 'button', name: 'app', exact: true })
  check('exact rejects a substring', byRoleExactMiss.ok === true && byRoleExactMiss.count === 0, byRoleExactMiss)

  const byText = agentHandle.locate({ text: 'Phone' })
  check('text locator finds the smallest match', byText.ok === true && byText.count >= 1, byText)

  const byTestId = agentHandle.locate({ testid: 'apply' })
  check('testid matches', byTestId.ok === true && byTestId.count === 1, byTestId)

  const byLabel = agentHandle.locate({ label: 'Search products' })
  check('label resolves its control', byLabel.ok === true && byLabel.count === 1 && byLabel.matches[0].role === 'textbox', byLabel)

  const byPlaceholder = agentHandle.locate({ placeholder: 'search' })
  check('placeholder matches', byPlaceholder.ok === true && byPlaceholder.count === 1, byPlaceholder)

  const byCss = agentHandle.locate({ css: '#color' })
  check('css matches', byCss.ok === true && byCss.count === 1, byCss)

  const ambiguous = agentHandle.locate({ role: 'button' })
  check('ambiguous role reports every match', ambiguous.ok === true && ambiguous.count >= 4, ambiguous)

  const noMatch = agentHandle.locate({ role: 'button', name: 'Nope' })
  check('no match reports zero', noMatch.ok === true && noMatch.count === 0, noMatch)

  // ---- actions --------------------------------------------------------
  const fillAct = agentHandle.act({ kind: 'fill', target: { label: 'Search products' }, value: 'widget' })
  check('fill returns success', fillAct.ok === true, fillAct)
  check('fill set the value', document.getElementById('q').value === 'widget', document.getElementById('q').value)

  let inputEvents = 0
  document.getElementById('q').addEventListener('input', () => { inputEvents += 1 })
  agentHandle.act({ kind: 'fill', target: { css: '#q' }, value: 'second' })
  check('fill dispatches an input event', inputEvents === 1, inputEvents)

  const ambiguousAct = agentHandle.act({ kind: 'click', target: { role: 'button' } })
  check('act refuses an ambiguous target', ambiguousAct.ok === false && ambiguousAct.reason === 'ambiguous', ambiguousAct)

  const clickAct = agentHandle.act({ kind: 'click', target: { testid: 'apply' } })
  check('click returns a pointer target', clickAct.ok === true && clickAct.pointer !== undefined && clickAct.pointer.clickCount === 1, clickAct)
  check('click pointer is inside the box centre', clickAct.pointer.x === 60 && clickAct.pointer.y === 25, clickAct.pointer)

  const checkAct = agentHandle.act({ kind: 'check', target: { css: '#stock' } })
  check('check asks for a click', checkAct.ok === true && checkAct.pointer !== undefined && checkAct.verifyCheck.want === true, checkAct)

  document.getElementById('stock').checked = true
  const alreadyChecked = agentHandle.act({ kind: 'check', target: { css: '#stock' } })
  check('check is a no-op when already checked', alreadyChecked.ok === true && alreadyChecked.pointer === undefined, alreadyChecked)

  const state = agentHandle.checkedState({ css: '#stock' })
  check('checkedState reads the control', state.ok === true && state.checked === true, state)

  const selectAct = agentHandle.act({ kind: 'select', target: { css: '#color' }, value: 'green' })
  check('select sets the option', selectAct.ok === true && document.getElementById('color').value === 'green', selectAct)

  const badOption = agentHandle.act({ kind: 'select', target: { css: '#color' }, value: 'blue' })
  check('select rejects a missing option', badOption.ok === false && badOption.reason === 'no-option', badOption)

  const hoverAct = agentHandle.act({ kind: 'hover', target: { role: 'link', name: 'Home' } })
  check('hover only moves', hoverAct.ok === true && hoverAct.pointer.moveOnly === true, hoverAct)

  const pressAct = agentHandle.act({ kind: 'press', target: { css: '#q' }, key: 'Enter' })
  check('press reports the chord', pressAct.ok === true && pressAct.press.key === 'Enter', pressAct)

  const typeAct = agentHandle.act({ kind: 'type', target: { css: '#q' }, value: 'abc' })
  check('type reports the text', typeAct.ok === true && typeAct.type.text === 'abc', typeAct)

  const docScroll = agentHandle.act({ kind: 'scroll', delta: 300 })
  check('bare scroll moves the document', docScroll.ok === true, docScroll)

  const notSelect = agentHandle.act({ kind: 'select', target: { role: 'button', name: 'Apply' }, value: 'x' })
  check('select on a button fails', notSelect.ok === false && notSelect.reason === 'not-select', notSelect)

  // ---- refs -----------------------------------------------------------
  const stamped = agentHandle.locate({ testid: 'apply' })
  const ref = stamped.matches[0].ref
  const byRef = agentHandle.locate({ ref })
  check('a snapshot ref resolves', byRef.ok === true && byRef.count === 1, byRef)

  document.querySelector('[data-testid="apply"]').remove()
  const deadRef = agentHandle.locate({ ref })
  check('a removed element ref is rejected', deadRef.ok === false && ['detached', 'stale-ref'].includes(deadRef.reason), deadRef)

  const staleRef = agentHandle.locate({ ref: 'e99999' })
  check('an unknown ref is reported as stale', staleRef.ok === false && staleRef.reason === 'stale-ref', staleRef)

  const beforeMutation = agentHandle.locate({ css: '#q' }).matches[0].ref
  document.getElementById('q').setAttribute('aria-label', 'Changed field')
  check('a DOM change invalidates old refs synchronously', agentHandle.locate({ ref: beforeMutation }).reason === 'stale-ref', null)
  const freshRef = agentHandle.locate({ css: '#q' }).matches[0].ref
  check('new observations do not reuse invalidated refs', freshRef !== beforeMutation, freshRef)
  await Promise.resolve()
  check('fresh ref survives delivery of drained mutation records', agentHandle.locate({ ref: freshRef }).ok === true, freshRef)

  const otherPage = new JSDOM('<button>Delete everything</button>', { runScripts: 'dangerously' })
  otherPage.window.Element.prototype.getBoundingClientRect = () => rect
  otherPage.window.Element.prototype.getClientRects = () => [rect]
  otherPage.window.eval(agent)
  otherPage.window.__dshbc.refSeq = agentHandle.refSeq - 1
  otherPage.window.__dshbc.snapshot({})
  check('another document rejects old refs', otherPage.window.__dshbc.locate({ ref: freshRef }).reason === 'stale-ref', freshRef)
  otherPage.window.close()

  for (let i = 0; i < 6000; i++) agentHandle.refs.set('budget-' + i, document.body)
  const afterBudget = agentHandle.locate({ css: 'body' }).matches[0].ref
  check('ref budget eviction rejects old handles', agentHandle.locate({ ref: freshRef }).reason === 'stale-ref', null)
  check('ref budget eviction never resets sequence', afterBudget !== freshRef, afterBudget)
  // ---- reading --------------------------------------------------------
  const readPage = agentHandle.read(null, 4000)
  check('read returns page text', readPage.ok === true && readPage.text.includes('Products'), readPage.text)
  const readOne = agentHandle.read({ role: 'heading' }, 200)
  check('read returns one element', readOne.ok === true && readOne.text === 'Products', readOne)

  // ---- waiting --------------------------------------------------------
  const waitNow = await agentHandle.wait({ target: { role: 'link', name: 'Home' }, state: 'visible', timeoutMs: 500 })
  check('wait resolves immediately for a visible target', waitNow.found === true, waitNow)

  const waitMissing = await agentHandle.wait({ target: { role: 'button', name: 'Ghost' }, state: 'visible', timeoutMs: 300 })
  check('wait times out for a missing target', waitMissing.found === false, waitMissing)

  const waitText = await agentHandle.wait({ text: 'in stock', timeoutMs: 300 })
  check('wait finds visible text', waitText.found === true, waitText)

  const waitReady = await agentHandle.wait({ loadState: 'domcontentloaded', timeoutMs: 300 })
  check('wait resolves a load state', waitReady.found === true, waitReady)

  // ---- console capture ------------------------------------------------
  window.console.error('boom', { code: 7 })
  window.dispatchEvent(new window.ErrorEvent('error', { message: 'kaboom', filename: 'a.js', lineno: 3 }))
  window.alert('are you sure')
  const logs = agentHandle.logs
  check('console.error is captured', logs.some((e) => e.level === 'error' && e.text.includes('boom')), logs)
  check('json args are captured', logs.some((e) => e.text.includes('"code":7')), logs)
  check('window errors are captured', logs.some((e) => e.text.includes('kaboom')), logs)
  check('dialogs are recorded', agentHandle.dialogs.length === 1 && agentHandle.dialogs[0].message === 'are you sure', agentHandle.dialogs)

  // ---- scope ----------------------------------------------------------
  // The Apply button was removed earlier by the detached-ref case, so scope is
  // checked against a control that is still there.
  const scoped = agentHandle.snapshot({ scope: 'section[aria-label="Filters"]', maxNodes: 100, maxChars: 4000 })
  check('scope narrows the tree', scoped.ok === true && scoped.text.includes('"Reset"') && !scoped.text.includes('"Laptop"'), scoped.text)
  const badScope = agentHandle.snapshot({ scope: '#nope' })
  check('a missing scope is reported', badScope.ok === false && badScope.reason === 'scope-not-found', badScope)

  const failed = results.filter((entry) => entry.ok === false)
  for (const entry of results) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.ok ? '' : `\n        ${entry.detail}`}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('harness error:', error)
  process.exitCode = 1
})
