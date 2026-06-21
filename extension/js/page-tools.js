// Agent-facing layer over page-actions.js. Turns "fill forms & operate on the
// page" into model tools the chat loop can call, AND exposes a one-shot
// user-triggered entry point. Both routes share the same gated primitives.
//
//   Agent route:  providers.js is handed PAGE_TOOL_SPECS + makePageToolExecutor(tabId)
//                 and runs a tool-use loop (OpenAI / Anthropic API agents only —
//                 bridge CLIs run their own agentic loop and can't take these).
//   User route:   sidepanel calls inspectForms/fillForm/clickElement directly, or
//                 runPageActionTurn() to kick off a tool-enabled turn on demand.
//
// Pro gate lives in page-actions.js (requirePro on every entry), so neither route
// can drive page writes on Free even if a caller forgets to pre-check.

import { inspectForms, fillForm, clickElement, clickByText } from './page-actions.js';
import { cdpFillForm, cdpClickElement, cdpClickByText } from './page-actions-cdp.js';

// Provider-agnostic tool specs. providers.js maps these into OpenAI's
// `{type:'function', function:{…}}` and Anthropic's `{name, input_schema}` shapes.
export const PAGE_TOOL_SPECS = [
  {
    name: 'inspect_page',
    description:
      "Read the active browser tab's interactive elements: fillable form fields, " +
      'clickable buttons, AND links (anchors). Returns each with a stable `selector` ' +
      '— fields also carry label/type/current value/(dropdown) options; links carry ' +
      'their text and href. ALWAYS call this first so you know the exact selectors ' +
      'before filling or clicking. To click a link (e.g. a “comments” link), find it ' +
      'in `links` and pass its selector to click_element.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fill_form',
    description:
      'Set values on form fields in the active tab. Use selectors returned by ' +
      'inspect_page. For checkboxes/radios pass true/false; for dropdowns pass ' +
      'the option value or its visible label. Does NOT submit — call click_element for that.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'The fields to fill.',
          items: {
            type: 'object',
            properties: {
              selector: { type: 'string', description: 'CSS selector from inspect_page.' },
              value: {
                type: ['string', 'boolean', 'number'],
                description: 'Value to set (true/false for checkbox/radio).',
              },
            },
            required: ['selector', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'click_element',
    description:
      'Click a button or link in the active tab (e.g. submit, next, add). Use a ' +
      'selector from inspect_page. Returns the clicked element’s text.',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element to click.' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'click_by_text',
    description:
      "Click a button or link by its visible text / accessible name when you don't " +
      'have a reliable selector — e.g. a "Search" or "Submit" button on a complex app. ' +
      'Matches case-insensitively (exact, then prefix, then substring). Optionally ' +
      'restrict to a role. Prefer this over guessing a selector for action buttons.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text / accessible name to match.' },
        role: {
          type: 'string',
          enum: ['button', 'link', 'any'],
          description: 'Restrict the match (default any).',
        },
      },
      required: ['text'],
    },
  },
];

// Keep tool results small — the model re-reads them every step, and a big form
// page can have dozens of fields. Trim option lists and string lengths.
function compactInspect(r) {
  const fields = (r.fields || []).map((f) => {
    const out = {
      selector: f.selector,
      type: f.type,
      label: f.label,
      ...(f.required ? { required: true } : {}),
      value: f.value,
    };
    if (f.options) out.options = f.options.slice(0, 30);
    return out;
  });
  return {
    url: r.url,
    title: r.title,
    fields: fields.slice(0, 80),
    buttons: (r.buttons || []).filter((b) => b.text).slice(0, 30),
    links: (r.links || []).slice(0, 60),
  };
}

// Build an executor bound to a specific tab. Returns async (name, input) → JSON
// string (what the model sees back). Errors are returned, not thrown, so the
// model can recover (retry a different selector) instead of the turn aborting.
//
// `cdp` selects the action backend for fill/click: true → trusted events via
// chrome.debugger (high-reliability mode), false → synthetic events via
// chrome.scripting. Reading (inspect) always uses scripting. If a CDP action
// fails for a reason that the scripting path could still handle (e.g. the
// debugger couldn't attach), we fall back rather than fail the turn.
export function makePageToolExecutor(tabId, { cdp = false } = {}) {
  const doFill = cdp ? cdpFillForm : fillForm;
  const doClick = cdp ? cdpClickElement : clickElement;
  const doClickText = cdp ? cdpClickByText : clickByText;
  return async function execute(name, input) {
    try {
      if (name === 'inspect_page') {
        return JSON.stringify(compactInspect(await inspectForms(tabId)));
      }
      if (name === 'fill_form') {
        const fields = input?.fields || [];
        let results;
        let mode = cdp ? 'trusted' : 'synthetic';
        try {
          results = await doFill(tabId, fields);
        } catch (e) {
          if (cdp && e.code === 'no-debugger-perm') throw e; // surface, don't silently downgrade
          if (cdp) {
            // CDP couldn't attach/run — fall back, but make it LOUD so we can see it.
            console.warn('[chatpanel] CDP fill failed, falling back to synthetic:', e.message);
            results = await fillForm(tabId, fields);
            mode = 'synthetic (CDP failed: ' + e.message + ')';
          } else throw e;
        }
        const applied = results.filter((r) => r.applied !== false && r.ok).length;
        return JSON.stringify({ filled: applied, total: results.length, mode, results });
      }
      if (name === 'click_element') {
        try {
          return JSON.stringify(await doClick(tabId, input?.selector));
        } catch (e) {
          if (cdp && e.code !== 'no-debugger-perm') {
            console.warn('[chatpanel] CDP click failed, falling back to synthetic:', e.message);
            return JSON.stringify({ ...(await clickElement(tabId, input?.selector)), mode: 'synthetic (CDP failed: ' + e.message + ')' });
          }
          throw e;
        }
      }
      if (name === 'click_by_text') {
        try {
          return JSON.stringify(await doClickText(tabId, input?.text, input?.role || 'any'));
        } catch (e) {
          if (cdp && e.code !== 'no-debugger-perm') {
            console.warn('[chatpanel] CDP click_by_text failed, falling back to synthetic:', e.message);
            return JSON.stringify({ ...(await clickByText(tabId, input?.text, input?.role || 'any')), mode: 'synthetic (CDP failed: ' + e.message + ')' });
          }
          throw e;
        }
      }
      return JSON.stringify({ error: `unknown tool: ${name}` });
    } catch (e) {
      // Surface Pro-gate distinctly so the UI can upsell rather than show a raw error.
      return JSON.stringify({ error: e.message, upsell: e.upsell || undefined });
    }
  };
}
