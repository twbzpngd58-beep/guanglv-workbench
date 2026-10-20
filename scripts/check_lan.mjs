// Usage: node scripts/check_lan.mjs http://<server-lan-ip>:8000
import { chromium } from '../frontend/node_modules/playwright/index.mjs';
const base = process.argv[2];
if (!base) throw new Error('Provide the actual LAN HTTP origin as the first argument.');
const browser = await chromium.launch({executablePath:chromium.executablePath(),args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
let id;
try {
 const created = await page.request.post(`${base}/api/projects`, {data:{name:'LAN · 临时访问验收'}});
 if (!created.ok()) throw new Error(await created.text());
 const project=await created.json(); id=project.id;
 await page.goto(`${base}/?project=${id}`);
 await page.getByRole('button',{name:'新增房间',exact:true}).click();
 await page.getByLabel('房间名称',{exact:true}).fill('局域网可编辑房间');
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.locator('.busy-shield').waitFor({state:'hidden'});
 await page.waitForFunction(()=>document.querySelector('.save-state')?.textContent?.includes('已保存至本地'));
 await page.reload();
 await page.getByRole('button',{name:/局域网可编辑房间/}).waitFor();
 const stored=await (await page.request.get(`${base}/api/projects/${id}`)).json();
 if(stored.design.rooms[0]?.name!=='局域网可编辑房间')throw new Error('Persisted design mismatch');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log(JSON.stringify({ok:true,origin:base,secureContext:await page.evaluate(()=>isSecureContext),pageErrors:errors,checks:['HTTP 页面访问','新增房间','本地保存','刷新后数据保留']},null,2));
} finally {
 if(id)await page.request.delete(`${base}/api/projects/${id}`);
 await browser.close();
}
