import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyBatch } from '../src/domain.ts';
import { emptyState, syncedFixture, DEMO_IDS, FIXTURE_TIME } from '../src/fixtures.ts';
import { SpotOfflineReader, spotRisk } from '../src/spot.ts';
import { spotFixtureTransport } from '../src/spot-fixture.ts';
import { DummyCredentials } from '../src/credentials.ts';
import {sourceFingerprint} from './source-fingerprint.mjs';

const manifest=JSON.parse(readFileSync(new URL('../manifest.json',import.meta.url),'utf8'));
const {default:enable,SpotHoldingsTable,DeveloperWorkbench}=await import('../dist/addon.js');
let route;
await enable({onDisable:()=>{},api:{storage:{get:async()=>null},toast:{error:()=>{}}},router:{add:value=>{route=value;}}});
assert.equal(route.id,manifest.contributes.routes[0].id);
assert.equal(route.path,`/addons/${manifest.id}`);
const home=renderToStaticMarkup(createElement(route.component));
assert.ok(!home.includes("导入本地余额快照"));assert.ok(!home.includes("模拟同步"));assert.ok(home.includes("资产总览"));
const devContext={api:{secrets:{},network:{},storage:{}}};
const html=renderToStaticMarkup(createElement(DeveloperWorkbench,{ctx:devContext,initial:emptyState()}));
assert.equal((home.match(/type="password"/g)??[]).length,2);
assert.ok(home.includes(manifest.version));assert.ok(home.includes(sourceFingerprint().slice(0,8)));
assert.ok(html.includes('本快照入口不接收Key或Secret'));
assert.ok(html.includes('导入本地余额快照'));
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
  await enable({onDisable:()=>{},api:{storage:{get:async()=>JSON.stringify(state)},toast:{error:()=>assert.fail('有效样例不能恢复失败')}},router:{add:value=>{route=value;}}});
  const rendered=renderToStaticMarkup(createElement(DeveloperWorkbench,{ctx:devContext,initial:state}));
  assert.ok(rendered.includes(`当前有效且有价格的资产小计：<strong>${subtotal}</strong>`));
  assert.ok(rendered.includes(`当前有效已覆盖范围损失：${stress}`));
  assert.ok(rendered.includes(`快照时间：${time}`));
  assert.ok(rendered.includes('历史快照，可能已失效，不是当前实时资产'));
  if (state===failed) { assert.ok(rendered.includes('30000.00000000 USD')); assert.ok(rendered.includes('历史失效快照')); }
  if (state===partial || state===missing) assert.ok(rendered.includes('部分覆盖，仅包含当前成功且可估值范围'));
}
const bundle=readFileSync(new URL('../dist/addon.js',import.meta.url),'utf8');
// 旧入口含名为 import 的快照方法且实机加载失败，改名后通过；本包不需要动态 import。
// 守住已实机通过的语法形态；此检查仍不代替宿主安装验收。
assert.ok(!/\bimport\s*\(/.test(bundle),'入口不得包含动态 import 或同名方法，避免宿主加载歧义');
assert.ok(!/\blocalStorage\b|\bsessionStorage\b|\bfetch\s*\(/.test(bundle));
assert.deepEqual(manifest.permissions.find(p=>p.category==='secrets').functions,['set','get','delete']);
assert.deepEqual(manifest.permissions.map(p=>p.category),['secrets','files','network','accounts','snapshots','quotes','currency','settings']);
// 原生写入不得包含删除或组合重算能力。
assert.ok(!manifest.permissions.find(p=>p.category==='snapshots').functions.includes('delete'));
assert.ok(!manifest.permissions.some(p=>['portfolio','activities','market-data'].includes(p.category)));
assert.deepEqual(manifest.network,{allowedHosts:['data-api.binance.vision','api.binance.com']});
assert.ok(!/WRISKDEMO_BTC/.test(bundle));
assert.ok(html.includes('真实市场报价 + 模拟持仓'));
assert.ok(html.includes('数量固定为 BTC'));
assert.ok(html.includes('采集时间（不是成交时间）'));
assert.ok(html.includes('一个 Binance 账号'));
assert.ok(html.includes('整个 Binance 总资产不可用'));
const fakeValues=new Map();
const credentials=new DummyCredentials({get:async k=>fakeValues.get(k)??null,set:async(k,v)=>fakeValues.set(k,v),delete:async k=>fakeValues.delete(k)});
await credentials.save(1);
const now=Date.parse('2026-10-14T00:00:00Z');let scenario='multi';
const reader=new SpotOfflineReader(credentials,spotFixtureTransport(()=>scenario,()=>now),()=>now);
for(const value of ['multi','multi-missing']) {
  scenario=value;await reader.sync();const state=reader.getState(), report=spotRisk(state,now);
  const rows=renderToStaticMarkup(createElement(SpotHoldingsTable,{state,report}));
  for(const code of ['BTC','ETH','BNB','SOL','DOGE','USDT'])assert.ok(rows.includes(`Spot / ${code} /`));
  assert.ok(rows.includes('53.91%') || value==='multi-missing');
  assert.ok(rows.includes('4000.00000000'));assert.ok(rows.includes('回落 20%'));
  if(value==='multi-missing'){assert.ok(rows.includes('缺价格'));assert.ok(rows.includes('NOPAIR'));assert.ok(rows.includes('不可用'));}
}
const stale=reader.getState();
const staleRows=renderToStaticMarkup(createElement(SpotHoldingsTable,{state:stale,report:spotRisk(stale,now+60_001)}));
assert.ok(staleRows.includes('历史失效'));assert.ok(!staleRows.includes('53.91%'));assert.ok(staleRows.includes('Spot / ETH /'));
assert.ok(!html.includes('导入模拟持仓并读回核对'));assert.ok(html.includes('真实认证请求阻断'));
console.log('编译入口、6种旧状态与3种离线列表通过；公开行情标签/唯一主机核对通过。静态检查不执行网络，不是实机测试。');
