import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 120; i++) {
    const value = await check();
    if (value) return value;
    await delay(75);
  }
  throw new Error('Timeout: ' + label);
}

const windows = process.platform === 'win32';
const python = process.env.UNIFOOD_TEST_PYTHON ?? (windows ? '.venv/Scripts/python.exe' : 'python3');
const chromeBinary = process.env.UNIFOOD_TEST_CHROME ??
  (windows ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'google-chrome');
const server = spawn(python, ['tests/mobile-verify-server.py'], {windowsHide: true, stdio: 'inherit'});
const origin = 'http://127.0.0.1:5059';
const profile = await mkdtemp(join(tmpdir(), 'unifood-mobile-'));
const chrome = spawn(chromeBinary,
  ['--headless=new', '--remote-debugging-port=9228', '--no-first-run', '--user-data-dir=' + profile, 'about:blank'],
  {windowsHide: true, stdio: 'ignore'});
let socket;
try {
  await until(async () => (await fetch(origin).catch(() => null))?.ok, 'Flask');
  const target = await until(async () => {
    const tabs = await fetch('http://127.0.0.1:9228/json/list').then(response => response.json()).catch(() => []);
    return tabs.find(tab => tab.type === 'page');
  }, 'Chrome');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once: true});
    socket.addEventListener('error', reject, {once: true});
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', ({data}) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++id, {resolve, reject});
    socket.send(JSON.stringify({id, method, params}));
  });
  async function run(expression) {
    const response = await send('Runtime.evaluate', {expression, returnByValue: true});
    if (response.exceptionDetails) throw Error(response.exceptionDetails.exception?.description ?? expression);
    return response.result.value;
  }
  const ready = () => run("document.querySelector('#search')?.disabled === false && !!document.querySelector('.card')");
  const viewport = width => send('Emulation.setDeviceMetricsOverride', {width, height: 740, deviceScaleFactor: 1, mobile: width <= 730});
  const visible = selector => run(`!!document.querySelector(${JSON.stringify(selector)})?.getClientRects().length`);
  const tap = async selector => {
    const point = await run(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      element.scrollIntoView({block: 'center'});
      const {x,y,width,height} = element.getBoundingClientRect();
      return {x:x+width/2,y:y+height/2};
    })()`);
    await send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [point]});
    await send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  };
  const select = (selector, value) => run(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.value = ${value};
    element.dispatchEvent(new Event('change', {bubbles:true}));
  })()`);
  const noOverflow = () => run('document.documentElement.scrollWidth === innerWidth');
  await send('Runtime.enable');
  await send('Emulation.setTouchEmulationEnabled', {enabled: true});
  await viewport(320);
  await send('Page.navigate', {url: origin});
  await until(ready, 'initial results');
  for (const width of [320, 375, 430]) {
    await viewport(width);
    assert.equal(await run('innerWidth'), width);
    assert.equal(await visible('#place-results'), true);
    assert.equal(await visible('#place-map'), false);
    assert.equal(await noOverflow(), true);
    assert.equal(await run("['#show-map','#university','#break','#time','.filters button','.place-title','.heart','.locate-place'].every(s => document.querySelector(s).offsetHeight >= 44)"), true);
    await tap('#show-map');
    assert.equal(await visible('#place-map'), true);
    assert.equal(await visible('#place-results'), false);
    assert.equal(await noOverflow(), true);
    await tap('[data-view=list]');
    console.log(width + 'px: list, map, touch targets and no horizontal overflow');
  }
  await viewport(375);
  await tap('.place-title');
  assert.equal(await visible('#detail[open]'), true);
  assert.equal(await visible('#place-map'), false);
  await tap('#detail-check-in');
  assert.equal(await visible('#check-in[open]'), true);
  await tap('.check-in-close');
  const selectedTitle = await run("document.querySelector('.place-title').textContent");
  await tap('[data-locate]');
  assert.equal(await visible('#place-map'), true);
  assert.equal(await run("document.querySelector('#show-map').getAttribute('aria-pressed')"), 'true');
  assert.equal(await run("document.querySelector('.map-place-detail').textContent"), selectedTitle);
  await until(() => run(`(() => {
    const marker = document.querySelector('.load-map-icon.is-selected');
    marker.scrollIntoView({block: 'center'});
    const {x,y,width,height} = marker.getBoundingClientRect();
    return marker.contains(document.elementFromPoint(x+width/2,y+height/2));
  })()`), 'selected marker reachable');
  await tap('.load-map-icon.is-selected');
  await until(() => visible('.leaflet-popup .popup-check-in'), 'marker popup');
  await tap('.map-reset');
  const scale = await run("document.querySelector('.leaflet-image-layer').style.width");
  await tap('.leaflet-control-zoom-in');
  await until(() => run(`document.querySelector('.leaflet-image-layer').style.width !== ${JSON.stringify(scale)}`), 'map zoom');
  assert.equal(await run("document.querySelector('.map-place-detail').textContent"), selectedTitle);
  await tap('[data-view=list]');
  await select('#university', "'mgsu'");
  await until(ready, 'MGSU results');
  await select('#time', "document.querySelector('#time').options[1].value");
  await until(ready, 'time results');
  await select('#visit-date', "document.querySelector('#visit-date').options[1].value");
  await until(ready, 'tomorrow results');
  await tap('.card [data-plan]:enabled');
  await until(() => run("document.querySelector('#plan-status').textContent.includes('План сохранён')"), 'save plan');
  const cancelSelector = await run(`(() => {
    const button = [...document.querySelectorAll('[data-plan]')].find(b => b.textContent === 'Отменить план');
    return '[data-plan="' + button.dataset.plan + '"]';
  })()`);
  assert.equal(await run(`document.querySelector(${JSON.stringify(cancelSelector)}).closest('.kit-place-card').querySelector('[data-place-status]').textContent.startsWith('План на завтра')`), true);
  await tap(cancelSelector);
  await until(() => run("document.querySelector('#plan-status').textContent === 'План отменён.'"), 'cancel plan');
  await tap('[data-category=favorites]');
  assert.equal(await visible('#empty'), true);
  const searchState = await run("['#university','#time','#visit-date'].map(id=>document.querySelector(id).value)");
  await tap('#show-map');
  assert.deepEqual(await run("['#university','#time','#visit-date'].map(id=>document.querySelector(id).value)"), searchState);
  await tap('[data-view=list]');
  assert.equal(await run("document.querySelector('[data-category=favorites]').getAttribute('aria-pressed')"), 'true');
  await tap('#show-map');
  console.log('375px: detail, check-in, locate, zoom, university, time, tomorrow, save and cancel');
  await viewport(1280);
  assert.equal(await visible('#workspace-switch'), false);
  assert.equal(await visible('#place-results'), true);
  assert.equal(await visible('#place-map'), true);
  assert.equal(await run("getComputedStyle(document.querySelector('#workspace')).gridTemplateColumns.split(' ').length"), 12);
  assert.equal(await run("document.querySelector('#place-results').getBoundingClientRect().right < document.querySelector('#place-map').getBoundingClientRect().left"), true);
  assert.deepEqual(await run("['#university','#time','#visit-date'].map(id=>document.querySelector(id).value)"), searchState);
  await tap('[data-category=all]');
  assert.equal(await visible('.card'), true);
  assert.deepEqual(errors, []);
  console.log('1280px: both columns, retained search, favorites filter and no JavaScript exceptions');

  for (const [width, columns] of [[1280, 4], [375, 2]]) {
    await viewport(width);
    await send('Page.navigate', {url: origin + '/?check-in-test=' + width});
    await until(ready, 'initial cards for check-in');
    assert.equal(await run("document.querySelector('#cards .kit-place-card').querySelectorAll('[data-place-status]').length"), 1);
    const placeId = await run("document.querySelector('#cards .place-title').dataset.detail");
    await tap('#cards .place-title');
    await tap('#detail-check-in');
    assert.equal(await visible('#check-in.kit-check-in[open]'), true);
    assert.equal(await run("document.querySelector('#check-in-submit').disabled"), true);
    assert.equal(await run("getComputedStyle(document.querySelector('.kit-check-in__options')).gridTemplateColumns.split(' ').length"), columns);
    await tap('#check-in label:nth-child(2)');
    assert.equal(await run("document.querySelector('#check-in input:checked').value"), '5-10');
    assert.equal(await run("getComputedStyle(document.querySelector('#check-in input:checked')).clipPath"), 'inset(50%)');
    await tap('#check-in-submit');
    await until(() => run("document.querySelector('#check-in-status').textContent.includes('Сообщение сохранено')"), 'check-in saved');
    await tap('.check-in-close');
    assert.equal(await run(`[...document.querySelectorAll('#cards .kit-place-card')].find(card => card.querySelector('[data-detail]').dataset.detail === ${JSON.stringify(placeId)}).querySelector('[data-place-status]').textContent.includes('7.5')`), true);
    assert.deepEqual(errors, []);
    console.log(width + 'px: shared place card and real check-in submission');
  }
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
}
