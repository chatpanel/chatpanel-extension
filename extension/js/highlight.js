// A tiny, dependency-free syntax highlighter for chat code blocks.
//
// Why not a library: the panel treats first-paint weight as a release gate, and highlight.js
// or Prism is 50-100 KB+ for something a few hundred lines of regex covers well enough to
// read. This runs from artifacts.js (dynamically imported), so it costs nothing until a
// message actually contains code.
//
// SAFETY: it never parses HTML. It walks the ALREADY-ESCAPED text of a <code> element and
// wraps token ranges in <span class="tok-…">. Because the source text is escaped first by
// markdown.js and we only ever insert our own spans around it, model output cannot inject
// markup here.
//
// Coverage is deliberately "good enough to read": comments, strings, numbers, keywords,
// types/classes, functions, and tag/attribute shapes for markup. Unknown languages fall back
// to a generic pass rather than nothing.

const KEYWORDS = {
  js: 'await async break case catch class const continue default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while yield true false null undefined',
  ts: 'abstract any as asserts await async boolean break case catch class const continue declare default delete do else enum export extends finally for from function get if implements import in instanceof interface keyof let namespace never new number of private protected public readonly return set static string super switch this throw try type typeof undefined union unknown var void while yield true false null',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda None nonlocal not or pass raise return True False try while with yield self',
  sh: 'if then else elif fi for while do done case esac function return export local readonly source alias echo cd set unset trap exit',
  css: 'important media supports keyframes import charset font-face',
  sql: 'select from where group by order having join left right inner outer on as insert into values update set delete create table drop alter index view distinct limit offset union all and or not null',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false',
  rust: 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while',
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch this throw throws try void volatile while true false null',
};
KEYWORDS.jsx = KEYWORDS.js; KEYWORDS.tsx = KEYWORDS.ts; KEYWORDS.javascript = KEYWORDS.js;
KEYWORDS.typescript = KEYWORDS.ts; KEYWORDS.python = KEYWORDS.py; KEYWORDS.bash = KEYWORDS.sh;
KEYWORDS.shell = KEYWORDS.sh; KEYWORDS.zsh = KEYWORDS.sh; KEYWORDS.golang = KEYWORDS.go;

const MARKUP = new Set(['html', 'xml', 'svg', 'vue', 'markdown', 'md']);
const LINE_COMMENT = { py: '#', sh: '#', ruby: '#', yaml: '#', toml: '#', sql: '--' };

// Fence tags people actually write → the id whose rules we use.
const ALIAS = {
  javascript: 'js', mjs: 'js', cjs: 'js', node: 'js', jsx: 'js',
  typescript: 'ts', tsx: 'ts',
  python: 'py', py3: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh',
  golang: 'go', yml: 'yaml', json5: 'json',
  'c++': 'java', cpp: 'java', c: 'java', cs: 'java', csharp: 'java',
  kotlin: 'java', swift: 'java', scala: 'java',
  rb: 'ruby', php: 'js', md: 'markdown', htm: 'html',
};

/** The canonical language id for a fence tag ('' when we have no rules for it). */
export function normalizeLang(lang) {
  const raw = String(lang || '').toLowerCase().replace(/^lang-/, '').trim();
  if (!raw) return '';
  const l = ALIAS[raw] || raw;
  if (KEYWORDS[l] || MARKUP.has(l) || LINE_COMMENT[l] || l === 'json') return l;
  return '';
}

// Tokenize escaped source into [{ text, cls }]. One left-to-right pass: whichever construct
// starts earliest wins, so a keyword inside a string is never highlighted separately.
function tokenize(src, lang) {
  const out = [];
  const kw = new Set((KEYWORDS[lang] || '').split(/\s+/).filter(Boolean));
  const lineComment = LINE_COMMENT[lang] || '//';
  const markup = MARKUP.has(lang);
  let i = 0;
  let text = '';
  const flush = () => { if (text) { out.push({ text }); text = ''; } };
  const push = (t, cls) => { flush(); out.push({ text: t, cls }); };

  while (i < src.length) {
    const rest = src.slice(i);

    // Block comment
    if (!markup && rest.startsWith('/*')) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      push(src.slice(i, stop), 'com'); i = stop; continue;
    }
    // Markup comment
    if (markup && rest.startsWith('&lt;!--')) {
      const end = src.indexOf('--&gt;', i);
      const stop = end < 0 ? src.length : end + 6;
      push(src.slice(i, stop), 'com'); i = stop; continue;
    }
    // Line comment (never inside markup, where // is just text)
    if (!markup && rest.startsWith(lineComment)) {
      const nl = src.indexOf('\n', i);
      const stop = nl < 0 ? src.length : nl;
      push(src.slice(i, stop), 'com'); i = stop; continue;
    }
    // Strings — the escaped source carries &quot; / &#39; for quotes.
    const q = rest.startsWith('&quot;') ? '&quot;' : rest.startsWith('&#39;') ? '&#39;' : rest.startsWith('`') ? '`' : '';
    if (q) {
      let j = i + q.length;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(q, j)) { j += q.length; break; }
        if (src[j] === '\n' && q === '`') { j++; continue; }
        j++;
      }
      push(src.slice(i, Math.min(j, src.length)), 'str'); i = Math.min(j, src.length); continue;
    }
    // Markup tag name + attributes
    if (markup && rest.startsWith('&lt;')) {
      const end = src.indexOf('&gt;', i);
      const stop = end < 0 ? src.length : end + 4;
      const chunk = src.slice(i, stop);
      // <tag  → punctuation + tag name, then attribute names inside
      const m = chunk.match(/^&lt;\/?\s*([A-Za-z][\w:-]*)/);
      if (m) {
        push(chunk.slice(0, m[0].length - m[1].length), 'pun');
        push(m[1], 'tag');
        const inner = chunk.slice(m[0].length);
        // Order matters, and ENTITIES come before attribute names. The source is escaped, so
        // a tag ends in the four characters `&gt;` — and a bare `[A-Za-z_:]…` rule happily
        // matched the `gt` inside it, wrapping it in a span. That split the entity across
        // markup, the browser stopped seeing it as one, and the block rendered a literal
        // `&gt;`. The `=` of an attribute used to be swallowed the same way (it was matched
        // and then never emitted), so `class="x"` displayed as `class"x"`.
        inner.replace(
          /(&quot;[^&]*&quot;|&#39;[^&]*&#39;)|(&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);)|([A-Za-z_:][\w:.-]*)|([\s\S])/g,
          (whole, str2, entity, attr, other) => {
            if (str2) push(str2, 'str');
            else if (entity) text += entity;   // one unit — never wrap it in a span
            else if (attr) push(attr, 'atr');
            else text += other || '';          // '=', '/', whitespace
            return '';
          },
        );
        flush();
        i = stop; continue;
      }
      push('&lt;', 'pun'); i += 4; continue;
    }
    // Numbers
    const num = rest.match(/^(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?)/);
    if (num && !/[\w$]/.test(src[i - 1] || '')) { push(num[0], 'num'); i += num[0].length; continue; }
    // Words: keyword, function call, class-ish name, or plain
    const word = rest.match(/^[A-Za-z_$][\w$]*/);
    if (word) {
      const w = word[0];
      const after = src.slice(i + w.length).match(/^\s*\(/);
      if (kw.has(w)) push(w, 'kw');
      else if (after) push(w, 'fn');
      else if (/^[A-Z]/.test(w) && lang !== 'sh') push(w, 'cls');
      else text += w;
      i += w.length; continue;
    }
    text += src[i]; i++;
  }
  flush();
  return out;
}

/** Escaped source + language → HTML with token spans. Pure; testable without a DOM. */
export function highlight(escapedSource, lang) {
  const l = normalizeLang(lang);
  if (!l) return escapedSource;
  return tokenize(escapedSource, l)
    .map((t) => (t.cls ? `<span class="tok-${t.cls}">${t.text}</span>` : t.text))
    .join('');
}

/** Highlight every <pre><code class="lang-…"> under `root`. Idempotent and never throws. */
export function highlightCode(root) {
  if (!root || !root.querySelectorAll) return;
  // [data-closed] only: a block whose fence has not closed yet is still being streamed, and
  // re-highlighting it on every token is what made the message flicker.
  for (const code of root.querySelectorAll('pre > code[class^="lang-"][data-closed]:not([data-hl])')) {
    try {
      const lang = (code.className.match(/lang-([\w+#-]+)/) || [])[1] || '';
      if (!normalizeLang(lang)) continue;
      code.setAttribute('data-hl', '1');
      // textContent is the plain source; re-escape it exactly as markdown.js did, then
      // highlight. We never read innerHTML, so no existing markup is re-interpreted.
      const escaped = code.textContent
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      code.innerHTML = highlight(escaped, lang);
    } catch { /* leave the block as plain text */ }
  }
}
