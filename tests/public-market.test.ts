import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';
import { PublicMarketReader, SpotQuoteReader, PublicMarketError, PUBLIC_ORIGIN, SPOT_QUOTE_MAX_REQUESTS, SPOT_QUOTE_MAX_FALLBACK_REQUESTS, mergeDynamicPublicSpotPrices, mergePublicSpotPrices, publicMarketRequest, publicMarketRisk } from '../src/public-market';
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
  for(const req of [publicMarketRequest('time'),publicMarketRequest('exchangeInfo'),publicMarketRequest('exchangeInfo',['BTCUSDT','ETHUSDT']),publicMarketRequest('price',['BTCUSDT','ETHUSDT'])]) {
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

test('真实Spot九项虚构余额按动态资产代码取价，稳定币需明确报价，UTF-8与无市场资产保留缺价',async()=>{
 const assets=['BTC','ETH','BNB','LINK','XRP','USDC','币','NOPAIR','USDT'];
 const rows=[['BTC','50000'],['ETH','2500'],['BNB','500'],['LINK','15'],['USDC','1.002']].map(([baseAsset])=>({symbol:`${baseAsset}USDT`,baseAsset,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}));
 rows.push({symbol:'XRPUSDT',baseAsset:'XRP',quoteAsset:'USDT',status:'BREAK',isSpotTradingAllowed:true});
 const calls:NetworkRequest[]=[];
 const reader=new SpotQuoteReader({request:async req=>{
  calls.push(req);const url=new URL(req.url);assert.equal(url.origin,PUBLIC_ORIGIN);assert.equal(req.method,'GET');assert.equal(req.headers,undefined);
  if(url.pathname.endsWith('/exchangeInfo'))return response({symbols:rows});
  const symbol=url.searchParams.get('symbol');const symbols=symbol?[symbol]:JSON.parse(url.searchParams.get('symbols')??'[]');
  return response(symbols.map((s:string)=>({symbol:s,price:({'BTCUSDT':'50000','ETHUSDT':'2500','BNBUSDT':'500','LINKUSDT':'15','USDCUSDT':'1.002'} as Record<string,string>)[s]})).filter((x:any)=>x.price));
 }} ,()=>NOW);
 const refresh=await reader.refreshSpotAssets(assets);assert.equal(refresh.status,'partial');assert.equal(refresh.candidateCount,7);assert.equal(refresh.pricedCount,5);
 const spotQuotes=reader.getSpotQuotes();
 const at=new Date(NOW).toISOString();
 const parsed=spotSnapshot({uid:42,accountType:'SPOT',balances:assets.map((asset,i)=>({asset,free:['0.1','1','2','10','100','20','3','4','10'][i],locked:'0'}))},'external',at,at);
 const quoted=mergeDynamicPublicSpotPrices(parsed.account,parsed.snapshot,spotQuotes,NOW);
 const values=quoted.positions.map(p=>[p.asset.code,p.quantity,p.price?.value]);
 assert.deepEqual(values,[['BTC','0.1','50000'],['ETH','1','2500'],['BNB','2','500'],['LINK','10','15'],['XRP','100',undefined],['USDC','20','1.002'],['币','3',undefined],['NOPAIR','4',undefined],['USDT','10','1']]);
 const state={schemaVersion:1 as const,accounts:[parsed.account],snapshots:{[parsed.account.id]:quoted},statuses:{[parsed.account.id]:{state:'ready' as const,attemptedAt:at}}};
 const report=spotRisk(state,NOW);assert.equal(report.coveredSubtotal,'8680.04000000');assert.equal(report.coverage,'partial');assert.equal(report.unpricedPositionCount,3);
 assert.equal(quoted.dataMode,'external');assert.equal(quoted.positions.reduce((sum,p)=>sum+Number(p.quantity),0),150.1);
 assert.ok(!calls.some(req=>/account|signature|apiRestrictions/.test(new URL(req.url).pathname)));
 assert.ok(calls.every(req=>req.url.includes('symbols=')));
});

test('行情刷新对单个退市 -1121 逐项隔离，其他币报价仍保留',async()=>{
 let tickerCalls=0;
 const reader=new SpotQuoteReader({request:async req=>{
  const url=new URL(req.url);
  if(url.pathname.endsWith('/exchangeInfo'))return response({symbols:['BTC','ETH','BNB'].map(baseAsset=>({symbol:baseAsset+'USDT',baseAsset,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}))});
  tickerCalls++;
  const symbols=url.searchParams.get('symbol')?[url.searchParams.get('symbol')!]:JSON.parse(url.searchParams.get('symbols')!);
  if(symbols.includes('ETHUSDT')&&symbols.length>1)return response({code:-1121,msg:'ignored'},400);
  if(symbols[0]==='ETHUSDT')return response({code:-1121,msg:'ignored'},400);
  return response(symbols.map((symbol:string)=>({symbol,price:symbol==='BTCUSDT'?'50000':'500'})));
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC','ETH','BNB']),quotes=reader.getSpotQuotes();
 assert.equal(result.status,'partial');assert.equal(quotes.get('BTC')?.value,'50000');assert.equal(quotes.get('BNB')?.value,'500');assert.equal(quotes.has('ETH'),false);assert.equal(tickerCalls,4);
});

test('exchangeInfo批次的单个无效symbol -1121 也逐项隔离',async()=>{
 const calls:string[]=[];
 const reader=new SpotQuoteReader({request:async req=>{
  const url=new URL(req.url);calls.push(`${url.pathname}:${url.searchParams.get('symbol')??url.searchParams.get('symbols')}`);
  if(url.pathname.endsWith('/exchangeInfo')){
   const symbols=url.searchParams.get('symbol')?[url.searchParams.get('symbol')!]:JSON.parse(url.searchParams.get('symbols')!);
   if(symbols.includes('ETHUSDT')&&symbols.length>1)return response({code:-1121,msg:'ignored'},400);
   if(symbols[0]==='ETHUSDT')return response({code:-1121,msg:'ignored'},400);
   return response({symbols:symbols.map((symbol:string)=>({symbol,baseAsset:symbol.slice(0,-4),quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}))});
  }
  const symbols=url.searchParams.get('symbol')?[url.searchParams.get('symbol')!]:JSON.parse(url.searchParams.get('symbols')!);
  return response(symbols.map((symbol:string)=>({symbol,price:symbol==='BTCUSDT'?'50000':'500'})));
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC','ETH','BNB']),quotes=reader.getSpotQuotes();
 assert.equal(result.status,'partial');
 assert.equal(quotes.get('BTC')?.value,'50000');assert.equal(quotes.get('BNB')?.value,'500');assert.equal(quotes.has('ETH'),false);
 assert.equal(calls.filter(call=>call.startsWith('/api/v3/exchangeInfo:')).length,4);
});

test('动态行情响应超限、错误JSON和限流安全拒绝，冷却不能被刷新绕过',async()=>{
 for(const mode of ['large','json'] as const){
  const reader=new SpotQuoteReader({request:async req=>{
   if(new URL(req.url).pathname.endsWith('/exchangeInfo'))return mode==='large'?{status:200,headers:{},body:' '.repeat(2*1024*1024+1)}:{status:200,headers:{},body:'not-json'};
   throw new Error('unexpected');
  }},()=>NOW);
  const result=await reader.refreshSpotAssets(['BTC']);assert.equal(result.status,'request-failed');assert.equal(result.failedRequestCount,1);assert.equal(reader.getSpotQuotes().size,0);
 }
 let count=0;const reader=new SpotQuoteReader({request:async req=>{count++;return new URL(req.url).pathname.endsWith('/exchangeInfo')?response({code:-1003},429,{'Retry-After':'2'}):response({});}},()=>NOW);
 await assert.rejects(reader.refreshSpotAssets(['BTC']),/限流/);const before=count;await assert.rejects(reader.refreshSpotAssets(['BTC']),/限流/);assert.equal(count,before);
});

test('SDK在途超时后不继续下一个请求或重叠刷新，迟到响应不发布价格',async()=>{
 let resolve!:(response:NetworkResponse)=>void,count=0;
 const reader=new SpotQuoteReader({request:()=>{count++;return new Promise(r=>{resolve=r;});}},()=>NOW,5);
 await assert.rejects(reader.refreshSpotAssets(['BTC']));assert.equal(count,1);assert.equal(reader.isBusy(),true);
 await assert.rejects(reader.refreshSpotAssets(['ETH']),/尚未结束/);assert.equal(count,1);
 resolve(response({symbols:[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}]}));
 await new Promise(r=>setTimeout(r,0));assert.equal(reader.isBusy(),false);assert.equal(reader.getSpotQuotes().size,0);
});

const requestedSymbols=(request:NetworkRequest):string[]=>{
 const url=new URL(request.url),one=url.searchParams.get('symbol');
 return one?[one]:JSON.parse(url.searchParams.get('symbols')??'[]');
};
const marketRow=(baseAsset:string)=>({symbol:baseAsset+'USDT',baseAsset,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true});

test('exchangeInfo成功而ticker返回503时报告请求失败且不发布报价',async()=>{
 let calls=0;
 const reader=new SpotQuoteReader({request:async request=>{
  calls++;const path=new URL(request.url).pathname;
  return path.endsWith('/exchangeInfo')?response({symbols:[marketRow('BTC')]}):response({error:'fixture'},503);
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC']);
 assert.equal(result.status,'request-failed');assert.equal(result.failedRequestCount,1);assert.equal(result.marketCount,1);
 assert.equal(result.pricedCount,0);assert.equal(reader.getSpotQuotes().size,0);assert.equal(calls,2);
});

test('多批报价一批成功一批503时保留新报价并标记部分成功',async()=>{
 const assets=Array.from({length:21},(_,i)=>'ASSET'+String(i).padStart(3,'0'));let ticker=0;
 const reader=new SpotQuoteReader({request:async request=>{
  const url=new URL(request.url),symbols=requestedSymbols(request);
  if(url.pathname.endsWith('/exchangeInfo'))return response({symbols:symbols.map(s=>marketRow(s.slice(0,-4)))});
  ticker++;return ticker===2?response({error:'fixture'},503):response(symbols.map(symbol=>({symbol,price:'2.5'})));
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(assets);
 assert.equal(result.status,'partial');assert.equal(result.marketCount,21);assert.equal(result.pricedCount,20);
 assert.equal(result.failedRequestCount,1);assert.equal(reader.getSpotQuotes().get(assets[0])?.value,'2.5');
 assert.equal(reader.getSpotQuotes().has(assets[20]),false);assert.equal(result.requestCount,4);
});

test('HTTP200报价结果缺行时按未完成请求处理并保留准确覆盖状态',async()=>{
 for(const returnedSymbols of [[],['BTCUSDT']]){
  const reader=new SpotQuoteReader({request:async request=>{
   const symbols=requestedSymbols(request),path=new URL(request.url).pathname;
   if(path.endsWith('/exchangeInfo'))return response({symbols:symbols.map(s=>marketRow(s.slice(0,-4)))});
   return response(returnedSymbols.map(symbol=>({symbol,price:'2.5'})));
  }},()=>NOW);
  const result=await reader.refreshSpotAssets(['BTC','ETH']);
  assert.equal(result.failedRequestCount,1);
  assert.equal(result.status,returnedSymbols.length?'partial':'request-failed');
  assert.equal(result.pricedCount,returnedSymbols.length);
  assert.equal(reader.getSpotQuotes().has('BTC'),returnedSymbols.length===1);
 }
});

test('所有市场请求失败不得被误报为无有效市场',async()=>{
 let calls=0;
 const reader=new SpotQuoteReader({request:async()=>{calls++;return response({error:'fixture'},503);}},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC','ETH']);
 assert.equal(result.status,'request-failed');assert.equal(result.failedRequestCount,1);
 assert.equal(result.marketCount,0);assert.equal(calls,1);
});

test('exchangeInfo正常返回空市场才报告无有效市场',async()=>{
 let calls=0;
 const reader=new SpotQuoteReader({request:async()=>{calls++;return response({symbols:[]});}},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC','ETH']);
 assert.equal(result.status,'no-market');assert.equal(result.candidateCount,2);
 assert.equal(result.failedRequestCount,0);assert.equal(calls,1);
});

test('仅USDT或不能生成候选交易对的资产不发请求',async()=>{
 let calls=0;
 const reader=new SpotQuoteReader({request:async()=>{calls++;return response({});}},()=>NOW);
 const result=await reader.refreshSpotAssets(['USDT','币']);
 assert.equal(result.status,'no-candidates');assert.equal(result.candidateCount,0);
 assert.equal(result.requestCount,0);assert.equal(calls,0);
});

test('大量-1121隔离回退共享整体预算并显式报告剩余未覆盖',async()=>{
 const assets=Array.from({length:100},(_,i)=>'ASSET'+String(i).padStart(3,'0'));
 let calls=0,fallback=0;
 const reader=new SpotQuoteReader({request:async request=>{
  calls++;const symbols=requestedSymbols(request);
  if(symbols.length===1)fallback++;
  return response({code:-1121,msg:'fixture'},400);
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(assets);
 assert.equal(result.status,'budget-limited');assert.equal(result.budgetReason,'fallback-cap');
 assert.equal(result.candidateCount,100);assert.equal(result.unexaminedCount,80);
 assert.equal(result.requestCount,calls);assert.equal(result.fallbackRequestCount,fallback);
 assert.ok(calls<=SPOT_QUOTE_MAX_REQUESTS);assert.ok(fallback<=SPOT_QUOTE_MAX_FALLBACK_REQUESTS);
 assert.equal(calls,22);assert.equal(fallback,20);assert.equal(reader.getSpotQuotes().size,0);
});

test('exchangeInfo与ticker的-1121单项回退共享同一个20次额度',async()=>{
 const assets=Array.from({length:11},(_,i)=>'TOKEN'+String(i).padStart(2,'0'));
 let calls=0,fallback=0;
 const reader=new SpotQuoteReader({request:async request=>{
  calls++;const url=new URL(request.url),symbols=requestedSymbols(request),isSingle=symbols.length===1;
  if(isSingle)fallback++;
  if(url.pathname.endsWith('/exchangeInfo')){
   if(!isSingle)return response({code:-1121,msg:'fixture'},400);
   return response({symbols:[marketRow(symbols[0].slice(0,-4))]});
  }
  if(!isSingle)return response({code:-1121,msg:'fixture'},400);
  return response([{symbol:symbols[0],price:'4'}]);
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(assets);
 assert.equal(result.status,'budget-limited');assert.equal(result.budgetReason,'fallback-cap');
 assert.equal(result.marketCount,11);assert.equal(result.pricedCount,9);assert.equal(result.unexaminedCount,2);
 assert.equal(result.fallbackRequestCount,20);assert.equal(fallback,20);
 assert.equal(result.requestCount,calls);assert.equal(calls,22);assert.ok(calls<=SPOT_QUOTE_MAX_REQUESTS);
});

test('超过100个候选时明确记录候选截断且不把跳过项判为无效市场',async()=>{
 const assets=Array.from({length:101},(_,i)=>'COIN'+String(i).padStart(3,'0'));
 const reader=new SpotQuoteReader({request:async request=>{
  const url=new URL(request.url),symbols=requestedSymbols(request);
  if(url.pathname.endsWith('/exchangeInfo'))return response({symbols:symbols.map(s=>marketRow(s.slice(0,-4)))});
  return response(symbols.map(symbol=>({symbol,price:'1.25'})));
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(assets);
 assert.equal(result.status,'budget-limited');assert.equal(result.budgetReason,'candidate-cap');
 assert.equal(result.candidateCount,101);assert.equal(result.unexaminedCount,1);
 assert.equal(result.marketCount,100);assert.equal(result.pricedCount,100);
 assert.equal(result.requestCount,10);assert.ok(result.requestCount<=SPOT_QUOTE_MAX_REQUESTS);
});

test('ticker收到429或418后立即停止后续请求并保留冷却',async()=>{
 for(const status of [429,418]){
  let calls=0;
  const reader=new SpotQuoteReader({request:async request=>{
   calls++;return new URL(request.url).pathname.endsWith('/exchangeInfo')
    ?response({symbols:[marketRow('BTC')]})
    :{status,headers:{'Retry-After':'5'},body:'界'.repeat(700_000)};
  }},()=>NOW);
  await assert.rejects(reader.refreshSpotAssets(['BTC']),(error:unknown)=>error instanceof PublicMarketError&&error.code==='rate-limit');
  assert.equal(calls,2);assert.ok(reader.getCooldownUntil()>NOW);
  await assert.rejects(reader.refreshSpotAssets(['BTC']),(error:unknown)=>error instanceof PublicMarketError&&error.code==='rate-limit');
  assert.equal(calls,2);assert.equal(reader.getSpotQuotes().size,0);
 }
});

test('UTF-8字节上限拒绝多字节超限响应并接受正常ASCII和UTF-8 JSON',async()=>{
 const oversized=JSON.stringify({symbols:[marketRow('BTC')],note:'界'.repeat(700_000)});
 assert.ok(oversized.length<2*1024*1024);assert.ok(new TextEncoder().encode(oversized).byteLength>2*1024*1024);
 const rejected=new SpotQuoteReader({request:async()=>({status:200,headers:{},body:oversized})},()=>NOW);
 const rejectedResult=await rejected.refreshSpotAssets(['BTC']);
 assert.equal(rejectedResult.status,'request-failed');assert.equal(rejectedResult.failedRequestCount,1);assert.equal(rejected.getSpotQuotes().size,0);
 let calls=0;
 const accepted=new SpotQuoteReader({request:async request=>{
  calls++;const path=new URL(request.url).pathname;
  return path.endsWith('/exchangeInfo')
   ?response({symbols:[marketRow('BTC')],note:'币'})
   :response([{symbol:'BTCUSDT',price:'1.25',note:'行情'}]);
 }},()=>NOW);
 const result=await accepted.refreshSpotAssets(['BTC']);
 assert.equal(result.status,'complete');assert.equal(accepted.getSpotQuotes().get('BTC')?.value,'1.25');assert.equal(calls,2);
});

test('非200错误正文也按UTF-8字节预算解析，超限时不读取其中的-1121',async()=>{
 const body='{"code":-1121,"msg":"'+('界'.repeat(30_000))+'"}';
 assert.ok(body.length<64*1024);assert.ok(new TextEncoder().encode(body).byteLength>64*1024);
 let calls=0;
 const reader=new SpotQuoteReader({request:async()=>{calls++;return {status:400,headers:{},body};}},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC']);
 assert.equal(result.status,'request-failed');assert.equal(result.failedRequestCount,1);
 assert.equal(result.requestCount,1);assert.equal(calls,1);assert.equal(result.marketCount,0);
 assert.ok(!JSON.stringify(result).includes('-1121'));assert.ok(!JSON.stringify(result).includes('界'));
});

test('后续行情故障不会把前次报价冒充为本次成功报价',async()=>{
 let fail=false;
 const reader=new SpotQuoteReader({request:async request=>{
  const url=new URL(request.url),symbols=requestedSymbols(request);
  if(url.pathname.endsWith('/exchangeInfo'))return response({symbols:symbols.map(s=>marketRow(s.slice(0,-4)))});
  return fail?response({error:'fixture'},503):response(symbols.map(symbol=>({symbol,price:'3'})));
 }},()=>NOW);
 const first=await reader.refreshSpotAssets(['BTC','ETH']);
 assert.equal(first.status,'complete');assert.equal(reader.getSpotQuotes().size,2);
 fail=true;const second=await reader.refreshSpotAssets(['BTC','ETH']);
 assert.equal(second.status,'request-failed');assert.equal(second.pricedCount,0);assert.equal(reader.getSpotQuotes().size,0);
});

test('候选截断与请求失败并存时优先报告请求失败并保留预算摘要',async()=>{
 const assets=Array.from({length:101},(_,i)=>'COIN'+String(i).padStart(3,'0'));
 let failedCalls=0;
 const failed=new SpotQuoteReader({request:async()=>{failedCalls++;return response({error:'fixture'},503);}},()=>NOW);
 const failure=await failed.refreshSpotAssets(assets);
 assert.equal(failure.status,'request-failed');assert.equal(failure.budgetReason,'candidate-cap');
 assert.equal(failure.unexaminedCount,1);assert.equal(failure.requestCount,5);assert.equal(failure.failedRequestCount,5);
 assert.equal(failure.pricedCount,0);assert.equal(failedCalls,5);

 const covered=new SpotQuoteReader({request:async request=>{
  const symbols=requestedSymbols(request),path=new URL(request.url).pathname;
  return path.endsWith('/exchangeInfo')
   ?response({symbols:symbols.map(s=>marketRow(s.slice(0,-4)))})
   :response(symbols.map(symbol=>({symbol,price:'1.25'})));
 }},()=>NOW);
 const limited=await covered.refreshSpotAssets(assets);
 assert.equal(limited.status,'budget-limited');assert.equal(limited.budgetReason,'candidate-cap');
 assert.equal(limited.unexaminedCount,1);assert.equal(limited.pricedCount,100);assert.equal(limited.requestCount,10);

 const ordinary=new SpotQuoteReader({request:async request=>{
  const symbols=requestedSymbols(request),path=new URL(request.url).pathname;
  return path.endsWith('/exchangeInfo')
   ?response({symbols:symbols.map(s=>marketRow(s.slice(0,-4)))})
   :response(symbols.map(symbol=>({symbol,price:'1.25'})));
 }},()=>NOW);
 const complete=await ordinary.refreshSpotAssets(['BTC','ETH']);
 assert.equal(complete.status,'complete');assert.equal(complete.budgetReason,undefined);
 assert.equal(complete.unexaminedCount,0);assert.equal(complete.pricedCount,2);
});
