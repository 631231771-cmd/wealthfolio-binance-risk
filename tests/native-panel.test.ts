// 原生同步面板的静态渲染：不点击、不写入，只验证口径与危险操作的门槛。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {createRequire} from 'node:module';
const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:ReturnType<typeof createElement>)=>string};
import {spotSnapshot,spotRisk} from '../src/spot';
import {NativePanel} from '../src/native-panel';
import {nativeAccountKey} from '../src/native-sync';
import type {DirectSpot} from '../src/direct-spot';
import type {NativeHostBridge} from '../src/native-host';
import type {PortfolioState} from '../src/domain';

const NOW=Date.parse('2026-10-19T10:00:00Z'),AT=new Date(NOW).toISOString(),KEY=nativeAccountKey('123456789');
function value(){
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:[{asset:'BTC',free:'0.01',locked:'0'},{asset:'USDT',free:'100',locked:'0'}]},'external',AT,AT);
 for(const p of snapshot.positions)if(p.asset.code==='BTC')p.price={value:'65000',currency:'USDT',asOf:AT,source:'external:test'};
 if(snapshot.positions.find(p=>p.asset.code==='USDT'))snapshot.positions.find(p=>p.asset.code==='USDT')!.price={value:'1',currency:'USDT',asOf:AT,source:'unit:USDT/USDT'};
 const state:PortfolioState={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:AT}}};
 return {state,report:spotRisk(state,NOW)};
}
const reader=(v:ReturnType<typeof value>)=>({valued:()=>v,getAccountKey:()=>KEY} as unknown as DirectSpot);
const host=()=>({
 listAccounts:async()=>[],createAccount:async()=>{throw new Error('no');},checkImport:async()=>({existingDates:[],symbols:[],validationErrors:[]}),
 saveSnapshot:async()=>{},listSnapshots:async()=>[],getByDate:async()=>[],updateQuote:async()=>{},
 baseCurrency:async()=>'USD',usdtRate:async()=>0.9998,today:()=>'2026-10-19'
} as NativeHostBridge);

test('无宿主时明确说明原生写入不可用，不展示可点击的写入按钮',()=>{
 const html=renderToStaticMarkup(createElement(NativePanel,{reader:reader(value())}));
 assert.match(html,/当前环境没有宿主 API/);
 assert.ok(!html.includes('写入原生账户'));
});
test('有宿主时展示能力检测、成本录入与未确认的写入按钮',()=>{
 const html=renderToStaticMarkup(createElement(NativePanel,{reader:reader(value()),host:host()}));
 assert.ok(html.includes('检测宿主能力'));
 assert.ok(html.includes('生成导入预览'));
 assert.ok(html.includes('成本基础'));
 assert.ok(html.includes('成本尚未核实'));
 assert.ok(html.includes('BTC 单位成本'));
 // 未生成预览前不得出现写入入口
 assert.ok(!html.includes('写入原生账户'));
});
test('面板展示成本覆盖口径，未知成本保留为未知',()=>{
 const v=value();
 const html=renderToStaticMarkup(createElement(NativePanel,{reader:reader(v),host:host(),onCosts:()=>{}}));
 assert.match(html,/尚未录入任何成本/);
 assert.match(html,/未知/);
});
