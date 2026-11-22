// =============================================================================
// MARKDOWN — the prose sections' formatting, and the sanitizer that lands it
// =============================================================================
'use strict';

// The only place in the app that turns a string into markup — everywhere else
// builds DOM with `createElement` + `textContent`. Raw HTML is deliberately
// allowed (a player reaching past the renderer), so the sanitizer at the bottom
// of this file is not optional: a sheet syncs to Firebase and renders in the
// GM's browser, so a `<script>` in a backstory would run there. Rule: formatting
// is allowed, behaviour is not. Pipe tables are not parsed; a hand-written
// `<table>` is the escape hatch.

// A list item line: indent, marker, text. class-features.js reads it too.
const MD_LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

// The sanitizer's allowlists are the contract: anything not named here does not survive.
// Tags whose whole job is how the text looks — inert markup:
const MD_ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
  'code', 'pre', 'kbd', 'samp', 'var', 'abbr', 'cite', 'q', 'time',
  'blockquote', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
]);

// Dropped WITH their contents — an unknown tag is merely unwrapped, but the text
// inside a `<script>` IS the payload.
const MD_DROP_WHOLE = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'applet', 'link', 'meta',
  'base', 'form', 'input', 'button', 'select', 'option', 'textarea', 'noscript',
  'template', 'svg', 'math', 'audio', 'video', 'source', 'track', 'canvas',
  'frame', 'frameset', 'portal', 'dialog',
]);

const MD_ALLOWED_ATTRS = {
  '*':  ['title', 'style', 'dir', 'lang'],
  a:    ['href', 'target', 'rel'],
  img:  ['src', 'alt', 'width', 'height'],
  ol:   ['start', 'reversed', 'type'],
  li:   ['value'],
  th:   ['colspan', 'rowspan', 'scope'],
  td:   ['colspan', 'rowspan'],
  col:  ['span'],
  colgroup: ['span'],
  time: ['datetime'],
  code: ['class'],   // the language- hint this file writes, nothing else
};

// ─── THE ENTRY POINT ────────────────────────────────────────────────────────
// Replaces `el`'s content with `src` rendered as sanitized Markdown.
// Two steps, always both: text → markup, then markup → a scrubbed fragment.
function renderMarkdownInto(el, src) {
  el.textContent = '';
  el.appendChild(_convertMarkdownToFragment(src));
}

function _convertMarkdownToFragment(src) {
  return _sanitizeHTML(_convertMarkdownToHTML(src));
}

// ─── BLOCKS ─────────────────────────────────────────────────────────────────
function _convertMarkdownToHTML(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // ── Fenced code ── everything to the closing fence, verbatim.
    const fence = line.match(/^\s{0,3}(```+|~~~+)\s*([\w-]*)\s*$/);
    if (fence) {
      const close = fence[1][0];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp('^\\s{0,3}' + close + '{3,}\\s*$').test(lines[i])) {
        body.push(lines[i]); i++;
      }
      i++; // the closing fence, or the end of the text
      const lang = fence[2] ? ` class="language-${fence[2].replace(/[^\w-]/g, '')}"` : '';
      out.push(`<pre><code${lang}>${escapeHTML(body.join('\n'))}</code></pre>`);
      continue;
    }

    // ── Horizontal rule ── before headings, so `---` is never a stray heading.
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) { out.push('<hr>'); i++; continue; }

    // ── ATX heading ──
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const n = h[1].length;
      out.push(`<h${n}>${_convertInlineMarkdown(h[2])}</h${n}>`);
      i++;
      continue;
    }

    // ── Blockquote ── the marker is stripped and what is left is Markdown in
    // its own right, so a quote can hold a list or a heading.
    if (/^\s{0,3}>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++;
      }
      out.push(`<blockquote>${_convertMarkdownToHTML(body.join('\n'))}</blockquote>`);
      continue;
    }

    // ── List ──
    if (MD_LIST_RE.test(line)) {
      const [items, next] = _collectListItems(lines, i);
      out.push(_buildListHTML(items, 0, items[0].indent)[0]);
      i = next;
      continue;
    }

    // ── A raw HTML block ── a line opening with a tag hands the rest of the
    // paragraph over untouched, so a hand-written <table> survives intact
    // instead of being wrapped in a <p> and inline-formatted.
    if (/^\s{0,3}<[a-zA-Z!/]/.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim()) { body.push(lines[i]); i++; }
      out.push(body.join('\n'));
      continue;
    }

    // ── Paragraph ── to the next blank line or block opener.
    const para = [];
    while (i < lines.length && lines[i].trim()
           && !MD_LIST_RE.test(lines[i])
           && !/^\s{0,3}(#{1,6}\s|>|```|~~~|<[a-zA-Z!/])/.test(lines[i])
           && !/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(lines[i])) {
      para.push(lines[i]); i++;
    }

    // The loop above must always consume something — the paragraph-stopping
    // tests are looser than the block-opening ones, so a line like "```js extra"
    // can fall through every branch and hang on `i`. Take it as one paragraph line.
    if (!para.length) { para.push(lines[i]); i++; }

    out.push(`<p>${_convertInlineMarkdown(para.join('\n'))}</p>`);
  }

  return out.join('\n');
}

// A run of list lines, flattened with their indent depth. A line that is
// indented but is not itself an item is a continuation of the one above it —
// which is what lets a bullet carry a second line without breaking the list.
function _collectListItems(lines, start) {
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(MD_LIST_RE);
    if (!m) break;
    items.push({
      indent: m[1].replace(/\t/g, '    ').length,
      ordered: /\d/.test(m[2]),
      text: m[3],
    });
    i++;
    while (i < lines.length && lines[i].trim()
           && !MD_LIST_RE.test(lines[i]) && /^\s{2,}\S/.test(lines[i])) {
      items[items.length - 1].text += '\n' + lines[i].trim();
      i++;
    }
  }
  return [items, i];
}

// Nesting is by indent: a deeper item becomes a list inside the item above it.
// Returns the html and where it stopped, so the caller can carry on from there.
function _buildListHTML(items, pos, indent) {
  const ordered = items[pos].ordered;
  const parts = [];

  while (pos < items.length && items[pos].indent >= indent) {
    if (items[pos].indent > indent) {
      if (!parts.length) break;             // over-indented with nothing to nest under
      const [inner, next] = _buildListHTML(items, pos, items[pos].indent);
      parts[parts.length - 1] += inner;
      pos = next;
      continue;
    }
    if (items[pos].ordered !== ordered) break; // a bullet list ends an ordered one
    parts.push(_convertInlineMarkdown(items[pos].text));
    pos++;
  }

  const tag = ordered ? 'ol' : 'ul';
  return [`<${tag}>${parts.map(p => `<li>${p}</li>`).join('')}</${tag}>`, pos];
}

// ─── INLINE ─────────────────────────────────────────────────────────────────
// Code spans and backslash escapes are lifted out first (stood in for by
// `@@MD<n>@@` — a printable sentinel, so it survives every editor) and put back
// last, so nothing inside them is formatted.
function _convertInlineMarkdown(text) {
  const held = [];
  const hold = s => `@@MD${held.push(s) - 1}@@`;

  let s = String(text)
    .replace(/`([^`]+)`/g, (m, code) => hold(`<code>${escapeHTML(code)}</code>`))
    .replace(/\\([\\`*_{}\[\]()#+\-.!~>])/g, (m, ch) => hold(escapeHTML(ch)));

  // Images before links — the syntax differs by one leading character.
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g,
    (m, alt, src, title) =>
      `<img src="${_escapeAttr(src)}" alt="${_escapeAttr(alt)}"${title ? ` title="${_escapeAttr(title)}"` : ''}>`);

  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g,
    (m, label, href, title) =>
      `<a href="${_escapeAttr(href)}"${title ? ` title="${_escapeAttr(title)}"` : ''}>${label}</a>`);

  // `**` before `*`, so the longer marker wins. The `_` forms additionally
  // refuse to fire inside a word, or snake_case names would come out italic.
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[^\w\\])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
       .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
       .replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>')
       .replace(/(^|[^\w\\])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');

  // A single newline is a line break — standard Markdown wants two trailing
  // spaces, which nobody writing a backstory in a box knows.
  s = s.replace(/\n/g, '<br>');

  return s.replace(/@@MD([0-9]+)@@/g, (m, n) => held[n]);
}

// Escapes &, < and > so `s` reads as text inside HTML.
function escapeHTML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _escapeAttr(s) {
  return escapeHTML(s).replace(/"/g, '&quot;');
}

// ─── THE SANITIZER ──────────────────────────────────────────────────────────
// Anything the browser ignores when it reads a URL, removed before the scheme
// is looked at: control characters, spaces, and HTML entities. `java&#9;script:`
// and `java script:` are both URLs a browser will happily run, and both walk
// straight past a naive prefix check.
function _stripInvisibleChars(raw) {
  return String(raw)
    .replace(/&#[^;]{1,8};?/g, '')
    .split('')
    .filter(ch => { const c = ch.charCodeAt(0); return c > 32 && c !== 127; })
    .join('');
}

// `javascript:` and friends, however they are spelled.
function _isSafeURL(raw, kinds) {
  const url = _stripInvisibleChars(raw).toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:/.test(url)) {
    const scheme = url.slice(0, url.indexOf(':'));
    if (scheme === 'data') return kinds.data && /^data:image\/(png|jpe?g|gif|webp|avif);base64,/.test(url);
    return kinds.schemes.includes(scheme);
  }
  return true; // relative, anchor, or protocol-relative — nothing executable
}

// `url()` can fetch, `expression()` executes in old IE, `@import` pulls a
// stylesheet in. Formatting does not need any of them.
function _isSafeStyle(value) {
  return !/(url\s*\(|expression\s*\(|javascript\s*:|@import|behaviou?r\s*:|-moz-binding)/i.test(value);
}

function _sanitizeHTML(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;          // inert: a template's content has no browsing
  _scrubNode(tpl.content);       // context, so nothing here loads or runs
  return tpl.content;
}

function _scrubNode(node) {
  // A live list would shift under the unwrapping below.
  Array.from(node.childNodes).forEach(child => {
    if (child.nodeType === Node.COMMENT_NODE) { child.remove(); return; }
    if (child.nodeType !== Node.ELEMENT_NODE) return;

    const tag = child.tagName.toLowerCase();

    if (MD_DROP_WHOLE.has(tag)) { child.remove(); return; }

    if (!MD_ALLOWED_TAGS.has(tag)) {
      // Unwrap: keep the writing, lose the tag.
      _scrubNode(child);
      child.replaceWith(...Array.from(child.childNodes));
      return;
    }

    _scrubAttributes(child, tag);
    _scrubNode(child);
  });
}

function _scrubAttributes(el, tag) {
  const allowed = (MD_ALLOWED_ATTRS['*'] ?? []).concat(MD_ALLOWED_ATTRS[tag] ?? []);

  Array.from(el.attributes).forEach(attr => {
    const name = attr.name.toLowerCase();
    const value = attr.value;

    // Every `on*` handler, whatever it is attached to. Checked before the
    // allowlist rather than relying on it, because this is the one class of
    // attribute that must never survive a later edit to the lists above.
    if (name.startsWith('on') || !allowed.includes(name)) { el.removeAttribute(attr.name); return; }

    if (name === 'href' && !_isSafeURL(value, { schemes: ['http', 'https', 'mailto', 'tel'], data: false })) {
      el.removeAttribute(attr.name);
    } else if (name === 'src' && !_isSafeURL(value, { schemes: ['http', 'https'], data: true })) {
      el.removeAttribute(attr.name);
    } else if (name === 'style' && !_isSafeStyle(value)) {
      el.removeAttribute(attr.name);
    } else if (name === 'class' && tag === 'code' && !/^language-[\w-]+$/.test(value)) {
      el.removeAttribute(attr.name);
    }
  });

  // A link that opens elsewhere must not hand the opener over with it.
  if (tag === 'a' && el.getAttribute('target')) {
    el.setAttribute('rel', 'noopener noreferrer');
  }
}
