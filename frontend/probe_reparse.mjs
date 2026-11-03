// 三维预览层「重新解析」入口的浏览器探针（配套 scripts/accept_reparse_ui.py）。
// 用法：node probe_reparse.mjs check <pid>   只截图取值，不点按钮（不动数据）
//       node probe_reparse.mjs click <pid>   真点一次，等它跑完并回到三维预览
//       node probe_reparse.mjs ask <pid>     已确认项目：先点取消（不许替换），再点确认执行
import { chromium } from 'playwright-core';

const BASE = process.env.GUANGLV_BASE || 'http://127.0.0.1:8000';
const CDP = process.env.CDP || 'http://127.0.0.1:9333';
const mode = process.argv[2] || 'check';
const pid = process.argv[3];
if (!pid) { console.error('用法: node probe_reparse.mjs check|click|ask <pid>'); process.exit(2); }

const b = await chromium.connectOverCDP(CDP);
const page = await b.contexts()[0].newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const errs = [];
let timedOut = false;
page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));

async function openLayer() {
  await page.goto(`${BASE}/?project=${pid}&spacePreview=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.space-preview-panel', { timeout: 30000 });
  await page.waitForSelector('.space-preview-stale', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page.evaluate(() => {
    const bar = document.querySelector('.space-preview-stale');
    const btn = document.querySelector('.space-preview-reparse');
    const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    return {
      barShown: vis(bar),
      barText: bar ? bar.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) : '',
      btnLabel: btn ? (btn.textContent || '').trim() : '',
      btnRect: btn && vis(btn) ? `${Math.round(btn.getBoundingClientRect().width)}x${Math.round(btn.getBoundingClientRect().height)}` : '不可见',
      tabs: [...document.querySelectorAll('.space-preview-tabs button')].map((x) => x.textContent.trim()).join('/'),
      phase: document.querySelector('.space-preview-panel')?.dataset.phase,
      title: document.querySelector('.space-preview-panel h3')?.textContent,
    };
  });
}

console.log('--- 打开三维预览层 ---');
let s = await openLayer();
console.log(JSON.stringify(s, null, 1));
await page.screenshot({ path: `/tmp/reparse_${mode}_before.png` });

if (mode === 'click') {
  await page.click('.space-preview-reparse');
  await page.waitForSelector('.space-preview-stale', { state: 'detached', timeout: 240000 }).catch(() => {});
  await page.waitForTimeout(2500);
  s = await openLayer();
  console.log('--- 点完之后 ---');
  console.log(JSON.stringify(s, null, 1));
  await page.screenshot({ path: '/tmp/reparse_click_after.png' });
}
if (mode === 'ask') {
  // 同源带 cookie 直接读后端状态：省得把 design 从 DOM 里抠出来。
  const state = () => page.evaluate(async (p) => {
    const j = await (await fetch(`/api/projects/${p}`)).json();
    const d = j.design || {};
    const ids = new Set((d.rooms || []).map((r) => r.id));
    const hang = (arr) => (arr || []).filter((x) => x.roomId && !ids.has(x.roomId)).length;
    return {
      status: (d.spaceDefinition || {}).status || '',
      rooms: (d.rooms || []).length,
      names: (d.rooms || []).slice(0, 4).map((r) => r.name).join('/'),
      fixtures: (d.fixtures || []).length,
      unowned: (d.fixtures || []).filter((f) => !f.roomId).length,
      dangling: hang(d.fixtures) + hang(d.devices) + hang(d.furniture),
      openings: (d.openings || []).length,
    };
  }, pid);
  const modal = () => page.evaluate(() => {
    const m = document.querySelector('.confirm-modal-mask');
    if (!m) return { shown: false };
    const overlay = document.querySelector('.space-preview-overlay');
    return {
      shown: m.getBoundingClientRect().width > 0,
      zIndex: getComputedStyle(m).zIndex,
      barZIndex: overlay ? getComputedStyle(overlay).zIndex : '',
      title: document.querySelector('.confirm-modal h3')?.textContent || '',
      detail: document.querySelector('.confirm-modal-detail')?.textContent || '',
      buttons: [...document.querySelectorAll('.confirm-modal-actions button')].map((x) => x.textContent.trim()).join('/'),
    };
  });

  await page.click('.space-preview-reparse');
  await page.waitForSelector('.confirm-modal-mask', { timeout: 8000 });
  console.log('--- 弹出确认框 ---');
  console.log(JSON.stringify(await modal(), null, 1));
  await page.screenshot({ path: '/tmp/reparse_ask_dialog.png' });

  await page.click('.confirm-modal-actions .btn:not(.danger)');   // 取消＝什么都不做
  await page.waitForTimeout(1500);
  console.log('--- 点了取消之后 ---');
  console.log(JSON.stringify({ ...(await state()), modalGone: !(await modal()).shown }, null, 1));

  await page.click('.space-preview-reparse');
  await page.waitForSelector('.confirm-modal-mask', { timeout: 8000 });
  await page.click('.confirm-modal-actions .btn.danger');         // 确认执行
  await page.waitForFunction(async (p) => {
    const j = await (await fetch(`/api/lighting3d/${p}/job`)).json();
    if (j.state === 'running') return false;
    const d = (await (await fetch(`/api/projects/${p}`)).json()).design || {};
    return (d.spaceDefinition || {}).status !== 'confirmed';
  }, pid, { timeout: 300000, polling: 3000 }).catch(() => { timedOut = true; });
  await page.waitForTimeout(1500);
  console.log('--- 点了确认执行之后 ---');
  console.log(JSON.stringify(await state(), null, 1));
  s = await openLayer();
  console.log('--- 重开这一层 ---');
  console.log(JSON.stringify(s, null, 1));
  await page.screenshot({ path: '/tmp/reparse_ask_after.png' });
}
console.log('pageerror:', errs.length ? errs.join(' ;; ') : 0);
console.log('reparseTimedOut:', timedOut);
await page.close();
// 探针自己要有结论：页面报错或等不到「已重新解析」都算失败，不能退出 0 冒充通过
process.exit(errs.length || timedOut ? 1 : 0);
