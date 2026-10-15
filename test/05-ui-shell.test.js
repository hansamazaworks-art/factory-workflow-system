// Phase 2 app shell: works offline, is navigable, and renders cleanly.
const { resetDb } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../src/app');
const { login } = require('./helpers/agent');

before(resetDb);
after(() => require('../src/config/db').end());

test('no page asks the internet for anything (offline LAN): fonts and scripts are local', async () => {
  const prod = await login(app, 'prod1');
  for (const url of ['/login', '/production/dashboard', '/production/floor']) {
    const html = (await (url === '/login' ? request(app) : prod).get(url)).text;
    assert.doesNotMatch(html, /(src|href)="https?:\/\//, url);
  }
  for (const asset of ['/fonts/fonts.css', '/fonts/ibm-plex-sans-latin-400-normal.woff2', '/js/app.js', '/css/style.css', '/favicon.svg']) {
    assert.equal((await request(app).get(asset)).status, 200, asset);
  }
});

test('shell has skip link, labelled navigation, breadcrumbs and the current page marked', async () => {
  const prod = await login(app, 'prod1');
  const html = (await prod.get('/production/floor')).text;
  assert.match(html, /class="skip-link" href="#main"/);
  assert.match(html, /<nav id="sidebar" class="sidebar" aria-label="Main navigation">/);
  assert.match(html, /<nav class="breadcrumbs" aria-label="Breadcrumb">/);
  assert.match(html, /href="\/production\/floor"[^>]*\s+aria-current="page"/);
  assert.match(html, /<span aria-current="page">Live Floor<\/span>/);
  assert.match(html, /<main id="main"/);
});

test('the sidebar shows exactly the departments each role may open', async () => {
  // From the approved permission matrix (Phase 1, section F).
  const expected = {
    prod1: ['/account/', '/production/'],
    maint1: ['/account/', '/maintenance/'],
    tool1: ['/account/', '/toolroom/'],
    purch1: ['/account/', '/purchasing/'],
    boss1: ['/account/', '/maintenance/', '/management/'],
    mmgr1: ['/account/', '/maintenance/'],
    plant1: ['/account/', '/maintenance/'],
    admin1: ['/account/', '/maintenance/', '/management/', '/production/', '/purchasing/', '/toolroom/']
  };
  for (const [user, depts] of Object.entries(expected)) {
    const a = await login(app, user);
    const html = (await a.get(a.home)).text;
    const nav = html.slice(html.indexOf('<nav id="sidebar"'), html.indexOf('</nav>', html.indexOf('<nav id="sidebar"')));
    const seen = [...new Set([...nav.matchAll(/href="(\/[a-z-]+\/)/g)].map(m => m[1]))].sort();
    assert.deepEqual(seen, depts, user);
  }
});

test('no escaped HTML entities leak into pages as text', async () => {
  const prod = await login(app, 'prod1');
  const maint = await login(app, 'maint1');
  await prod.post('/production/job-orders', { machine_name: 'IM-01', location: 'Line 1', problem_desc: 'Entity check', priority: 'low' });
  for (const [a, url] of [[prod, '/production/dashboard'], [prod, '/production/floor'], [prod, '/production/job-orders/1'], [maint, '/maintenance/job-orders/1']]) {
    const html = (await a.get(url)).text;
    assert.doesNotMatch(html, /&amp;(middot|mdash|rarr|larr|nbsp);/, url);
  }
});

test('idle machines are shown as neutral, not as a warning', async () => {
  const css = (await request(app).get('/css/style.css')).text;
  assert.match(css, /\.pill\.idle \{ background: var\(--graySoft\)/);
  assert.doesNotMatch(css, /\.pill\.idle,[^{]*\{[^}]*amber/);
});
