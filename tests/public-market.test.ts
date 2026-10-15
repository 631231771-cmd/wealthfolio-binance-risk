import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';
import { PublicMarketReader, PublicMarketError, PUBLIC_ORIGIN, mergePublicSpotPrices, publicMarketRequest, publicMarketRisk } from '../src/public-market';
import { multiExchangeInfo, MULTI_PRICES } from '../src/spot-fixture';
import { spotSnapshot, spotRisk } from '../src/spot';
const NOW=Date.parse('2026-10-14T00:00:00Z');
const response=(data:unknown,status=200,headers:Record<string,string>={}):NetworkResponse=>({status,body:JSON.stringify(data),headers});
function fixture() {
  let now=NOW,mode='normal';const requests:NetworkRequest[]=[];
  const reader=new PublicMarketReader({request:async request=>{
    requests.push(request); const path=new URL(request.url).pathname;
    if(mode==='network')throw new Error('fake secret must not propagate');
    if(mode==='429' || mode==='418')return response({},Number(mode),{'Retry-After':'2'});
    if(mode==='503')return response({},503);
    if(mode==='bad-json')return {status:200,headers:{},body:'not JSON'};
    if(path.endsWith('/time'))return response({serverTime:now});
    if(path.endsWith('/exchangeInfo'))return response(multiExchangeInfo());
    let rows:{symbol:string;price:string}[]=Object.entries(MULTI_PRICES).map(([code,price])=>({symbol:code+'USDT',price}));
    if(mode==='missing')rows=rows.filter(p=>p.symbol!=='ETHUSDT');
    if(mode==='bad-price')rows[0].price='0';
    return response(rows);
  }},()=>now);
  return {reader,requests,set:(value:string)=>{mode=value;},time:(value:number)=>{now=value;},risk:()=>publicMarketRisk(reader.getState(),now)};
}

test('公开构造固定HTTPS主机/三个GET；不支持私人路径、URL或认证参数',()=>{
  for(const req of [publicMarketRequest('time'),publicMarketRequest('exchangeInfo'),publicMarketRequest('price',['BTCUSDT','ETHUSDT'])]) {
    assert.equal(new URL(req.url).origin,PUBLIC_ORIGIN);assert.equal(req.method,'GET');
    assert.deepEqual(Object.keys(req).sort(),['method','timeoutSecs','url']);
    assert.ok(!/signature|APIKEY|recvWindow|timestamp|account/.test(req.url));
  }
  assert.throws(()=>publicMarketRequest('account' as any));
  assert.throws(()=>publicMarketRequest('https://evil.test' as any));
  assert.throws(()=>publicMarketRequest('time',['BTCUSDT']));
  assert.throws(()=>publicMarketRequest('price',['BTCUSDT&signature=fake']));
  assert.throws(()=>publicMarketRequest('price',[]));
});
test('清单只允许已授权公开主机与直接Spot主机，无use或宿主资产权限',()=>{
  const manifest=JSON.parse(readFileSync('manifest.json','utf8'));
  assert.deepEqual(manifest.network,{allowedHosts:['data-api.binance.vision','api.binance.com']});
  assert.deepEqual(manifest.permissions.map((p:any)=>p.category),['secrets','files','network']);
  assert.deepEqual(manifest.permissions.find((p:any)=>p.category==='network').functions,['request']);
  assert.deepEqual(manifest.permissions.find((p:any)=>p.category==='secrets').functions,['set','get','delete']);
});
test('将公开报价应用到外部 Spot 数量，不带入模拟数量；未知资产与旧价未定价',async()=>{
  const f=fixture();await f.reader.refresh();
  const at=new Date(NOW).toISOString();
  const parsed=spotSnapshot({uid:42,accountType:'SPOT',balances:[
    {asset:'BTC',free:'0.4',locked:'0'},{asset:'ETH',free:'2',locked:'0'},
    {asset:'USDT',free:'4000',locked:'0'},{asset:'UNSUPPORTED',free:'3',locked:'0'}
  ]},'external',at,at);
  parsed.snapshot.positions.find(p=>p.asset.code==='UNSUPPORTED')!.price={value:'9',currency:'USDT',asOf:at,source:'external:old quote'};
  const quoted=mergePublicSpotPrices(parsed.account,parsed.snapshot,f.reader.getState(),NOW);
  assert.deepEqual(quoted.positions.map(p=>p.quantity),['0.4','2','4000','3']);
  assert.equal(quoted.dataMode,'external');
  assert.equal(quoted.positions.find(p=>p.asset.code==='BTC')!.price!.value,MULTI_PRICES.BTC);
  assert.equal(quoted.positions.find(p=>p.asset.code==='USDT')!.price!.source,'unit:USDT/USDT');
  assert.equal(quoted.positions.find(p=>p.asset.code==='UNSUPPORTED')!.price,undefined);
  const state={schemaVersion:1 as const,accounts:[parsed.account],snapshots:{[parsed.account.id]:quoted},statuses:{[parsed.account.id]:{state:'ready' as const,attemptedAt:at}}};
  assert.equal(spotRisk(state,NOW).coveredSubtotal,'29000.00000000');
  assert.equal(spotRisk(state,NOW).coverage,'partial');
  f.set('503');await assert.rejects(f.reader.refresh());
  const afterFailure=mergePublicSpotPrices(parsed.account,quoted,f.reader.getState(),NOW);
  assert.equal(afterFailure.positions.find(p=>p.asset.code==='BTC')!.price,undefined);
  assert.equal(afterFailure.positions.find(p=>p.asset.code==='USDT')!.price!.value,'1');
  assert.throws(()=>mergePublicSpotPrices({...parsed.account,id:'demo-spot'},parsed.snapshot,f.reader.getState(),NOW));
});
test('真实SDK body契约、采集时间与fixture数量隔离；公开链路无凭据能力',async()=>{
  const f=fixture();await f.reader.refresh();assert.equal(f.requests.length,3);
  for(const r of f.requests)assert.deepEqual(Object.keys(r).sort(),['method','timeoutSecs','url']);
  const state=f.reader.getState(), snapshot=Object.values(state.snapshots)[0];
  assert.equal(snapshot.dataMode,'fixture');assert.equal(snapshot.positions.length,6);
  assert.equal(snapshot.positions[0].quantity,'0.4');assert.ok(snapshot.positions[0].price!.source.startsWith('external:'+PUBLIC_ORIGIN));
  assert.equal(snapshot.positions[0].price!.asOf,new Date(NOW).toISOString());
  assert.equal(f.risk().coveredSubtotal,'37100.00000000');assert.equal(f.risk().stressLoss,'6620.00000000');
  assert.equal(f.reader.getServerTime(),new Date(NOW).toISOString());
  const source=readFileSync('src/public-market.ts','utf8');assert.ok(!/secrets|credentials|localStorage|\.storage|fetch\s*\(/.test(source));
});
test('重复刷新更新采集时间，数量不增加，不保存到旧数据',async()=>{
  const f=fixture();await f.reader.refresh();f.time(NOW+1000);await f.reader.refresh();
  assert.equal(f.risk().coveredSubtotal,'37100.00000000');assert.equal(Object.values(f.reader.getState().snapshots)[0].positions.length,6);
  assert.equal(Object.values(f.reader.getState().snapshots)[0].positions[0].price!.asOf,new Date(NOW+1000).toISOString());
  const restored=f.reader.getState();restored.accounts.length=0;assert.equal(f.reader.getState().accounts.length,1);
});
test('缺行情行不使用先前ETH价格；数量保留且partial',async()=>{
  const f=fixture();await f.reader.refresh();f.set('missing');await f.reader.refresh();
  assert.equal(f.risk().coverage,'partial');assert.equal(f.risk().coveredSubtotal,'32100.00000000');assert.equal(f.risk().stressLoss,'5620.00000000');
  const eth=Object.values(f.reader.getState().snapshots)[0].positions.find(p=>p.asset.code==='ETH')!;
  assert.equal(eth.quantity,'2');assert.equal(eth.price,undefined);assert.equal(f.risk().total,null);
});
test('超时/网络/无效JSON/非法零价格/HTTP失败不沿用旧报价为当前成功',async()=>{
  for(const mode of ['network','503','bad-json','bad-price']) {
    const f=fixture();await f.reader.refresh();f.set(mode);await assert.rejects(f.reader.refresh(),PublicMarketError);
    assert.equal(f.risk().coveredSubtotal,null);assert.equal(f.risk().stressLoss,null);assert.equal(f.risk().lastKnownSubtotal,'37100.00000000');
    assert.equal(Object.values(f.reader.getState().snapshots)[0].positions.length,6);
    assert.ok(!JSON.stringify(f.reader.getState()).includes('fake secret'));
  }
});
test('429/418使用冷却，不自动重试，拒绝冷却内刷新',async()=>{
  for(const status of ['429','418']) {
    const f=fixture();await f.reader.refresh();f.set(status);await assert.rejects(f.reader.refresh(),/限流/);
    const count=f.requests.length;await assert.rejects(f.reader.refresh(),/限流/);assert.equal(f.requests.length,count);
    assert.equal(f.risk().coveredSubtotal,null);f.time(NOW+2001);f.set('normal');await f.reader.refresh();assert.equal(f.risk().coverage,'complete');
  }
});
test('价格与模拟估值超过120秒或未来时间不可用，历史保留',async()=>{
  const f=fixture();await f.reader.refresh();f.time(NOW+120001);assert.equal(f.risk().coveredSubtotal,null);assert.equal(f.risk().stressLoss,null);
  assert.equal(f.risk().lastKnownSubtotal,'37100.00000000');f.time(NOW-1);assert.equal(f.risk().coveredSubtotal,null);
});
test('首次失败无历史不是零；模拟断网/断开无请求且不清数量',async()=>{
  const f=fixture();f.set('network');await assert.rejects(f.reader.refresh(),/网络/);assert.equal(f.risk().lastKnownSubtotal,null);
  f.set('normal');await f.reader.refresh();const count=f.requests.length;f.reader.simulateNetworkFailure();assert.equal(f.requests.length,count);
  assert.equal(f.risk().coveredSubtotal,null);assert.equal(f.risk().lastKnownSubtotal,'37100.00000000');
  await f.reader.refresh();f.reader.disconnect();assert.equal(f.risk().coverage,'unavailable');
});
test('断开丢弃在途成功，没有后续请求',async()=>{
  let resolve!:(r:NetworkResponse)=>void,count=0;
  const reader=new PublicMarketReader({request:()=>{count++;return new Promise(r=>{resolve=r;});}},()=>NOW);
  const p=reader.refresh();await new Promise(r=>setTimeout(r,0));reader.disconnect();resolve(response({serverTime:NOW}));
  await assert.rejects(p,/断开/);assert.equal(count,1);assert.equal(publicMarketRisk(reader.getState(),NOW).coveredSubtotal,null);
});
test('SDK无取消API时超时仍阻止重叠请求，迟到结果不成为当前价格',async()=>{
  let resolve!:(r:NetworkResponse)=>void,count=0;
  const reader=new PublicMarketReader({request:()=>{count++;return new Promise(r=>{resolve=r;});}},()=>NOW,5);
  await assert.rejects(reader.refresh(),/超时/);await assert.rejects(reader.refresh(),/尚未结束/);assert.equal(count,1);
  resolve(response({serverTime:NOW}));await new Promise(r=>setTimeout(r,0));assert.equal(publicMarketRisk(reader.getState(),NOW).coveredSubtotal,null);
});
