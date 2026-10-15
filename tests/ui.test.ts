import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {createRequire} from 'node:module';
const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:ReturnType<typeof createElement>)=>string};
import {DirectSpotPanel,describeDiagnostic} from '../src/direct-panel';
import type {DirectSpot} from '../src/direct-spot';
import type {BinanceCredentials} from '../src/credentials';
import {spotSnapshot,spotShock} from '../src/spot';
import {assetKey,calculateRisk,type PortfolioState} from '../src/domain';
const at='2026-10-15T00:00:00.000Z';
function render(state:PortfolioState,connected:boolean){
 const shocks=Object.fromEntries(Object.values(state.snapshots).flatMap(s=>s.positions.map(p=>[assetKey(p.asset),spotShock(p.asset.code)])));
 const report=calculateRisk(state,'USDT',[],shocks,{now:at,balanceMaxAgeMs:360000,priceMaxAgeMs:360000,fxMaxAgeMs:360000});
 const reader={valued:()=>({state,report}),getStatus:()=>({connected,busy:false,auto:false,success:connected,nextDue:0,visible:true}),getDiagnostic:()=>({stage:connected?'complete':'idle',code:connected?'OK':'NOT_CONNECTED'})} as unknown as DirectSpot;
 return renderToStaticMarkup(createElement(DirectSpotPanel,{reader,credentials:{} as BinanceCredentials}));
}
function sample(){const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:[{asset:'BTC',free:'0.001',locked:'0'},{asset:'USDT',free:'15',locked:'0'},{asset:'NOPAIR',free:'2',locked:'0'}]},'external',at,at);for(const p of snapshot.positions)if(p.asset.code!=='NOPAIR')p.price={value:p.asset.code==='BTC'?'50000':'1',currency:'USDT',asOf:at,source:'external:test'};return {schemaVersion:1 as const,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready' as const,attemptedAt:at}}};}
test('主面板空态、连接设置默认关闭，保留明确本人确认项',()=>{
 const html=render({schemaVersion:1,accounts:[],snapshots:{},statuses:{}},false);
 assert.ok(html.includes('币安资产监控'));assert.ok(html.includes('Spot 已定价资产'));assert.ok(html.includes('连接后显示真实Spot持仓'));
 assert.match(html,/<details class="connection-settings">/);assert.ok(!html.includes('<details class="connection-settings" open'));
 assert.equal((html.match(/type="password"/g)??[]).length,2);assert.ok(html.includes('本人确认并首次查询'));assert.ok(html.includes('签名URL可能进入本机宿主错误日志'));
});
test('真实持仓简表不混入开发样例，成功连接不渲染凭据输入',()=>{
 const html=render(sample(),true);assert.ok(html.includes('65.00'));assert.ok(html.includes('10.00'));assert.ok(html.includes('NOPAIR'));assert.ok(html.includes('缺少有效价格'));assert.ok(html.includes('0.001'));
 assert.ok(!html.includes('type="password"'));for(const text of ['WRISKDEMO','37100','30000','导入本地余额快照'])assert.ok(!html.includes(text));
});
test('界面区分有效零和失效历史，不显示失效资产为0',()=>{
 const state=sample();state.snapshots[state.accounts[0].id].positions=[];assert.ok(render(state,true).includes('本次成功快照余额为零。'));assert.ok(render(state,true).includes('0.00'));
 const stale=sample();stale.statuses[stale.accounts[0].id].state='failed' as any;const html=render(stale,false);assert.ok(html.includes('保留上次持仓'));assert.ok(html.includes('历史失效'));assert.ok(html.includes('aria-label="不可用"'));
});
test('错误阶段与安全码明确区分，未知码不透传任意文本',()=>{
 const cases=[['permissions','READ_ONLY_REJECTED','只读权限'],['identity','UID_MISMATCH','UID'],['balance','SPOT_TIMEOUT','超时'],['disconnected','USER_DISCONNECTED','断开']] as const;
 for(const [stage,code,text] of cases){const value=describeDiagnostic({stage,code});assert.equal(value.code,code);assert.ok(value.text.includes(text));}
 const unknown=describeDiagnostic({stage:'balance',code:'https://bad/?signature=SECRET'});assert.equal(unknown.code,'UNKNOWN');assert.ok(!JSON.stringify(unknown).includes('SECRET'));
});
