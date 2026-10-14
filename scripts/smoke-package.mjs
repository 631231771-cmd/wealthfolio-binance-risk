import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyBatch } from '../src/domain.ts';
import { emptyState, syncedFixture, DEMO_IDS, FIXTURE_TIME } from '../src/fixtures.ts';

const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
const {default:enable}=await import('../dist/addon.js');
let route;
await enable({api:{storage:{get:async()=>null},toast:{error:()=>{}}},router:{add:value=>{route=value;}}});
assert.equal(route.id,manifest.contributes.routes[0].id);
assert.equal(route.path,`/addons/${manifest.id}`);
const html=renderToStaticMarkup(createElement(route.component));
assert.ok(html.includes('Binance Stocks'));assert.ok(html.includes('unsupported'));
assert.ok(html.includes('模拟同步'));assert.ok(html.includes('不可用'));
// 实际编译入口的显示回归；不把静态渲染当作 Windows 实测。
const failed=applyBatch(syncedFixture(),DEMO_IDS,[],FIXTURE_TIME);
const partial=syncedFixture(); partial.statuses['demo-spot'].state='failed';
const missing=syncedFixture(); delete missing.snapshots['demo-spot'].positions[0].price;
const zero=syncedFixture(); Object.values(zero.snapshots).forEach(s=>s.positions=[]);
const cases=[
  [emptyState(),'不可用','不可用','无'],
  [failed,'不可用','不可用',FIXTURE_TIME],
  [partial,'6000.00000000 USD','1100.00000000 USD',FIXTURE_TIME],
  [missing,'10000.00000000 USD','1500.00000000 USD',FIXTURE_TIME],
  [zero,'0.00000000 USD','0.00000000 USD',FIXTURE_TIME],
  [syncedFixture(),'30000.00000000 USD','5500.00000000 USD',FIXTURE_TIME]
];
for (const [state,subtotal,stress,time] of cases) {
  await enable({api:{storage:{get:async()=>JSON.stringify(state)},toast:{error:()=>assert.fail('有效样例不能恢复失败')}},router:{add:value=>{route=value;}}});
  const rendered=renderToStaticMarkup(createElement(route.component));
  assert.ok(rendered.includes(`当前有效且有价格的资产小计：<strong>${subtotal}</strong>`));
  assert.ok(rendered.includes(`当前有效已覆盖范围损失：${stress}`));
  assert.ok(rendered.includes(`快照时间：${time}`));
  assert.ok(rendered.includes('历史快照，可能已失效，不是当前实时资产'));
  if (state===failed) { assert.ok(rendered.includes('30000.00000000 USD')); assert.ok(rendered.includes('历史失效快照')); }
  if (state===partial || state===missing) assert.ok(rendered.includes('部分覆盖，仅包含当前成功且可估值范围'));
}
const bundle=readFileSync(new URL('../dist/addon.js',import.meta.url),'utf8');
assert.ok(!/\blocalStorage\b|\bsessionStorage\b|\bfetch\s*\(/.test(bundle));
assert.deepEqual(manifest.permissions.find(p=>p.category==='secrets').functions,['set','get','delete']);
assert.deepEqual(manifest.permissions.map(p=>p.category),['secrets','files']);
assert.equal(manifest.network,undefined);
assert.ok(!/api\.binance\.com|\.network\.request|WRISKDEMO_BTC/.test(bundle));
assert.ok(!html.includes('导入模拟持仓并读回核对'));assert.ok(html.includes('真实认证请求阻断'));
console.log('编译入口及 6 种风险状态静态显示通过，路由与清单一致，无浏览器存储或直接 fetch；不是官方桌面安装测试。');
