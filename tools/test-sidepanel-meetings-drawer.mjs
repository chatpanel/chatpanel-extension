import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../extension/sidepanel.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../extension/sidepanel.css', import.meta.url), 'utf8');

assert.match(html, /id="meetings-modes"/, 'Meetings drawer should expose search mode controls.');
assert.match(html, /id="meetings-modes"[\s\S]*data-mode="smart"[^>]*>Best match</, 'Meetings drawer should have a Best match mode.');
assert.match(html, /id="meetings-modes"[\s\S]*data-mode="keyword"[^>]*>Exact text</, 'Meetings drawer should have an Exact text mode.');

assert.match(js, /meetingsView = \{[^}]*mode:\s*'smart'/, 'Meetings drawer should default to Best match mode.');
assert.match(js, /rankMeetingEntries\(index,\s*q,\s*details,\s*\{\s*mode:\s*meetingsView\.mode\s*\}\)/, 'Meetings drawer should pass its mode into ranked meeting search.');
assert.match(js, /meetings-modes/, 'Meetings drawer should wire the search mode buttons.');

assert.match(css, /\.meetings-modes/, 'Meetings drawer mode controls should be styled.');

console.log('sidepanel meetings drawer tests passed');
