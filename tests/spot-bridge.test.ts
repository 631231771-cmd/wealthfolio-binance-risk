import test from 'node:test';
import assert from 'node:assert/strict';
import {SpotBridge} from '../src/spot-bridge';
import {PublicMarketReader} from '../src/public-market';
import {multiExchangeInfo,MULTI_PRICES} from '../src/spot-fixture';
const now=Date.parse('2026-10-15T00:00:00Z'),at=new Date(now).toISOString();
const empty={schemaVersion:1 as const,accounts:[],snapshots:{},statuses:{}};
const dto=(extra={})=>({format:'wrisk-spot-snapshot',version:1,mode:'external',uid:'900000001',status:'ready',startedAt:at,endedAt:at,balances:[{asset:'BTC',free:'0.001',locked:'0'},{asset:'ETH',free:'0.02',locked:'0'},{asset:'USDT',free:'12',locked:'3'},{asset:'NOPAIR',free:'2',locked:'0'}],...extra});
async function quotes(){const reader=new PublicMarketReader({request:async r=>({status:200,headers:{},body:JSON.stringify(r.url.includes('/time')?{serverTime:now}:r.url.includes('/exchangeInfo')?multiExchangeInfo():Object.entries(MULTI_PRICES).map(([s,p])=>({symbol:s+'USDT',price:p})))})},()=>now);await reader.refresh();return reader.getState();}
test('辅助快照→明确公开价格→仅真实数量估值；重复替换不增仓',async()=>{
  const b=new SpotBridge(),text=JSON.stringify(dto());b.import(text,now);const q=await quotes();
  for(let i=0;i<2;i++){b.import(text,now);const v=b.valued(q,now);assert.equal(v.report.coveredSubtotal,'115.00000000');assert.equal(v.report.stressLoss,'20.00000000');assert.equal(v.report.total,null);assert.equal(v.report.coverage,'partial');assert.equal(v.report.unpricedPositionCount,1);assert.equal(Object.values(v.state.snapshots)[0].positions.length,4);assert.equal(Object.values(v.state.snapshots)[0].dataMode,'external');}
});
test('fixture始终标记虚构，不与external或其他UID合并',async()=>{
 const b=new SpotBridge();b.import(JSON.stringify(dto({mode:'fixture'})),now);assert.equal(Object.values(b.valued(await quotes(),now).state.snapshots)[0].dataMode,'fixture');assert.throws(()=>b.import(JSON.stringify(dto()),now));assert.equal(b.valued(empty,now).report.coveredSubtotal,null);
 const c=new SpotBridge();c.import(JSON.stringify(dto()),now);assert.throws(()=>c.import(JSON.stringify(dto({uid:'42'})),now));assert.equal(c.getState().accounts.length,1);
});
test('失败/非法导入保留最近数量并使当前不可用，不用0替代',async()=>{
 const b=new SpotBridge(),q=await quotes();b.import(JSON.stringify(dto()),now);b.import(JSON.stringify(dto({status:'failed',balances:[]})),now);assert.equal(b.valued(q,now).report.coveredSubtotal,null);assert.equal(b.valued(q,now).report.lastKnownSubtotal,'115.00000000');assert.equal(Object.values(b.getState().snapshots)[0].positions[0].quantity,'0.001');
 b.import(JSON.stringify(dto()),now);assert.throws(()=>b.import('not json',now));assert.equal(b.valued(q,now).report.stressLoss,null);
 const first=new SpotBridge();first.import(JSON.stringify(dto({status:'failed',balances:[]})),now);assert.equal(first.valued(q,now).report.lastKnownSubtotal,null);
});
test('余额/价格时效，重新导入旧快照不能刷新时间',async()=>{
 const b=new SpotBridge(),q=await quotes();b.import(JSON.stringify(dto()),now);assert.equal(b.valued(q,now+60001).report.coveredSubtotal,null);assert.throws(()=>b.import(JSON.stringify(dto()),now+60001));assert.throws(()=>new SpotBridge().import(JSON.stringify(dto()),now-1));
 const c=new SpotBridge();c.import(JSON.stringify(dto({startedAt:new Date(now+120001).toISOString(),endedAt:new Date(now+120001).toISOString()})),now+120001);assert.equal(c.valued(q,now+120001).report.coveredSubtotal,'15.00000000');assert.equal(c.valued(q,now+120001).report.unpricedPositionCount,3);
});
test('空成功是真实零；无报价保留数量和缺价',()=>{
 const b=new SpotBridge();b.import(JSON.stringify(dto({balances:[]})),now);assert.equal(b.valued(empty,now).report.coveredSubtotal,'0.00000000');assert.equal(b.valued(empty,now).report.coverage,'complete');
 const c=new SpotBridge();c.import(JSON.stringify(dto({balances:[{asset:'BTC',free:'1',locked:'0'}]})),now);assert.equal(c.valued(empty,now).report.coveredSubtotal,null);assert.equal(c.valued(empty,now).report.unpricedPositionCount,1);
});
test('严格白名单拒绝附加凭据/报价/嵌套字段、重复资产和恶意身份',()=>{
 for(const value of [dto({apiKey:'FAKE'}),dto({source:'signature=FAKE'}),dto({balances:[{asset:'BTC',free:'1',locked:'0',secret:'FAKE'}]}),dto({balances:[{asset:'BTC',free:'1',locked:'0'},{asset:'BTC',free:'2',locked:'0'}]}),dto({balances:[{asset:'WRISKDEMO_BTC',free:'1',locked:'0'}]}),dto({uid:'<script>'}),dto({balances:[{asset:'BTC',free:'-1',locked:'0'}]})])assert.throws(()=>new SpotBridge().import(JSON.stringify(value),now));
});
