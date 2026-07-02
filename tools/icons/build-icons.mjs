import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const dir = process.argv[2] || 'svg';
const files = readdirSync(dir).filter(f => f.endsWith('.svg')).sort();
const inner = {};
for (const f of files) {
  const name = f.replace(/\.svg$/, '');
  let s = readFileSync(`${dir}/${f}`, 'utf8');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<svg[\s\S]*?>/, '').replace(/<\/svg>\s*$/, '');
  s = s.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();
  inner[name] = s;
}
// semantic role -> lucide name
const ALIAS = {
  notes:'notebook-pen', note:'notebook-pen', 'note-new':'square-pen', edit:'pencil', rename:'pencil',
  upgrade:'sparkles', assist:'sparkles', improve:'sparkles', ai:'sparkles', magic:'sparkles',
  close:'x', clear:'x', expand:'maximize-2', caret:'chevron-down',
  recording:'mic', mic:'mic', back:'arrow-left', send:'arrow-up', stop:'square',
  chat:'message-square', ask:'message-square', meetings:'users', people:'users', participants:'users',
  attach:'paperclip', 'save-version':'plus', add:'plus', skills:'graduation-cap',
  'history-clock':'history', clock:'history', privacy:'shield', shield:'shield',
  pageact:'mouse-pointer-click', click:'mouse-pointer-click', watch:'radar', monitor:'radar', monitors:'radar',
  alert:'bell', research:'telescope', 'collapse-list':'panel-left-close', 'expand-list':'panel-left-open',
  'panel-toggle':'panel-right', 'collapse-panel':'chevrons-right', 'expand-panel':'chevrons-left',
  checklist:'list-checks', tasks:'list-checks', bullets:'list', 'numbered-list':'list-todo',
  plan:'compass', continue:'pen-line', cowriter:'pen-line', pen:'pen',
  activity:'wrench', tools:'wrench', tool:'wrench', web:'globe', link:'link', who:'user', user:'user',
  summarize:'file-text', document:'file-text', file:'file', explain:'lightbulb', idea:'lightbulb',
  chart:'bar-chart-3', 'code-review':'search', search:'search', 'meeting-notes':'file-text',
  lock:'lock', pro:'lock', 'external-link':'external-link', external:'external-link',
  queued:'hourglass', loading:'hourglass', pending:'hourglass', keyboard:'keyboard', typed:'keyboard',
  play:'play', refresh:'rotate-cw', reload:'rotate-cw', retry:'rotate-cw',
  mcp:'plug', plug:'plug', download:'download', copy:'copy', clipboard:'clipboard', delete:'trash-2',
  bot:'bot', agent:'bot', calendar:'calendar', date:'calendar', image:'image', screenshot:'camera',
  thinking:'brain', brain:'brain', pin:'pin', tldr:'pin', numbers:'hash', tag:'hash', hash:'hash',
  cut:'scissors', fast:'zap', zap:'zap', target:'target', goal:'target', folder:'folder',
  timer:'timer', star:'star', favorite:'star', graph:'waypoints', video:'video',
  quote:'quote', code:'code', pilcrow:'pilcrow', settings:'settings',
  'align-left':'align-left','align-center':'align-center','align-right':'align-right','align-justify':'align-justify',
  check:'check', done:'check', ok:'check',
  moon:'moon', ambient:'moon', warning:'triangle-alert', 'alert-triangle':'triangle-alert',
  factcheck:'triangle-alert', auto:'scale', balance:'scale', window:'app-window',
};
const EMOJI = {
  '☰':'menu','✎':'notebook-pen','✏':'pencil','✏️':'pencil','✍':'pen-line','✍️':'pen-line',
  '✨':'sparkles','✦':'sparkles','✧':'sparkles','⚙':'settings','⚙️':'settings',
  '✕':'x','⤢':'maximize-2','▾':'chevron-down','📝':'notebook-pen','📄':'file-text','🗒':'file-text','🗎':'file',
  '⬇':'download','⬆':'arrow-up','⧉':'copy','📋':'clipboard','💬':'message-square','👥':'users',
  '＋':'plus','🎓':'graduation-cap','🕘':'history','🕓':'history','🕑':'history','🕐':'history','🕒':'history',
  '🛡':'shield','🛡️':'shield','▶':'play','👁':'radar','👁️':'radar','🔎':'telescope','🔍':'search',
  '🔒':'lock','🔐':'lock','🎙':'mic','🎙️':'mic','🖱':'mouse-pointer-click','🖱️':'mouse-pointer-click',
  '↗':'external-link','⏳':'hourglass','⌨':'keyboard','⌨️':'keyboard','🌐':'globe','🔗':'link',
  '🔧':'wrench','🛠':'wrench','🛠️':'wrench','🧰':'wrench','↻':'rotate-cw','↺':'rotate-cw',
  '💡':'lightbulb','🧭':'compass','🔌':'plug','📎':'paperclip','🗑':'trash-2','🗑️':'trash-2',
  '🤖':'bot','🗓':'calendar','🗓️':'calendar','🖼':'image','🖼️':'image','💭':'brain','🧠':'brain',
  '📌':'pin','☑':'list-checks','☑️':'list-checks','🖋':'pen','📸':'camera','🔢':'hash',
  '✂':'scissors','✂️':'scissors','⚡':'zap','🎯':'target','🗂':'folder','🗂️':'folder',
  '⏱':'timer','⏱️':'timer','⏲':'timer','★':'star','⭐':'star','🕸':'waypoints','📹':'video',
  '📊':'bar-chart-3','⌕':'search','❝':'quote','¶':'pilcrow',
  '🌙':'moon','⚠':'triangle-alert','⚠️':'triangle-alert','⚖':'scale','⚖️':'scale','🪟':'app-window',
};
const banner = `// icons.js — vendored Lucide (ISC) inline-SVG icon set. Generated; do not hand-edit.\n`+
`// Source: lucide-static v1.23.0 — https://lucide.dev . Rebuild: tools/icons/build-icons.mjs.\n`+
`// Usage: import { icon, hydrate, iconForEmoji } from './icons.js';\n`+
`//   icon('notes') -> "<svg…>"   |   HTML: <button data-icon="notes"></button> (auto-hydrated)\n`;
const paths = 'export const ICON_PATHS = ' + JSON.stringify(inner) + ';\n\n';
const aliases = 'export const ICON_ALIAS = ' + JSON.stringify(ALIAS) + ';\n\n';
const emoji = 'export const EMOJI_ICON = ' + JSON.stringify(EMOJI) + ';\n\n';
const body = `
export function resolveName(name) { return ICON_ALIAS[name] || name; }

export function icon(name, { cls = '', size } = {}) {
  const key = resolveName(name);
  const p = ICON_PATHS[key];
  if (!p) { console.warn('[icons] unknown icon:', name); return ''; }
  const sz = size ? \` width="\${size}" height="\${size}"\` : '';
  const c = ('ico' + (cls ? ' ' + cls : '')).trim();
  return \`<svg class="\${c}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"\${sz}>\${p}</svg>\`;
}

// Map a legacy emoji glyph to its SVG. Returns '' if the emoji has no icon (keep as text).
export function iconForEmoji(ch, opts) {
  const key = EMOJI_ICON[ch];
  return key ? icon(key, opts) : '';
}

export function hydrate(root) {
  const scope = root || (typeof document !== 'undefined' ? document : null);
  if (!scope) return;
  for (const el of scope.querySelectorAll('[data-icon]:not([data-icon-done])')) {
    const svg = icon(el.getAttribute('data-icon'));
    if (!svg) continue;
    el.insertAdjacentHTML('afterbegin', svg);
    el.setAttribute('data-icon-done', '');
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => hydrate());
  else hydrate();
}
`;
writeFileSync('icons.js', banner + paths + aliases + emoji + body);
console.log('icons:', Object.keys(inner).length, 'aliases:', Object.keys(ALIAS).length, 'emoji:', Object.keys(EMOJI).length);
console.log('bytes:', Buffer.byteLength(banner+paths+aliases+emoji+body));
