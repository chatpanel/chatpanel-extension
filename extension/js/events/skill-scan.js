// GENERATED — do not edit.
// Source of truth: chatpanel-events/skill-scan.js (npm @chatpanel/events).
// Edit there, then run: npm run sync:events
//
// Vendored because the extension loads raw ES modules with no bundler. The gateway
// and bridge take the same package as an npm dependency instead; a future mobile or
// desktop client takes it the same way, or speaks the wire contract if it is native.

// skill-scan.js — is this skill safe to admit?
//
// A SKILL.md is a prompt that will run with page tools, MCP servers and history attached.
// Once skills can arrive from a hub, a repo or a shared folder, that makes it an injection
// payload with a distribution channel — the reason every serious agent harness quarantines
// what it installs. This is the gate F6 puts in front of admission.
//
// THE PRECISION PROBLEM IS THE WHOLE DESIGN. A scanner that flags legitimate skills is
// worse than none: people learn to click past it, and then it protects nothing. Real
// skills are full of shell examples, curl commands and API docs. So:
//
//   • `dangerous` requires high-precision evidence — an instruction override aimed at the
//     model, or a CREDENTIAL PATH combined with an OUTBOUND SINK in the same breath.
//     Neither half alone is enough: `curl https://api.example.com` is documentation and
//     `~/.aws/credentials` is a sentence about configuration.
//   • `suspicious` is for things worth a human glance that are not proof of anything.
//   • everything else is `clean`, and the common case must be clean.
//
// It is a heuristic gate, not a proof. It stops the obvious and the careless; it is not a
// claim that an admitted skill is safe, which is why provenance stays visible at use time
// and why scripts stay behind a separate confirmation.
//
// Pure and clock-free: the caller stamps the time, so the same input always produces the
// same finding list and a verdict can be cached by content hash.

export class SkillScanError extends Error {
  constructor(code, message) { super(message); this.name = 'SkillScanError'; this.code = code; }
}

/** Bump when a rule changes: a cached verdict from an older scanner must not be trusted. */
export const SCANNER_VERSION = 1;

export const SCAN_VERDICTS = Object.freeze(['clean', 'suspicious', 'dangerous']);

const RANK = { clean: 0, suspicious: 1, dangerous: 2 };

// Characters that carry no visible meaning and exist in a prompt for one reason: to hide
// text from the person reading it while the model still sees it. Zero-width joiners,
// bidirectional overrides, and the Unicode tag block used for "invisible" instructions.
// eslint-disable-next-line no-misleading-character-class
const HIDDEN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿\u{e0000}-\u{e007f}]/u;

// Aimed at the MODEL rather than describing anything. Deliberately narrow: "ignore the
// previous section" is ordinary prose, "ignore all previous instructions" is not.
const OVERRIDE = [
  /\bignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|prompts?|rules?|directions?)\b/i,
  /\bdisregard\s+(?:all\s+|any\s+)?(?:previous|prior|the)\s+(?:instructions?|system\s+prompt|rules?)\b/i,
  /\b(?:forget|override)\s+(?:everything|all)\s+(?:you|above|previously)\b/i,
  /\byou\s+are\s+no\s+longer\s+(?:bound|restricted|required)\b/i,
  /<\/?(?:system|assistant)\b[^>]*>/i,
  /\bnew\s+system\s+prompt\s*:/i,
];

// Telling the model to keep something from the person it is working for. Real injection
// signature — and also, sometimes, ordinary editorial guidance, which is why it is
// SUSPICIOUS rather than dangerous.
//
// Codex's own `plugin-creator` skill is the case that settled the severity: it says "Do
// not tell the user to run `codex plugin marketplace add`", which is advice about what to
// recommend, not concealment. A first-party skill quarantined by a rule that cannot tell
// those apart would teach people to click past the gate — so the phrasing is narrowed
// (`to <verb>` is excluded) AND the severity is honest about what the match proves.
const CONCEALMENT = [
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform)\s+the\s+user\b(?!\s+to\s)/i,
  /\b(?:do\s+not|don't|never)\s+(?:mention|reveal|disclose)\s+(?:this|that|it|any(?:thing)?)?\s*to\s+the\s+user\b/i,
  /\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b/i,
  /\bhide\s+(?:this|that|it)\s+from\s+the\s+user\b/i,
];

// Things that identify a secret. A path or a well-known variable name — not the word
// "token", which appears in every API document ever written.
const CREDENTIAL = [
  /~\/\.ssh\/|\bid_rsa\b|\bid_ed25519\b/i,
  /~\/\.aws\/credentials|\bAWS_SECRET_ACCESS_KEY\b/i,
  /\.env\b(?!\w)|\bprintenv\b|\benv\s*\|/i,
  /~\/\.netrc|\.git-credentials|\bkeychain\s+dump\b/i,
  /\bGITHUB_TOKEN\b|\bNPM_TOKEN\b|\bOPENAI_API_KEY\b|\bANTHROPIC_API_KEY\b/,
  /~\/\.config\/(?:gh|gcloud)\/|\bgcloud\s+auth\s+print-access-token\b/i,
];

// Something that sends data OFF the machine. An outbound body, not a fetch.
const SINK = [
  /\bcurl\b[^\n|]*(?:-d|--data|--data-binary|-F|--form|-T|--upload-file)\b/i,
  /\bwget\b[^\n|]*--post-(?:data|file)\b/i,
  /\b(?:nc|netcat|ncat)\b\s+[\w.-]+\s+\d+/i,
  /\bfetch\s*\([^)]*method\s*:\s*['"]POST/i,
  /\brequests\.post\s*\(/i,
  /\|\s*(?:curl|nc|netcat)\b/i,
  /\bscp\b\s+\S+\s+\S+@/i,
];

// Irreversible, and never something a skill document needs to demonstrate literally.
const DESTRUCTIVE = [
  { re: /\brm\s+-[a-z]*[rR][a-z]*f[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME)(?:\/\s|\/?[`'"\s]|$)/, why: 'recursive delete of a root or home directory' },
  { re: /\bmkfs(?:\.\w+)?\b/, why: 'filesystem format' },
  { re: /\bdd\s+[^\n]*\bof=\/dev\/(?:sd|nvme|disk)/, why: 'raw write to a block device' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bchmod\s+-R\s+777\s+\//, why: 'world-writable root' },
  { re: /\bhistory\s+-c\b|\bshred\b\s+[^\n]*\.(?:log|history)/, why: 'covering tracks' },
];

const SUSPECT = [
  { re: /\b(?:eval|exec)\s*\(\s*(?:atob|base64|Buffer\.from)/i, why: 'executes decoded content' },
  { re: /\bbase64\s+-d\b[^\n]*\|\s*(?:sh|bash|zsh|python)/i, why: 'pipes decoded content to a shell' },
  { re: /\bcurl\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/i, why: 'pipes a download straight into a shell' },
  { re: /[A-Za-z0-9+/]{280,}={0,2}/, why: 'a large opaque base64 blob' },
  { re: /\bhttp:\/\/(?!localhost|127\.0\.0\.1|\[::1\])[\w.-]+/i, why: 'sends or fetches over plain HTTP' },
  { re: /\bsudo\s+(?:-S\s+)?[^\n]*<<</i, why: 'feeds a password to sudo' },
];

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const excerpt = (text, index, len = 90) => text.slice(Math.max(0, index - 10), index + len).replace(/\s+/g, ' ').trim();

function find(text, re) {
  const m = re.exec(text);
  return m ? { index: m.index, match: m[0] } : null;
}

/**
 * Scan one skill.
 *
 * @param name    for the finding messages
 * @param prompt  the SKILL.md body — the thing that becomes a prompt
 * @param files   declared package paths, e.g. ['references/a.md', 'scripts/run.py']
 * @param extra   additional text to scan (a reference document's contents, when the caller
 *                has fetched them). Scanned under the same rules: a skill that points at a
 *                clean-looking file which itself carries the payload is the obvious dodge.
 *
 * -> { verdict, findings: [{ rule, severity, line, excerpt, why }], scanner }
 */
export function scanSkill({ name = '', prompt = '', files = [], extra = '' } = {}) {
  const text = [String(prompt || ''), String(extra || '')].filter(Boolean).join('\n\n');
  const findings = [];
  const add = (rule, severity, hit, why) => {
    findings.push({
      rule,
      severity,
      why,
      line: hit ? lineOf(text, hit.index) : 0,
      excerpt: hit ? excerpt(text, hit.index) : '',
    });
  };

  if (HIDDEN.test(text)) {
    // No legitimate reason for a procedure document to contain characters the reader
    // cannot see but the model can.
    add('hidden-text', 'dangerous', find(text, HIDDEN), 'contains characters that are invisible to a reader but not to the model');
  }

  for (const re of OVERRIDE) {
    const hit = find(text, re);
    if (hit) { add('instruction-override', 'dangerous', hit, 'tries to override the instructions it is running under'); break; }
  }

  for (const re of CONCEALMENT) {
    const hit = find(text, re);
    if (hit) { add('concealment', 'suspicious', hit, 'asks the model to keep something from the user'); break; }
  }

  // The combination is the evidence. Either half alone is ordinary documentation.
  const cred = CREDENTIAL.map((re) => find(text, re)).find(Boolean);
  const sink = SINK.map((re) => find(text, re)).find(Boolean);
  if (cred && sink) {
    add('credential-exfiltration', 'dangerous', cred, `names a credential (${cred.match.trim().slice(0, 40)}) alongside a command that sends data off the machine`);
  } else if (cred) {
    add('credential-mention', 'suspicious', cred, 'refers to a credential file or secret variable');
  } else if (sink) {
    add('outbound-data', 'suspicious', sink, 'sends data to a remote host');
  }

  for (const { re, why } of DESTRUCTIVE) {
    const hit = find(text, re);
    if (hit) add('destructive-command', 'dangerous', hit, why);
  }

  for (const { re, why } of SUSPECT) {
    const hit = find(text, re);
    if (hit) add('suspicious-pattern', 'suspicious', hit, why);
  }

  // Scripts are not scanned as prose — they are code, and this is not a code analyser.
  // Their presence is reported so the reviewer knows execution is on the table at all.
  const scripts = (Array.isArray(files) ? files : []).filter((f) => String(f).startsWith('scripts/'));
  if (scripts.length) {
    findings.push({
      rule: 'ships-executable',
      severity: 'suspicious',
      why: `ships ${scripts.length} executable file${scripts.length === 1 ? '' : 's'} (${scripts.join(', ')}) — these run on your machine, not in the browser`,
      line: 0,
      excerpt: '',
    });
  }

  const verdict = findings.reduce((worst, f) => (RANK[f.severity] > RANK[worst] ? f.severity : worst), 'clean');
  return { verdict, findings, scanner: SCANNER_VERSION, name: String(name || '') };
}

/** Is this verdict allowed to enter the index at all? */
export function admits(verdict) {
  return verdict !== 'dangerous';
}

/** A one-line reason, for a card or a refusal. */
export function scanSummary(scan) {
  if (!scan || scan.verdict === 'clean') return '';
  const worst = (scan.findings || []).filter((f) => f.severity === scan.verdict);
  const first = worst[0];
  const more = worst.length > 1 ? ` (+${worst.length - 1} more)` : '';
  return first ? `${first.why}${more}` : scan.verdict;
}
