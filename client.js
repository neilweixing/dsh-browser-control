/**
 * dsh-browser-control — Client half.
 *
 * The only side that can reach the built-in Browser's live Electron
 * `<webview>` guests, so it executes every command the Host half forwards and
 * reports the outcome back.
 *
 * What makes this different from a DOM-clicking automation
 * -------------------------------------------------------
 * 1. Observation is an accessibility-tree snapshot, not "the first N links".
 *    The in-page agent computes implicit + explicit ARIA roles, accessible
 *    names, and states, and renders them as a compact indented tree: that tree
 *    is the *only* ground truth for building a locator.
 * 2. Every `ref` in that tree is bound to a live element, so a later action
 *    addresses an element that was actually observed rather than a guess.
 * 3. State-changing input is trusted: clicks and keys go through
 *    `sendInputEvent` at real viewport coordinates instead of `el.click()`.
 * 4. One command performs one action; re-observation is a separate call, so
 *    the model cannot chain blind clicks across a page it has not re-read.
 *
 * Tab location
 * ------------
 * The shipped `@deepseek-ai/dsh-client-ui-sidebar-browser` tab type registers
 * its bodies with public markers:
 *
 *   [data-sidebar-right-tab="<tabId>"]                 tab body / tab title
 *   webview[data-sidebar-browser-frame="webview"]      the guest itself
 *
 * and `ctx.sidebarRight.openTabs` publishes stable metadata for every open tab.
 * A tab is resolved by joining that metadata with the DOM, never by "the first
 * webview on the page": a Session may hold several Browser tabs, other
 * Sessions' tabs stay mounted because Browser tabs declare `keepMounted`, and a
 * saved layout can name a tab whose body is not mounted at all.
 *
 * Address policy
 * --------------
 * The desktop enforces its address rules on the guest's own navigation events.
 * An embedder-initiated navigation is not a user navigation, so this half
 * applies the same rules before asking: http(s) only, no embedded credentials,
 * and never the Harness Host itself.
 */

window.__ModuleLoader__.load({
  id: 'dsh-browser-control',
  factory() {
    /** Connection channel served by the Host half. */
    const CHANNEL = '/dsh-browser-control'

    /** Per-page identity so two windows never take each other's commands. */
    const CLIENT_ID = `browser-control-${Math.random().toString(36).slice(2)}-${String(Date.now())}`

    /** Upper bound on one command's own work inside the guest. */
    const GUEST_BUDGET_MS = 25000

    /** Version marker of the in-page agent; a bump reinstalls it after a hot update. */
    const AGENT_VERSION = 'dshbc/7'

    /** Sleep for a bounded delay. */
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // ---------------------------------------------------------------------
    // In-page agent
    // ---------------------------------------------------------------------

    /**
     * The page-side half of the toolkit.
     *
     * This is one self-installing script: every command prepends it, so the
     * agent survives across calls inside the same document and disappears with
     * the document on navigation — which is exactly the lifetime its `ref`
     * handles are allowed to have. It is written without template literals so
     * the outer template stays readable.
     */
    const AGENT = `
(function () {
  'use strict';
  var VERSION = ${JSON.stringify(AGENT_VERSION)};
  if (window.__dshbc && window.__dshbc.version === VERSION) return true;

  var M = {
    version: VERSION,
    refs: new Map(),
    refByElement: new WeakMap(),
    refSeq: 0,
    dialogs: [],
    logs: []
  };

  // ---- console + error capture -------------------------------------------
  var LOG_CAP = 300;
  function push(list, entry) {
    list.push(entry);
    if (list.length > LOG_CAP) list.splice(0, list.length - LOG_CAP);
  }
  function stringify(value) {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  ['error', 'warn', 'info', 'log', 'debug'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        push(M.logs, { level: level, text: Array.prototype.map.call(arguments, stringify).join(' '), at: Date.now() });
      } catch (e) { /* capture must never break the page */ }
      return original.apply(console, arguments);
    };
  });
  window.addEventListener('error', function (event) {
    push(M.logs, { level: 'error', text: (event.message || 'error') + ' @ ' + (event.filename || '?') + ':' + (event.lineno || 0), at: Date.now() });
  }, true);
  window.addEventListener('unhandledrejection', function (event) {
    push(M.logs, { level: 'error', text: 'unhandled rejection: ' + stringify(event.reason), at: Date.now() });
  });

  // Native dialogs are denied for guests, and a script that waits for an
  // answer would hang. Record the prompt and answer with the safe default so
  // the flow continues and the model can report what the page asked for.
  window.alert = function (message) { push(M.dialogs, { type: 'alert', message: String(message) }); };
  window.confirm = function (message) { push(M.dialogs, { type: 'confirm', message: String(message) }); return false; };
  window.prompt = function (message) { push(M.dialogs, { type: 'prompt', message: String(message) }); return null; };

  // ---- roles --------------------------------------------------------------
  function explicitRole(el) {
    var raw = el.getAttribute('role');
    if (raw === null) return null;
    var first = raw.trim().split(/\\s+/)[0];
    return first === '' ? null : first;
  }

  function implicitRole(el) {
    var explicit = explicitRole(el);
    if (explicit !== null) return explicit;
    var tag = el.tagName.toLowerCase();
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'area': return el.hasAttribute('href') ? 'link' : 'generic';
      case 'button': return 'button';
      case 'summary': return 'button';
      case 'select': return el.multiple === true || el.size > 1 ? 'listbox' : 'combobox';
      case 'textarea': return 'textbox';
      case 'option': return 'option';
      case 'optgroup': return 'group';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      case 'img': return 'img';
      case 'ul': case 'ol': case 'menu': return 'list';
      case 'li': return 'listitem';
      case 'dl': return 'list';
      case 'dt': return 'term';
      case 'dd': return 'definition';
      case 'table': return 'table';
      case 'thead': case 'tbody': case 'tfoot': return 'rowgroup';
      case 'tr': return 'row';
      case 'td': return 'cell';
      case 'th': return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
      case 'caption': return 'caption';
      case 'nav': return 'navigation';
      case 'main': return 'main';
      case 'header': return 'banner';
      case 'footer': return 'contentinfo';
      case 'aside': return 'complementary';
      case 'section': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : 'generic';
      case 'form': return 'form';
      case 'article': return 'article';
      case 'dialog': return 'dialog';
      case 'fieldset': return 'group';
      case 'legend': return 'generic';
      case 'label': return 'generic';
      case 'progress': return 'progressbar';
      case 'meter': return 'meter';
      case 'output': return 'status';
      case 'hr': return 'separator';
      case 'iframe': return 'iframe';
      case 'p': return 'paragraph';
      case 'pre': case 'code': return 'code';
      case 'blockquote': return 'blockquote';
      case 'figure': return 'figure';
      case 'figcaption': return 'caption';
      case 'time': return 'time';
      case 'input': {
        var type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'hidden') return 'none';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
        if (type === 'search') return 'searchbox';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        if (type === 'color') return 'button';
        if (type === 'file') return 'button';
        return 'textbox';
      }
      case 'body': case 'html': return 'document';
      default: return 'generic';
    }
  }

  var TEXT_ROLES = {
    paragraph: 1, code: 1, blockquote: 1, caption: 1, term: 1, definition: 1,
    cell: 1, columnheader: 1, rowheader: 1, heading: 1, listitem: 1
  };
  var LANDMARK_ROLES = {
    navigation: 1, main: 1, banner: 1, contentinfo: 1, complementary: 1, region: 1,
    form: 1, article: 1, dialog: 1, alertdialog: 1, table: 1, list: 1, group: 1,
    rowgroup: 1, row: 1, figure: 1, status: 1, alert: 1, search: 1, tablist: 1,
    tabpanel: 1, menu: 1, menubar: 1, tree: 1, treegrid: 1, grid: 1, toolbar: 1
  };
  /** Roles that expose a checked state; a text input does not, even though the DOM says it has one. */
  var CHECKABLE_ROLES = { checkbox: 1, radio: 1, switch: 1, menuitemcheckbox: 1, menuitemradio: 1, treeitem: 1, option: 1 };
  var INTERACTIVE_ROLES = {
    link: 1, button: 1, textbox: 1, searchbox: 1, checkbox: 1, radio: 1, combobox: 1,
    listbox: 1, option: 1, slider: 1, spinbutton: 1, switch: 1, tab: 1, menuitem: 1,
    menuitemcheckbox: 1, menuitemradio: 1, treeitem: 1, gridcell: 1, scrollbar: 1,
    slider: 1, 'menuitem': 1
  };

  // ---- accessible names ---------------------------------------------------
  function normalize(text) {
    return String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
  }

  function clip(text, limit) {
    var value = normalize(text);
    return value.length > limit ? value.slice(0, limit) : value;
  }

  function ownText(el) {
    if (el === null || el === undefined) return '';
    var raw = el.innerText;
    if (typeof raw !== 'string' || raw === '') raw = el.textContent;
    return normalize(raw);
  }

  /** The document's visible text, with the same fallback as any other element. */
  function pageText() {
    return ownText(document.body);
  }

  function labelText(el) {
    var id = el.getAttribute('id');
    if (id !== null && id !== '') {
      var escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
      var found = document.querySelector('label[for="' + escaped + '"]');
      if (found !== null) {
        var text = ownText(found);
        if (text !== '') return text;
      }
    }
    var wrapping = el.closest('label');
    if (wrapping !== null && wrapping !== el) {
      var wrapped = ownText(wrapping);
      if (wrapped !== '') return wrapped;
    }
    return '';
  }

  function accName(el, depth) {
    var level = depth == null ? 0 : depth;
    if (level > 5) return '';
    var labelledby = el.getAttribute('aria-labelledby');
    if (labelledby !== null && labelledby !== '') {
      var parts = [];
      var ids = labelledby.trim().split(/\\s+/);
      for (var i = 0; i < ids.length; i++) {
        var target = document.getElementById(ids[i]);
        if (target === null) continue;
        var piece = ownText(target);
        if (piece !== '') parts.push(piece);
      }
      var joined = normalize(parts.join(' '));
      if (joined !== '') return clip(joined, 160);
    }
    var ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && normalize(ariaLabel) !== '') return clip(ariaLabel, 160);

    var tag = el.tagName.toLowerCase();
    if (tag === 'img' || tag === 'area') {
      var alt = el.getAttribute('alt');
      if (alt !== null && normalize(alt) !== '') return clip(alt, 160);
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      var fromLabel = labelText(el);
      if (fromLabel !== '') return clip(fromLabel, 160);
      if (tag === 'input') {
        var type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'reset') {
          var buttonValue = normalize(el.value);
          if (buttonValue !== '') return clip(buttonValue, 160);
        }
      }
      if (tag === 'select') {
        var selected = el.selectedOptions && el.selectedOptions[0];
        if (selected !== undefined && selected !== null) {
          var selectedText = normalize(selected.textContent);
          if (selectedText !== '') return clip(selectedText, 160);
        }
      }
      var placeholder = el.getAttribute('placeholder');
      if (placeholder !== null && normalize(placeholder) !== '') return clip(placeholder, 160);
      var name = el.getAttribute('name');
      if (name !== null && normalize(name) !== '') return clip(name, 160);
      return '';
    }

    if (INTERACTIVE_ROLES[implicitRole(el)] === 1 || TEXT_ROLES[implicitRole(el)] === 1 || tag === 'a') {
      var text = ownText(el);
      if (text !== '') return clip(text, 160);
    }
    var title = el.getAttribute('title');
    if (title !== null && normalize(title) !== '') return clip(title, 160);
    var fallback = ownText(el);
    return fallback === '' ? '' : clip(fallback, 160);
  }

  // ---- visibility ---------------------------------------------------------
  function visible(el) {
    if (!el.isConnected) return false;
    // The no-argument form checks display and visibility without depending on
    // which option names this Chromium build spells; opacity is checked below.
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
    // Walk the ancestors explicitly as well: a nested control keeps its own
    // computed display, so getClientRects() is the only native signal that its
    // container is hidden, and it reports nothing under a stub or a
    // not-yet-styled document.
    for (var ancestor = el; ancestor !== null && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
      if (ancestor.hasAttribute !== undefined) {
        if (ancestor.hasAttribute('hidden')) return false;
        if (ancestor.getAttribute('aria-hidden') === 'true') return false;
        if (ancestor.hasAttribute('inert')) return false;
      }
      var style = window.getComputedStyle(ancestor);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      if (ancestor !== el && parseFloat(style.opacity) === 0) return false;
    }
    if (el.getClientRects().length === 0) return false;
    if (parseFloat(window.getComputedStyle(el).opacity) === 0) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---- element description ------------------------------------------------
  function levelOf(el) {
    var match = /^h([1-6])$/.exec(el.tagName.toLowerCase());
    if (match !== null) return Number(match[1]);
    return null;
  }

  function testIdOf(el) {
    var attrs = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];
    for (var i = 0; i < attrs.length; i++) {
      var value = el.getAttribute(attrs[i]);
      if (value !== null && normalize(value) !== '') return normalize(value);
    }
    return '';
  }

  function describe(el) {
    var role = implicitRole(el);
    var node = {
      role: role,
      name: accName(el),
      tag: el.tagName.toLowerCase()
    };
    var testId = testIdOf(el);
    if (testId !== '') node.testid = testId;
    if (typeof el.value === 'string' && el.value !== '' && role !== 'button') node.value = clip(el.value, 80);
    var placeholder = el.getAttribute('placeholder');
    if (placeholder !== null && normalize(placeholder) !== '') node.placeholder = clip(placeholder, 80);
    // Only a control that has a checked state reports one: a text input exposes
    // a checked property in the DOM but no checked state to a screen reader.
    if (CHECKABLE_ROLES[role] === 1 && typeof el.checked === 'boolean') node.checked = el.checked === true;
    if (typeof el.disabled === 'boolean' && el.disabled) node.disabled = true;
    if (el.getAttribute('aria-disabled') === 'true') node.disabled = true;
    var expanded = el.getAttribute('aria-expanded');
    if (expanded !== null) node.expanded = expanded === 'true';
    var pressed = el.getAttribute('aria-pressed');
    if (pressed !== null) node.pressed = pressed === 'true';
    if (el.tagName === 'A' && typeof el.href === 'string' && el.href !== '') node.href = el.href;
    var level = levelOf(el);
    if (level !== null) node.level = level;
    if (el.tagName === 'SELECT') {
      node.options = Array.prototype.slice.call(el.options, 0, 40).map(function (option) {
        return { value: option.value, label: clip(option.text || '', 60), selected: option.selected === true };
      });
    }
    if (el.isContentEditable === true) node.editable = true;
    node.visible = visible(el);
    return node;
  }

  // ---- refs ---------------------------------------------------------------
  function refFor(el) {
    var existing = M.refByElement.get(el);
    if (existing !== undefined) {
      M.refs.set(existing, el);
      return existing;
    }
    var ref = 'e' + String(++M.refSeq);
    M.refByElement.set(el, ref);
    M.refs.set(ref, el);
    if (M.refs.size > 6000) {
      M.refs = new Map();
      M.refByElement = new WeakMap();
      M.refSeq = 0;
      M.refByElement.set(el, ref);
      M.refs.set(ref, el);
    }
    return ref;
  }

  function withRef(el) {
    var node = describe(el);
    node.ref = refFor(el);
    return node;
  }

  // ---- snapshot -----------------------------------------------------------
  var COLLECTABLE = [
    'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary',
    '[contenteditable=""]', '[contenteditable="true"]', '[role]', '[onclick]',
    '[aria-label]', '[aria-labelledby]', '[aria-expanded]', '[aria-pressed]',
    '[data-testid]', '[data-test-id]', '[data-test]', '[data-cy]',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img[alt]', 'table', 'th', 'td',
    'iframe', 'p', 'li', 'pre', 'blockquote', 'figcaption', 'caption', 'dt', 'dd'
  ].join(',');

  function collect(scope) {
    var root = scope === undefined || scope === null ? document.body : scope;
    if (root === null) return [];
    var nodes = root.querySelectorAll(COLLECTABLE);
    var out = [];
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
    return out;
  }

  function ancestryDepth(el, root) {
    var depth = 0;
    var current = el.parentElement;
    while (current !== null && current !== root) {
      depth += 1;
      current = current.parentElement;
    }
    return depth > 10 ? 10 : depth;
  }

  function stateSuffix(node) {
    var parts = [];
    if (node.checked === true) parts.push('checked');
    if (node.checked === false) parts.push('unchecked');
    if (node.expanded === true) parts.push('expanded');
    if (node.expanded === false) parts.push('collapsed');
    if (node.pressed === true) parts.push('pressed');
    if (node.disabled === true) parts.push('disabled');
    if (node.level !== undefined) parts.push('level=' + String(node.level));
    if (node.value !== undefined) parts.push('value=' + JSON.stringify(node.value));
    else if (node.placeholder !== undefined) parts.push('placeholder=' + JSON.stringify(node.placeholder));
    if (node.testid !== undefined) parts.push('testid=' + JSON.stringify(node.testid));
    if (node.href !== undefined) parts.push('href=' + node.href);
    if (node.options !== undefined) {
      var options = node.options.map(function (option) {
        return (option.selected ? '*' : '') + JSON.stringify(option.value);
      });
      parts.push('options=' + options.join('|'));
    }
    return parts.length === 0 ? '' : ' [' + parts.join('] [') + ']';
  }

  function renderLine(node, depth) {
    var indent = '';
    for (var i = 0; i < depth; i++) indent += '  ';
    var head = node.role;
    var name = node.name === '' ? '' : ' ' + JSON.stringify(node.name);
    return indent + '- ' + head + name + stateSuffix(node) + ' [ref=' + node.ref + ']';
  }

  function snapshot(options) {
    var settings = options || {};
    var maxNodes = settings.maxNodes > 0 ? settings.maxNodes : 300;
    var maxChars = settings.maxChars > 0 ? settings.maxChars : 6000;
    var root = null;
    if (typeof settings.scope === 'string' && settings.scope !== '') {
      try { root = document.querySelector(settings.scope); } catch (e) { root = null; }
      if (root === null) return { ok: false, reason: 'scope-not-found', scope: settings.scope };
    }
    var base = root === null ? document.body : root;
    if (base === null) return { ok: false, reason: 'no-body' };

    var elements = collect(root);
    var lines = [];
    var used = 0;
    var emitted = 0;
    var truncated = false;

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (emitted >= maxNodes) { truncated = true; break; }
      if (!visible(el)) continue;
      var role = implicitRole(el);
      if (role === 'none' || role === 'presentation' || role === 'generic') {
        // A generic container is only worth naming when it carries an explicit
        // name or a test id, which is exactly what a locator would use.
        var named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || testIdOf(el) !== '';
        if (!named) continue;
      }
      var node = describe(el);
      var interesting = INTERACTIVE_ROLES[role] === 1 || LANDMARK_ROLES[role] === 1 ||
        TEXT_ROLES[role] === 1 || role === 'img' || role === 'iframe' ||
        node.testid !== undefined || node.name !== '';
      if (!interesting) continue;
      if (TEXT_ROLES[role] === 1 && node.name === '') continue;

      node.ref = refFor(el);
      var line = renderLine(node, ancestryDepth(el, base));
      if (used + line.length + 1 > maxChars) { truncated = true; break; }
      used += line.length + 1;
      emitted += 1;
      lines.push(line);
    }

    // Scrollable regions: a page whose only long content sits inside an
    // overflow container cannot be scrolled through the document itself, so
    // those containers need refs of their own.
    var scrollables = [];
    var candidates = base.querySelectorAll('body *');
    for (var j = 0; j < candidates.length && scrollables.length < 12; j++) {
      var region = candidates[j];
      var overflowY = window.getComputedStyle(region).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue;
      if (region.scrollHeight - region.clientHeight < 8) continue;
      if (!visible(region)) continue;
      var regionNode = withRef(region);
      regionNode.tall = region.scrollHeight;
      regionNode.viewport = region.clientHeight;
      scrollables.push(regionNode);
    }

    var bodyText = pageText();
    return {
      ok: true,
      text: lines.join('\\n'),
      node_count: emitted,
      truncated: truncated,
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      text_length: bodyText.length,
      scrollables: scrollables
    };
  }

  // ---- locators -----------------------------------------------------------
  function normalizeTarget(target) {
    if (typeof target === 'string') return { text: target };
    if (target !== null && typeof target === 'object') return target;
    return null;
  }

  function byRole(target, includeHidden) {
    var wanted = target.role;
    var wantedName = target.name;
    var exact = target.exact === true;
    var nodes = document.querySelectorAll('*');
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (implicitRole(el) !== wanted) continue;
      if (!includeHidden && !visible(el)) continue;
      if (wantedName !== undefined && wantedName !== null && String(wantedName) !== '') {
        var name = accName(el);
        var needle = normalize(wantedName);
        var hit = exact ? name === needle : name.toLowerCase().indexOf(needle.toLowerCase()) >= 0;
        if (!hit) continue;
      }
      out.push(el);
    }
    return out;
  }

  function byText(target, includeHidden) {
    var needle = normalize(target.text);
    var exact = target.exact === true;
    var out = [];
    var seen = new Set();
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode()) !== null) {
      var raw = normalize(node.nodeValue);
      if (raw === '') continue;
      var hit = exact ? raw === needle : raw.toLowerCase().indexOf(needle.toLowerCase()) >= 0;
      if (!hit) continue;
      var el = node.parentElement;
      if (el === null || seen.has(el)) continue;
      seen.add(el);
      if (!includeHidden && !visible(el)) continue;
      out.push(el);
    }
    // Prefer the smallest enclosing element: an outer container matched by the
    // same text is never the thing the author meant.
    return out.filter(function (el) {
      return !out.some(function (other) {
        return other !== el && el.contains(other);
      });
    });
  }

  function bySelector(selector, includeHidden) {
    var found;
    try { found = document.querySelectorAll(selector); } catch (e) { return { error: 'bad-css' }; }
    var out = [];
    for (var i = 0; i < found.length; i++) {
      if (!includeHidden && !visible(found[i])) continue;
      out.push(found[i]);
    }
    return { list: out };
  }

  function resolve(rawTarget, includeHidden) {
    var target = normalizeTarget(rawTarget);
    if (target === null) return { ok: false, reason: 'no-target' };
    if (target.ref !== undefined) {
      var el = M.refs.get(String(target.ref));
      if (el === undefined) return { ok: false, reason: 'stale-ref', locator: 'ref=' + String(target.ref) };
      if (!el.isConnected) return { ok: false, reason: 'detached', locator: 'ref=' + String(target.ref) };
      return { ok: true, list: [el], locator: 'ref=' + String(target.ref) };
    }
    if (target.testid !== undefined) {
      var selector = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']
        .map(function (attr) { return '[' + attr + '="' + String(target.testid).replace(/"/g, '\\\\"') + '"]'; })
        .join(',');
      var byTestId = bySelector(selector, includeHidden);
      if (byTestId.error !== undefined) return { ok: false, reason: byTestId.error };
      return { ok: true, list: byTestId.list, locator: 'testid=' + String(target.testid) };
    }
    if (target.css !== undefined) {
      var byCss = bySelector(String(target.css), includeHidden);
      if (byCss.error !== undefined) return { ok: false, reason: byCss.error };
      return { ok: true, list: byCss.list, locator: 'css=' + String(target.css) };
    }
    if (target.role !== undefined) {
      return { ok: true, list: byRole(target, includeHidden), locator: 'role=' + String(target.role) + (target.name === undefined ? '' : '[name=' + JSON.stringify(target.name) + ']') };
    }
    if (target.label !== undefined) {
      var labelSelector = 'label';
      var labels = bySelector(labelSelector, includeHidden);
      if (labels.error !== undefined) return { ok: false, reason: labels.error };
      var wanted = normalize(target.label);
      var matched = [];
      labels.list.forEach(function (label) {
        if (ownText(label).toLowerCase().indexOf(wanted.toLowerCase()) < 0) return;
        var control = label.control;
        if (control !== undefined && control !== null) matched.push(control);
        else if (label.htmlFor !== '') {
          var byId = document.getElementById(label.htmlFor);
          if (byId !== null) matched.push(byId);
        }
      });
      return { ok: true, list: matched, locator: 'label=' + wanted };
    }
    if (target.placeholder !== undefined) {
      var wantedPlaceholder = normalize(target.placeholder);
      var placeholders = bySelector('[placeholder]', includeHidden);
      if (placeholders.error !== undefined) return { ok: false, reason: placeholders.error };
      return {
        ok: true,
        locator: 'placeholder=' + wantedPlaceholder,
        list: placeholders.list.filter(function (el) {
          return normalize(el.getAttribute('placeholder')).toLowerCase().indexOf(wantedPlaceholder.toLowerCase()) >= 0;
        })
      };
    }
    if (target.text !== undefined) {
      return { ok: true, list: byText(target, includeHidden), locator: 'text=' + JSON.stringify(String(target.text)) };
    }
    return { ok: false, reason: 'no-target' };
  }

  function pick(rawTarget, nth, includeHidden) {
    var resolved = resolve(rawTarget, includeHidden === true);
    if (!resolved.ok) return resolved;
    var list = resolved.list;
    var matches = list.slice(0, 8).map(function (el) { return withRef(el); });
    if (list.length === 0) {
      return { ok: false, reason: 'not-found', locator: resolved.locator, count: 0 };
    }
    if (list.length > 1 && (nth === undefined || nth === null)) {
      return { ok: false, reason: 'ambiguous', locator: resolved.locator, count: list.length, matches: matches };
    }
    var index = nth === undefined || nth === null ? 0 : nth;
    if (index < 0 || index >= list.length) {
      return { ok: false, reason: 'out-of-range', locator: resolved.locator, count: list.length, matches: matches };
    }
    var chosen = list[index];
    return {
      ok: true,
      locator: resolved.locator,
      count: list.length,
      index: index,
      node: withRef(chosen),
      matches: matches
    };
  }

  function locate(rawTarget, includeHidden) {
    var resolved = resolve(rawTarget, includeHidden === true);
    if (!resolved.ok) return resolved;
    return {
      ok: true,
      locator: resolved.locator,
      count: resolved.list.length,
      matches: resolved.list.slice(0, 12).map(function (el) { return withRef(el); })
    };
  }

  // ---- geometry -----------------------------------------------------------
  function documentScroller() {
    return document.scrollingElement != null ? document.scrollingElement : document.documentElement;
  }
  function centerOf(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {
      try { el.scrollIntoView(); } catch (ignored) { /* a detached node fails below */ }
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    var width = window.innerWidth || document.documentElement.clientWidth;
    var height = window.innerHeight || document.documentElement.clientHeight;
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    if (!isFinite(x) || !isFinite(y)) return null;
    x = Math.min(Math.max(x, 1), Math.max(width - 1, 1));
    y = Math.min(Math.max(y, 1), Math.max(height - 1, 1));
    var rounded = { x: Math.round(x), y: Math.round(y), width: Math.round(rect.width), height: Math.round(rect.height) };
    var top = document.elementFromPoint(rounded.x, rounded.y);
    rounded.covered = top !== null && top !== el && !el.contains(top) && !top.contains(el);
    if (rounded.covered && top !== null) rounded.covered_by = top.tagName.toLowerCase() + (top.id === '' ? '' : '#' + top.id);
    return rounded;
  }

  function setValue(el, value) {
    if (el.isContentEditable === true) {
      el.focus();
      el.textContent = value;
    } else {
      var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor !== undefined && typeof descriptor.set === 'function') descriptor.set.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return typeof el.value === 'string' ? el.value : normalize(el.textContent);
  }

  // ---- actions ------------------------------------------------------------
  function act(request) {
    var kind = request.kind;
    var target = normalizeTarget(request.target);

    // Actions that do not need an element.
    if (kind === 'scroll' && (target === null || (target.ref === undefined && target.role === undefined && target.css === undefined && target.text === undefined && target.testid === undefined))) {
      var delta = typeof request.delta === 'number' ? request.delta : 600;
      var scroller = documentScroller();
      var before = scroller.scrollTop;
      window.scrollBy(0, delta);
      scroller = documentScroller();
      return {
        ok: true,
        outcome: 'scrolled document by ' + String(delta) + 'px: scrollTop ' + String(Math.round(before)) + ' -> ' + String(Math.round(scroller.scrollTop)) + ' of ' + String(scroller.scrollHeight) + 'px',
        node: null
      };
    }
    if (kind === 'press' && target === null) {
      return { ok: true, outcome: 'sent ' + String(request.key) + ' to the focused element', node: null, press: { key: String(request.key) } };
    }

    var chosen = pick(request.target, request.nth, request.includeHidden === true);
    if (!chosen.ok) return chosen;
    var el = M.refs.get(chosen.node.ref);
    if (el === undefined) return { ok: false, reason: 'stale-ref' };

    if (kind === 'click' || kind === 'dblclick' || kind === 'hover') {
      var center = centerOf(el);
      if (center === null) return { ok: false, reason: 'not-rendered', node: chosen.node };
      return {
        ok: true,
        node: chosen.node,
        count: chosen.count,
        index: chosen.index,
        locator: chosen.locator,
        outcome: (kind === 'hover' ? 'hovered ' : kind === 'dblclick' ? 'double-clicked ' : 'clicked ') + chosen.node.role + (chosen.node.name === '' ? '' : ' ' + JSON.stringify(chosen.node.name)),
        pointer: {
          x: center.x,
          y: center.y,
          clickCount: kind === 'dblclick' ? 2 : 1,
          moveOnly: kind === 'hover',
          covered: center.covered === true,
          covered_by: center.covered_by
        }
      };
    }

    if (kind === 'fill') {
      if (!visible(el)) return { ok: false, reason: 'not-visible', node: chosen.node };
      el.focus();
      var filled = setValue(el, request.value === undefined ? '' : String(request.value));
      return {
        ok: true,
        node: chosen.node,
        count: chosen.count,
        index: chosen.index,
        locator: chosen.locator,
        outcome: 'filled ' + chosen.node.role + (chosen.node.name === '' ? '' : ' ' + JSON.stringify(chosen.node.name)) + ' with ' + JSON.stringify(clip(filled, 60))
      };
    }

    if (kind === 'type') {
      if (!visible(el)) return { ok: false, reason: 'not-visible', node: chosen.node };
      el.focus();
      var current = typeof el.value === 'string' ? el.value : normalize(el.textContent);
      if (request.clear === true) current = setValue(el, '');
      return {
        ok: true,
        node: chosen.node,
        count: chosen.count,
        index: chosen.index,
        locator: chosen.locator,
        outcome: 'typed ' + String(request.value).length + ' characters into ' + chosen.node.role,
        type: { text: String(request.value === undefined ? '' : request.value), delayMs: request.delayMs === undefined ? 0 : request.delayMs }
      };
    }

    if (kind === 'press') {
      el.focus();
      return {
        ok: true,
        node: chosen.node,
        count: chosen.count,
        index: chosen.index,
        locator: chosen.locator,
        outcome: 'sent ' + String(request.key) + ' to ' + chosen.node.role,
        press: { key: String(request.key) }
      };
    }

    if (kind === 'focus') {
      el.focus();
      return { ok: true, node: chosen.node, count: chosen.count, index: chosen.index, locator: chosen.locator, outcome: 'focused ' + chosen.node.role };
    }

    if (kind === 'select') {
      if (el.tagName !== 'SELECT') return { ok: false, reason: 'not-select', node: chosen.node };
      var wantedValue = request.value === undefined ? '' : String(request.value);
      var option = null;
      for (var i = 0; i < el.options.length; i++) {
        if (el.options[i].value === wantedValue) { option = el.options[i]; break; }
      }
      if (option === null) {
        for (var k = 0; k < el.options.length; k++) {
          if (normalize(el.options[k].text) === normalize(wantedValue)) { option = el.options[k]; break; }
        }
      }
      if (option === null) {
        return {
          ok: false,
          reason: 'no-option',
          node: chosen.node,
          options: Array.prototype.slice.call(el.options, 0, 40).map(function (entry) { return entry.value; })
        };
      }
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        ok: true,
        node: chosen.node,
        count: chosen.count,
        index: chosen.index,
        locator: chosen.locator,
        outcome: 'selected ' + JSON.stringify(option.value) + ' (' + clip(option.text, 40) + ')'
      };
    }

    if (kind === 'check' || kind === 'uncheck') {
      if (typeof el.checked !== 'boolean') return { ok: false, reason: 'not-checkable', node: chosen.node };
      var want = kind === 'check';
      if (el.checked === want) {
        return {
          ok: true,
          node: chosen.node,
          count: chosen.count,
          index: chosen.index,
          locator: chosen.locator,
          outcome: chosen.node.role + ' was already ' + (want ? 'checked' : 'unchecked')
        };
      }
      var checkCenter = centerOf(el);
      if (checkCenter === null) return { ok: false, reason: 'not-rendered', node: chosen.node };
      return {
        ok: true,
        node: chosen.node,
        count: chosen.count,
        index: chosen.index,
        locator: chosen.locator,
        outcome: 'clicking to ' + (want ? 'check' : 'uncheck') + ' ' + chosen.node.role,
        pointer: { x: checkCenter.x, y: checkCenter.y, clickCount: 1, moveOnly: false, covered: checkCenter.covered === true, covered_by: checkCenter.covered_by },
        verifyCheck: { want: want }
      };
    }

    if (kind === 'scroll') {
      var scrollDelta = typeof request.delta === 'number' ? request.delta : 600;
      var scrollCenter = centerOf(el);
      if (scrollCenter === null) return { ok: false, reason: 'not-rendered', node: chosen.node };
      el.scrollBy(0, scrollDelta);
      return {
        ok: true,
        node: chosen.node,
        count: chosen.count,
        index: chosen.index,
        locator: chosen.locator,
        outcome: 'scrolled ' + chosen.node.role + ' by ' + String(scrollDelta) + 'px: scrollTop ' + String(Math.round(el.scrollTop)) + ' of ' + String(el.scrollHeight) + 'px',
        wheel: { x: scrollCenter.x, y: scrollCenter.y, deltaX: 0, deltaY: scrollDelta }
      };
    }

    return { ok: false, reason: 'unknown-action', kind: String(kind) };
  }

  function checkedState(rawTarget, nth) {
    var chosen = pick(rawTarget, nth, true);
    if (!chosen.ok) return chosen;
    var el = M.refs.get(chosen.node.ref);
    if (el === undefined) return { ok: false, reason: 'stale-ref' };
    return { ok: true, checked: el.checked === true, node: chosen.node };
  }

  // ---- reading ------------------------------------------------------------
  function read(rawTarget, maxChars) {
    var limit = maxChars > 0 ? maxChars : 4000;
    var text = '';
    var node = null;
    if (rawTarget !== undefined && rawTarget !== null) {
      var chosen = pick(rawTarget, undefined, true);
      if (!chosen.ok) return chosen;
      var el = M.refs.get(chosen.node.ref);
      if (el === undefined) return { ok: false, reason: 'stale-ref' };
      node = chosen.node;
      text = ownText(el);
    } else {
      text = pageText();
    }
    return {
      ok: true,
      node: node,
      text: text.length > limit ? text.slice(0, limit) : text,
      truncated: text.length > limit,
      length: text.length
    };
  }

  // ---- waiting ------------------------------------------------------------
  async function wait(request) {
    var timeout = request.timeoutMs > 0 ? request.timeoutMs : 3000;
    var started = Date.now();
    var deadline = started + timeout;
    for (;;) {
      var done = false;
      if (request.loadState !== undefined) {
        done = request.loadState === 'load' ? document.readyState === 'complete' : document.readyState !== 'loading';
      } else if (request.text !== undefined) {
        done = pageText().indexOf(normalize(request.text)) >= 0;
      } else if (request.url !== undefined) {
        done = location.href.indexOf(String(request.url)) >= 0;
      } else if (request.target !== undefined) {
        var probe = resolve(request.target, true);
        var list = probe.ok ? probe.list : [];
        var live = list.filter(function (el) { return el.isConnected; });
        var shown = live.filter(function (el) { return visible(el); });
        var state = request.state === undefined ? 'visible' : request.state;
        if (state === 'visible') done = shown.length > 0;
        else if (state === 'hidden') done = shown.length === 0;
        else if (state === 'attached') done = live.length > 0;
        else if (state === 'detached') done = live.length === 0;
        else if (state === 'enabled') done = shown.some(function (el) { return el.disabled !== true; });
        else done = shown.length > 0;
      } else {
        done = true;
      }
      if (done) return { ok: true, found: true, elapsed_ms: Date.now() - started };
      if (Date.now() >= deadline) return { ok: true, found: false, elapsed_ms: Date.now() - started };
      await new Promise(function (resolve_) { setTimeout(resolve_, 100); });
    }
  }

  M.snapshot = snapshot;
  M.locate = locate;
  M.act = act;
  M.checkedState = checkedState;
  M.read = read;
  M.wait = wait;

  Object.defineProperty(window, '__dshbc', { value: M, writable: true, configurable: true, enumerable: false });
  return true;
})()
`

    /** Wrap one page-side expression so it runs after the agent is installed. */
    const withAgent = (body) => `${AGENT};\n${body}`

    // ---------------------------------------------------------------------
    // Guest plumbing
    // ---------------------------------------------------------------------

    /**
     * Apply the desktop's address rules to a caller-supplied URL.
     * @param raw - address as the model supplied it.
     * @returns the normalized absolute URL.
     */
    function assertAddress(raw) {
      let url
      try {
        url = new URL(raw)
      } catch {
        throw new Error(`地址无效：${JSON.stringify(raw)}`)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('内置浏览器只接受 http/https 地址')
      }
      if (url.username !== '' || url.password !== '') throw new Error('地址不能包含账号或密码')
      const host = hostOrigin()
      if (host !== undefined && url.port === host.port) {
        const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        if (url.hostname === host.hostname || loopback) throw new Error('不能把内置浏览器指向 Harness 自身地址')
      }
      return url.href
    }

    /** The Host origin this page talks to, when the shell exposes it. */
    function hostOrigin() {
      const base = globalThis.__DSH_TRANSPORT__?.streamBaseUrl
      if (typeof base !== 'string' || base === '') return undefined
      try {
        return new URL(base)
      } catch {
        return undefined
      }
    }

    /** Every Browser tab of one Session, in the order the sidebar publishes them. */
    function browserTabsOf(sidebarRight, sessionId) {
      return sidebarRight.openTabs.getSnapshot().filter((tab) => tab.sessionId === sessionId && tab.kind === 'browser')
    }

    /** The live guest inside one tab body, if that body is mounted. */
    function guestOf(tabId) {
      const bodies = document.querySelectorAll(`[data-sidebar-right-tab="${CSS.escape(tabId)}"]`)
      for (const body of bodies) {
        const guest = body.querySelector('webview[data-sidebar-browser-frame="webview"]')
        if (guest !== null && guest.isConnected) return guest
      }
      return undefined
    }

    /** Wait for a tab body to mount its guest. */
    async function waitGuest(tabId, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const guest = guestOf(tabId)
        if (guest !== undefined) return guest
        if (Date.now() > deadline) return undefined
        await sleep(100)
      }
    }

    /** Describe one tab; a destroyed or unready guest still answers with blanks. */
    function describeTab(tabId, guest) {
      let url = ''
      let title = ''
      let loading = false
      try {
        url = guest.getURL()
      } catch {
        /* a guest that is gone reports nothing */
      }
      try {
        title = guest.getTitle()
      } catch {
        /* a guest that is gone reports nothing */
      }
      try {
        loading = guest.isLoading()
      } catch {
        /* a guest that is gone reports nothing */
      }
      return { tab_id: tabId, url, title, loading }
    }

    /**
     * Resolve the tab a command names.
     * @param sidebarRight - the sidebar face from `ctx.sidebarRight`.
     * @param sessionId - Session that issued the call.
     * @param tabId - explicit tab, or `undefined` for the Session's only tab.
     * @returns the tab id and its live guest.
     */
    function resolveTarget(sidebarRight, sessionId, tabId) {
      const tabs = browserTabsOf(sidebarRight, sessionId)
      if (tabs.length === 0) {
        throw new Error('该会话还没有打开任何内置浏览器标签页；先用 browser_open 打开一个网页')
      }
      if (tabId !== undefined) {
        if (!tabs.some((tab) => tab.tabId === tabId)) {
          throw new Error(`标签页 ${tabId} 已不存在（可能已被关闭）；当前可用：${tabs.map((tab) => tab.tabId).join('、')}`)
        }
        const guest = guestOf(tabId)
        if (guest === undefined) throw new Error(`标签页 ${tabId} 的页面当前没有挂载，无法操作`)
        return { tabId, guest }
      }
      if (tabs.length > 1) {
        throw new Error(
          `该会话有 ${String(tabs.length)} 个内置浏览器标签页，请用 tab_id 指定其一：${tabs.map((tab) => tab.tabId).join('、')}`,
        )
      }
      const only = tabs[0]
      const guest = guestOf(only.tabId)
      if (guest === undefined) throw new Error(`标签页 ${only.tabId} 的页面当前没有挂载，无法操作`)
      return { tabId: only.tabId, guest }
    }

    /** Wait until a guest finishes its current load, or the budget runs out. */
    async function settle(guest, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        let loading = false
        try {
          loading = guest.isLoading()
        } catch {
          return
        }
        if (!loading) return
        if (Date.now() > deadline) return
        await sleep(120)
      }
    }

    /** Ask the guest to load a URL; the navigation itself is fire-and-forget, so never await it. */
    async function navigate(guest, url) {
      // `loadURL` resolves only after the document commits, and rejects with
      // ERR_ABORTED on redirects; awaiting it would hang the tool call on slow
      // or redirecting pages. Start it, then let `settle` observe loading state.
      try {
        guest.loadURL(url).catch(() => {})
      } catch {
        /* a destroyed guest fails when its state is read below */
      }
      await sleep(150)
    }

    /** Run one self-contained script inside the guest, bounded so a stuck guest cannot hang the tool call. */
    async function run(guest, body) {
      let timer
      const bounded = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`页面脚本在 ${String(GUEST_BUDGET_MS)}ms 内没有返回：页面可能正在跳转或已崩溃`))
        }, GUEST_BUDGET_MS)
      })
      try {
        return await Promise.race([guest.executeJavaScript(body, false), bounded])
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('Script failed to execute')) {
          throw new Error(
            `页面尚未就绪，无法执行脚本（可能仍在加载或该地址不允许脚本注入）：${message}`,
          )
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    /** JSON-encode one value for embedding in a page script. */
    const literal = (value) => JSON.stringify(value === undefined ? null : value)

    // ---------------------------------------------------------------------
    // Keyboard
    // ---------------------------------------------------------------------

    /** Chromium key names for the keys a caller is likely to name. */
    const KEY_NAMES = {
      enter: 'Enter',
      return: 'Enter',
      tab: 'Tab',
      escape: 'Escape',
      esc: 'Escape',
      backspace: 'Backspace',
      delete: 'Delete',
      del: 'Delete',
      space: ' ',
      arrowup: 'Up',
      arrowdown: 'Down',
      arrowleft: 'Left',
      arrowright: 'Right',
      up: 'Up',
      down: 'Down',
      left: 'Left',
      right: 'Right',
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
      insert: 'Insert',
      capslock: 'CapsLock',
    }

    /**
     * Split a key chord such as `Control+Shift+A` into modifiers and one key.
     * @param raw - chord as the model wrote it.
     * @returns the modifiers and the Chromium key name.
     */
    function parseKey(raw) {
      const parts = String(raw).split('+').filter((part) => part !== '')
      const modifiers = []
      let key = parts.length === 0 ? '' : parts[parts.length - 1]
      for (const part of parts.slice(0, -1)) {
        const lower = part.toLowerCase()
        if (lower === 'control' || lower === 'ctrl' || lower === 'cmdorctrl') modifiers.push('control')
        else if (lower === 'shift') modifiers.push('shift')
        else if (lower === 'alt' || lower === 'option') modifiers.push('alt')
        else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'super') modifiers.push('meta')
        else throw new Error(`无法识别的修饰键：${part}；支持 Control、Shift、Alt、Meta`)
      }
      const mapped = KEY_NAMES[key.toLowerCase()]
      if (mapped !== undefined) return { modifiers, key: mapped }
      if (key.length === 1) return { modifiers, key: key.toUpperCase() === key.toLowerCase() ? key : key.toUpperCase() }
      return { modifiers, key }
    }

    /** Send one chord to the guest's focused element. */
    function pressChromeKey(guest, raw) {
      const { modifiers, key } = parseKey(raw)
      const event = (type) => ({
        type,
        keyCode: key,
        ...(modifiers.length === 0 ? {} : { modifiers }),
      })
      guest.sendInputEvent(event('keyDown'))
      if (modifiers.length === 0 && [...key].length === 1 && key !== ' ') {
        guest.sendInputEvent({ type: 'char', keyCode: key })
      }
      guest.sendInputEvent(event('keyUp'))
    }

    /** Type text as trusted character events, one character at a time. */
    async function typeText(guest, text, delayMs) {
      for (const character of [...text]) {
        if (character === '\n') {
          guest.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
          guest.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        } else {
          guest.sendInputEvent({ type: 'char', keyCode: character })
        }
        if (delayMs > 0) await sleep(delayMs)
      }
    }

    /** Send one trusted pointer sequence at guest viewport coordinates. */
    async function pointerAt(guest, pointer) {
      const { x, y, clickCount, moveOnly } = pointer
      guest.sendInputEvent({ type: 'mouseMove', x, y })
      if (moveOnly === true) {
        await sleep(80)
        return
      }
      const count = clickCount === 2 ? 2 : 1
      for (let click = 1; click <= count; click += 1) {
        guest.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: click })
        guest.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: click })
      }
      await sleep(120)
    }

    /** Send one trusted wheel event, so the page scrolls under its own listeners. */
    async function wheelAt(guest, wheel) {
      guest.sendInputEvent({
        type: 'mouseWheel',
        x: wheel.x,
        y: wheel.y,
        deltaX: wheel.deltaX,
        deltaY: wheel.deltaY,
        canScroll: true,
      })
      await sleep(150)
    }

    // ---------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------

    /** List one Session's Browser tabs with their live identity. */
    function listTabs(sidebarRight, sessionId, mounted) {
      return {
        tabs: browserTabsOf(sidebarRight, sessionId).map((tab) => {
          const guest = guestOf(tab.tabId)
          const identity = guest === undefined ? { tab_id: tab.tabId, url: '', title: '', loading: false } : describeTab(tab.tabId, guest)
          return { ...identity, mounted: guest !== undefined, active: mounted === sessionId && guest !== undefined }
        }),
      }
    }

    /** Open a new Browser tab, or navigate an existing one. */
    async function openPage(sidebarRight, command) {
      const url = assertAddress(command.url)
      if (command.mode === 'same-site') {
        let wantedHost = ''
        try {
          wantedHost = new URL(url).hostname
        } catch {
          wantedHost = ''
        }
        if (wantedHost !== '') {
          const existing = browserTabsOf(sidebarRight, command.sessionId).find((tab) => {
            const guest = guestOf(tab.tabId)
            if (guest === undefined) return false
            try {
              return new URL(guest.getURL()).hostname === wantedHost
            } catch {
              return false
            }
          })
          if (existing !== undefined) {
            const { tabId, guest } = resolveTarget(sidebarRight, command.sessionId, existing.tabId)
            await navigate(guest, url)
            await settle(guest, GUEST_BUDGET_MS)
            return { ...describeTab(tabId, guest), reused: true }
          }
        }
      }
      if (command.tabId !== undefined) {
        const { tabId, guest } = resolveTarget(sidebarRight, command.sessionId, command.tabId)
        await navigate(guest, url)
        await settle(guest, GUEST_BUDGET_MS)
        return { ...describeTab(tabId, guest), reused: true }
      }
      const before = new Set(browserTabsOf(sidebarRight, command.sessionId).map((tab) => tab.tabId))
      try {
        sidebarRight.openTab('browser', { params: { url } })
      } catch (error) {
        throw new Error(
          `无法打开内置浏览器面板：${error instanceof Error ? error.message : String(error)}（请先让该会话显示在 Harness 主界面）`,
        )
      }
      const deadline = Date.now() + GUEST_BUDGET_MS
      let created
      while (Date.now() < deadline) {
        created = browserTabsOf(sidebarRight, command.sessionId).find((tab) => !before.has(tab.tabId))
        if (created !== undefined) break
        await sleep(100)
      }
      if (created === undefined) throw new Error('打开内置浏览器标签页超时')
      const guest = await waitGuest(created.tabId, GUEST_BUDGET_MS)
      if (guest === undefined) throw new Error('内置浏览器标签页已创建，但页面容器没有挂载')
      await settle(guest, GUEST_BUDGET_MS)
      return { ...describeTab(created.tabId, guest), reused: false }
    }

    /** Navigate within the guest's own history, or reload it. */
    async function navigateHistory(sidebarRight, command) {
      const { tabId, guest } = resolveTarget(sidebarRight, command.sessionId, command.tabId)
      const how = command.how
      if (how === 'back') guest.goBack()
      else if (how === 'forward') guest.goForward()
      else if (how === 'reload') guest.reload()
      else if (how === 'stop') guest.stop()
      else throw new Error(`未知的导航操作：${String(how)}`)
      await settle(guest, GUEST_BUDGET_MS)
      return describeTab(tabId, guest)
    }

    /** Perform one page action, then report what the page now looks like. */
    async function act(sidebarRight, command) {
      const { tabId, guest } = resolveTarget(sidebarRight, command.sessionId, command.tabId)
      const request = command.action === undefined ? {} : command.action
      const outcome = await run(
        guest,
        withAgent(`window.__dshbc.act(${literal(request)})`),
      )
      if (outcome === null || outcome === undefined) throw new Error('页面没有返回动作结果')
      if (outcome.ok !== true) throw actionError(outcome, request)

      if (outcome.pointer !== undefined) {
        if (outcome.pointer.covered === true) {
          // A covered element means the click would land on whatever is above
          // it. Reporting that is far more useful than a silent no-op.
          throw new Error(
            `${outcome.outcome} 失败：目标被 ${outcome.pointer.covered_by === undefined ? '另一元素' : outcome.pointer.covered_by} 遮挡。请先关闭弹层/滚动到可见位置，或改用更具体的定位。`,
          )
        }
        await pointerAt(guest, outcome.pointer)
      }
      if (outcome.wheel !== undefined) await wheelAt(guest, outcome.wheel)
      if (outcome.type !== undefined) await typeText(guest, outcome.type.text, outcome.type.delayMs)
      if (outcome.press !== undefined) pressChromeKey(guest, outcome.press.key)

      let verified
      if (outcome.verifyCheck !== undefined && outcome.node !== null) {
        await sleep(80)
        const state = await run(
          guest,
          withAgent(
            `window.__dshbc.checkedState(${literal(request.target)}, ${literal(request.nth === undefined ? null : request.nth)})`,
          ),
        )
        if (state?.ok === true) verified = { checked: state.checked === true, wanted: outcome.verifyCheck.want }
      }

      await settle(guest, 2000)
      return {
        ...describeTab(tabId, guest),
        action: request.kind,
        outcome: outcome.outcome,
        target: outcome.node,
        locator: outcome.locator,
        count: outcome.count,
        ...(verified === undefined ? {} : { verified }),
      }
    }

    /** Turn one failed page-side action into an error the model can act on. */
    function actionError(outcome, request) {
      const where = outcome.locator === undefined ? '' : `（定位：${outcome.locator}）`
      switch (outcome.reason) {
        case 'no-target':
          return new Error('必须给出 target：ref，或 role/css/text/testid/label/placeholder 之一')
        case 'stale-ref':
          return new Error(`ref 已失效：页面已经变化过，请重新调用 browser_snapshot 取得新的 ref${where}`)
        case 'detached':
          return new Error(`目标元素已从页面移除，请重新调用 browser_snapshot${where}`)
        case 'not-found':
          return new Error(`没有找到匹配的元素${where}；请重新快照后再定位`)
        case 'ambiguous':
          return new Error(
            `匹配到 ${String(outcome.count)} 个元素，无法确定目标${where}。请收紧定位条件（加 name、用 testid、或给出 css），而不是直接用 nth 猜位置。候选：${(outcome.matches ?? [])
              .map((node) => `${node.role} ${JSON.stringify(node.name)}${node.testid === undefined ? '' : ` testid=${node.testid}`}`)
              .join('；')}`,
          )
        case 'out-of-range':
          return new Error(`nth 超出范围：只匹配到 ${String(outcome.count)} 个元素${where}`)
        case 'not-visible':
          return new Error(`目标当前不可见，无法${request.kind === 'fill' ? '填写' : '操作'}${where}`)
        case 'not-rendered':
          return new Error(`目标没有渲染出可点击区域${where}`)
        case 'not-select':
          return new Error(`目标不是下拉框，无法 select${where}`)
        case 'no-option':
          return new Error(`下拉框没有该选项${where}；可选值：${(outcome.options ?? []).join('、')}`)
        case 'not-checkable':
          return new Error(`目标不是复选框或单选框${where}`)
        case 'bad-css':
          return new Error(`css 选择器无效${where}`)
        case 'unknown-action':
          return new Error(`未知的动作：${String(outcome.kind)}`)
        default:
          return new Error(`动作失败：${String(outcome.reason ?? 'unknown')}${where}`)
      }
    }

    /** Read a snapshot, a locator match list, page text, or the console. */
    async function inspect(sidebarRight, command) {
      const { tabId, guest } = resolveTarget(sidebarRight, command.sessionId, command.tabId)
      if (command.op === 'snapshot') {
        const value = await run(
          guest,
          withAgent(
            `window.__dshbc.snapshot(${literal({ maxNodes: command.maxNodes, maxChars: command.maxChars, scope: command.scope })})`,
          ),
        )
        if (value === null || value === undefined) throw new Error('页面没有返回快照')
        if (value.ok !== true) {
          throw new Error(
            value.reason === 'scope-not-found'
              ? `scope 选择器匹配不到元素：${String(value.scope)}`
              : '页面结构不可读（可能还没有可访问的文档）',
          )
        }
        // `ok` is the page-side envelope, not part of the tool result schema.
        return {
          ...describeTab(tabId, guest),
          text: value.text,
          node_count: value.node_count,
          truncated: value.truncated,
          text_length: value.text_length,
          viewport: value.viewport,
          scrollables: value.scrollables,
        }
      }
      if (command.op === 'locate') {
        const value = await run(
          guest,
          withAgent(`window.__dshbc.locate(${literal(command.target)}, ${String(command.includeHidden === true)})`),
        )
        if (value?.ok !== true) throw actionError({ ...value, reason: value?.reason ?? 'unknown' }, { kind: 'locate' })
        return { ...describeTab(tabId, guest), locator: value.locator, count: value.count, matches: value.matches }
      }
      if (command.op === 'read') {
        const value = await run(
          guest,
          withAgent(`window.__dshbc.read(${literal(command.target ?? null)}, ${String(command.maxChars)})`),
        )
        if (value?.ok !== true) throw actionError({ ...value, reason: value?.reason ?? 'unknown' }, { kind: 'read' })
        return {
          ...describeTab(tabId, guest),
          text: value.text,
          truncated: value.truncated,
          length: value.length,
        }
      }
      if (command.op === 'console') {
        const value = await run(
          guest,
          withAgent(
            `(function () { var m = window.__dshbc; var logs = m.logs.slice(); var dialogs = m.dialogs.slice(); ${
              command.clear === true ? 'm.logs.length = 0; m.dialogs.length = 0;' : ''
            } return { ok: true, entries: logs, dialogs: dialogs }; })()`,
          ),
        )
        return { ...describeTab(tabId, guest), entries: value?.entries ?? [], dialogs: value?.dialogs ?? [] }
      }
      if (command.op === 'wait') {
        const value = await run(
          guest,
          withAgent(`window.__dshbc.wait(${literal(command.wait)})`),
        )
        if (value?.ok !== true) throw new Error('等待失败：页面脚本没有返回结果')
        if (value.found !== true) {
          throw new Error(`等待超时（${String(command.wait.timeoutMs)}ms）：${describeWait(command.wait)}`)
        }
        return { ...describeTab(tabId, guest), waited_for: describeWait(command.wait), elapsed_ms: value.elapsed_ms }
      }
      throw new Error(`未知的读取操作：${String(command.op)}`)
    }

    /** Describe one wait condition in words. */
    function describeWait(wait) {
      if (wait.loadState !== undefined) return `页面状态 ${wait.loadState}`
      if (wait.text !== undefined) return `可见文本 ${JSON.stringify(wait.text)}`
      if (wait.url !== undefined) return `URL 包含 ${wait.url}`
      const state = wait.state === undefined ? 'visible' : wait.state
      const target = wait.target ?? {}
      const label =
        target.ref !== undefined
          ? `ref=${String(target.ref)}`
          : target.role !== undefined
            ? `role=${String(target.role)}${target.name === undefined ? '' : ` name=${JSON.stringify(target.name)}`}`
            : target.css !== undefined
              ? `css=${String(target.css)}`
              : target.text !== undefined
                ? `text=${JSON.stringify(target.text)}`
                : target.testid !== undefined
                  ? `testid=${String(target.testid)}`
                  : JSON.stringify(target)
      return `${label} 变为 ${state}`
    }

    /** Capture the tab and return PNG bytes as base64. */
    async function screenshot(sidebarRight, command) {
      const { tabId, guest } = resolveTarget(sidebarRight, command.sessionId, command.tabId)
      if (typeof guest.capturePage !== 'function') {
        throw new Error('内置浏览器不支持截图：该 webview 没有 capturePage 方法')
      }
      const surface = readSurface(sidebarRight, guest)
      // Chromium only composites frames for a visible, focused window. An
      // unfocused or hidden one leaves `capturePage` pending forever, so the
      // surface facts decide the budget and the wording of the failure: a full
      // 20s wait tells the model nothing that a 3s wait with a real reason does.
      const canComposite = surface.docVisible !== 'hidden' && surface.docFocused === true
      const budget = canComposite ? 20000 : 3000
      let timer
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              canComposite
                ? `截图超时：capturePage 在 ${String(budget)}ms 内没有返回（surface=${JSON.stringify(surface)}）`
                : surface.docVisible === 'hidden'
                  ? '截图失败：Harness 窗口当前不可见（visibilityState=hidden），内置浏览器没有可截取的画面。请把 Harness 窗口切到前台后重试。'
                  : '截图失败：窗口没有焦点（hasFocus=false），Chromium 不为后台窗口合成画面，capturePage 不会返回。请点一下 Harness 窗口使其获得焦点后重试；只想确认页面结构时改用 browser_snapshot，它不需要焦点。',
            ),
          )
        }, budget)
      })
      let image
      try {
        image = await Promise.race([guest.capturePage(), timeout])
      } finally {
        clearTimeout(timer)
      }
      if (image === undefined || image === null || image.isEmpty?.() === true) {
        throw new Error('截图失败：内置浏览器返回了空图像')
      }
      const size = image.getSize?.() ?? { width: 0, height: 0 }
      return { ...describeTab(tabId, guest), base64: toBase64(image), width: size.width, height: size.height }
    }

    /** Read the visibility facts that decide whether a capture can succeed. */
    function readSurface(sidebarRight, guest) {
      const parent = guest.parentElement
      const rect = parent === null ? null : parent.getBoundingClientRect()
      let expanded
      try {
        expanded = sidebarRight.isExpanded()
      } catch {
        expanded = null
      }
      return {
        expanded,
        docVisible: document.visibilityState,
        docFocused: typeof document.hasFocus === 'function' ? document.hasFocus() : null,
        bodyWidth: rect === null ? null : Math.round(rect.width),
        bodyHeight: rect === null ? null : Math.round(rect.height),
      }
    }

    /**
     * Turn one captured image into base64 PNG bytes.
     *
     * `NativeImage.toPNG()` builds a Node `Buffer`, and the Electron build used
     * here throws `Buffer is not available for the current Context` when that
     * runs inside a context-isolated page. `toDataURL()` only produces a string,
     * so the data URL is the one portable way to get the bytes out of the guest.
     * @param image - value returned by `capturePage()`.
     * @returns the base64 payload without its `data:` prefix.
     */
    function toBase64(image) {
      if (typeof image.toDataURL !== 'function') throw new Error('截图失败：返回的图像不支持读取')
      const url = image.toDataURL()
      if (typeof url !== 'string') throw new Error('截图失败：无法读取图像数据')
      const comma = url.indexOf(',')
      if (comma < 0) throw new Error('截图失败：图像数据格式异常')
      return url.slice(comma + 1)
    }

    /** Run one command against the Session's Browser tabs. */
    async function dispatch(command, ctx) {
      const sidebarRight = ctx.sidebarRight
      switch (command.op) {
        case 'tabs':
          return listTabs(sidebarRight, command.sessionId, ctx.sidebarRight.mounted.getSnapshot())
        case 'open':
          return await openPage(sidebarRight, command)
        case 'state': {
          const { tabId, guest } = resolveTarget(sidebarRight, command.sessionId, command.tabId)
          return describeTab(tabId, guest)
        }
        case 'nav':
          return await navigateHistory(sidebarRight, command)
        case 'close': {
          const tabs = browserTabsOf(sidebarRight, command.sessionId)
          if (tabs.length === 0) throw new Error('该会话没有可关闭的内置浏览器标签页')
          const target = command.tabId ?? (tabs.length === 1 ? tabs[0].tabId : undefined)
          if (target === undefined) {
            throw new Error(`该会话有 ${String(tabs.length)} 个标签页，请用 tab_id 指定要关闭的一个`)
          }
          if (!tabs.some((tab) => tab.tabId === target)) throw new Error(`标签页 ${target} 已不存在`)
          sidebarRight.closeIn(command.sessionId, target)
          return { closed: target }
        }
        case 'snapshot':
        case 'locate':
        case 'read':
        case 'console':
        case 'wait':
          return await inspect(sidebarRight, command)
        case 'act':
          return await act(sidebarRight, command)
        case 'screenshot':
          return await screenshot(sidebarRight, command)
        default:
          throw new Error(`未知的浏览器操作：${String(command.op)}`)
      }
    }

    // ---------------------------------------------------------------------
    // Worker
    // ---------------------------------------------------------------------

    /** Long-poll the Host, run whatever it hands over, and publish the outcome. */
    function startWorker(ctx, signal) {
      let chain = Promise.resolve()

      const claim = () => {
        const sessions = new Set()
        for (const tab of ctx.sidebarRight.openTabs.getSnapshot()) {
          if (tab.kind === 'browser') sessions.add(tab.sessionId)
        }
        const mounted = ctx.sidebarRight.mounted.getSnapshot()
        if (typeof mounted === 'string') sessions.add(mounted)
        return [...sessions]
      }

      const execute = async (command, lifetime) => {
        let payload
        try {
          payload = { callId: command.callId, clientId: CLIENT_ID, ok: true, value: await dispatch(command, ctx) }
        } catch (error) {
          payload = {
            callId: command.callId,
            clientId: CLIENT_ID,
            ok: false,
            error: { message: error instanceof Error ? error.message : String(error) },
          }
        }
        try {
          await ctx.connection.rpc.call(CHANNEL, 'result', payload, lifetime)
        } catch {
          /* the Host reports its own timeout; nothing else to do here */
        }
      }

      const loop = async () => {
        while (!signal.aborted) {
          try {
            const reply = await ctx.connection.rpc.call(
              CHANNEL,
              'poll',
              { clientId: CLIENT_ID, sessions: claim() },
              signal,
            )
            if (signal.aborted) return
            const command = reply?.ok === true ? reply.value?.command : null
            if (command === null || command === undefined) continue
            chain = chain.then(() => execute(command, signal)).catch(() => {})
          } catch {
            if (signal.aborted) return
            await sleep(500)
          }
        }
      }

      loop().catch(() => {})
    }

    return {
      inject: ['connection', 'sidebarRight'],
      apply(ctx) {
        const controller = new AbortController()
        ctx.effect(() => () => controller.abort(), 'dsh-browser-control.worker')
        startWorker(ctx, controller.signal)
      },
    }
  },
})
