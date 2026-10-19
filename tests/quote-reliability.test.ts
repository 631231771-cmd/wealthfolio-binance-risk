// 0.2.2 数据可信度回归：报价保留、缺价分类、历史参考与展示口径。
// 全部为虚构余额与内存 transport；不访问网络、不读取凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import {SpotQuoteReader,mergeDynamicPublicSpotPrices,PUBLIC_ORIGIN} from '../src/public-market';
import {spotSnapshot,spotRisk} from '../src/spot';
import {portfolioPresentation,valuationState,heroLabel} from '../src/portfolio-view';
import {DirectSpot,QUOTE_RETRY_BASE} from '../src/direct-spot';
import {BinanceCredentials} from '../src/credentials';
import type {PortfolioState} from '../src/domain';
import type {NetworkResponse} from '@wealthfolio/addon-sdk';

const NOW=Date.parse('2026-10-19T12:00:00Z'),iso=(t=NOW)=>new Date(t).toISOString();
const permissions={enableReading:true,ipRestrict:false,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
const ack={risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true};
const ok=(body:unknown,status=200):NetworkResponse=>({status,headers:{},body:JSON.stringify(body)});
const market=(baseAsset:string)=>({symbol:baseAsset+'USDT',baseAsset,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true});

function valuation(balances:{asset:string;free:string}[],prices:Record<string,string>,now=NOW){
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:balances.map(b=>({...b,locked:'0'}))},'external',iso(now),iso(now));
 for(const p of snapshot.positions)if(prices[p.asset.code])p.price={value:prices[p.asset.code],currency:'USDT',asOf:iso(now),source:'external:test'};
 const state:PortfolioState={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:iso(now)}}};
 return {state,report:spotRisk(state,now)};
}

// ── A. 报价 TTL 边界 ─────────────────────────────────────────────
test('报价在0/30/119/120秒有效，121秒起不得进入当前估值',()=>{
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:[{asset:'BTC',free:'0.01',locked:'0'}]},'external',iso(),iso());
 const quotes=new Map([['BTC',{value:'50000',currency:'USDT',asOf:iso(),source:'external:'+PUBLIC_ORIGIN+'/api/v3/ticker/price（采集时间，非成交时间）'}]]);
 for(const [age,expected] of [[0,true],[30,true],[119,true],[120,true],[121,false]] as const){
  const merged=mergeDynamicPublicSpotPrices(account,snapshot,quotes,NOW+age*1000);
  assert.equal(merged.positions[0].price!==undefined,expected,`age=${age}`);
 }
});
test('未来时间戳的报价直接拒绝，不作为当前有效价格',()=>{
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:[{asset:'BTC',free:'0.01',locked:'0'}]},'external',iso(),iso());
 const quotes=new Map([['BTC',{value:'50000',currency:'USDT',asOf:iso(NOW+10_000),source:'external:'+PUBLIC_ORIGIN+'/api/v3/ticker/price'}]])
 const merged=mergeDynamicPublicSpotPrices(account,snapshot,quotes,NOW);
 assert.equal(merged.positions[0].price,undefined);
});

// ── B. 缺 ticker 行 / -1220 / -1121 分类 ─────────────────────────
test('已验证市场缺ticker行：只计暂时缺价，不算请求失败，也不触发退避',async()=>{
 const reader=new SpotQuoteReader({request:async req=>{
  const url=new URL(req.url);
  if(url.pathname.endsWith('/exchangeInfo'))return ok({symbols:[market('BTC'),market('ETH')]});
  return ok([{symbol:'BTCUSDT',price:'50000'}]); // ETH 有市场但本次没有行
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC','ETH']);
 assert.equal(result.status,'partial');
 assert.equal(result.failedRequestCount,0);
 assert.equal(result.missingQuoteCount,1);
 assert.equal(result.pricedCount,1);
 assert.equal(reader.getSpotQuotes().get('BTC')?.value,'50000');
});
test('-1220 单交易对停牌只算暂时缺价，已验证市场不被删除',async()=>{
 const reader=new SpotQuoteReader({request:async req=>{
  const url=new URL(req.url);
  if(url.pathname.endsWith('/exchangeInfo'))return ok({symbols:[market('BTC'),market('ETH')]});
  const single=url.searchParams.get('symbol');
  if(single==='ETHUSDT')return ok({code:-1220,msg:'ignored'},400);
  if(single==='BTCUSDT')return ok([{symbol:'BTCUSDT',price:'50000'}]);
  // 批量请求用 -1121 触发逐项回退，模拟其中一个 symbol 不可用
  return ok({code:-1121,msg:'ignored'},400);
 }},()=>NOW);
 const result=await reader.refreshSpotAssets(['BTC','ETH']);
 assert.equal(result.status,'partial');
 assert.equal(result.failedRequestCount,0);
 assert.equal(result.missingQuoteCount,1);
 assert.equal(reader.getSpotQuotes().get('BTC')?.value,'50000');
 assert.equal(reader.getSpotQuotes().has('ETH'),false);
});
test('明确无USDT市场的资产只报告无市场，不重试也不影响其他币报价',async()=>{
 let exchangeInfoCalls=0;
 const reader=new SpotQuoteReader({request:async req=>{
  const url=new URL(req.url);
  if(url.pathname.endsWith('/exchangeInfo')){exchangeInfoCalls++;return ok({symbols:[market('BTC')]});}
  return ok([{symbol:'BTCUSDT',price:'50000'}]);
 }},()=>NOW);
 const first=await reader.refreshSpotAssets(['BTC','NOPAIR']);
 assert.equal(first.status,'partial');
 assert.equal(first.noMarketCount,1);
 assert.equal(first.failedRequestCount,0);
 assert.equal(reader.getSpotQuotes().get('BTC')?.value,'50000');
 const before=exchangeInfoCalls;
 await reader.refreshSpotAssets(['BTC','NOPAIR']); // 无市场缓存 3 分钟
 assert.equal(exchangeInfoCalls,before);
});

// ── C. DirectSpot 调度 ──────────────────────────────────────────
async function harness(){
 const store=new Map<string,string>();
 const credentials=new BinanceCredentials({set:async(k,v)=>{store.set(k,v);},get:async k=>store.get(k)??null,delete:async k=>{store.delete(k);}});
 await credentials.save('FAKE_KEY','FAKE_SECRET');
 let now=NOW,ticker:'both'|'btcOnly'|'fail'='both';
 const network={request:async(req:any):Promise<NetworkResponse>=>{
  const url=new URL(req.url);
  if(url.pathname==='/api/v3/time')return ok({serverTime:now});
  if(url.pathname==='/sapi/v1/account/apiRestrictions')return ok(permissions);
  if(url.pathname==='/api/v3/account')return ok({uid:1,accountType:'SPOT',balances:[{asset:'BTC',free:'0.001',locked:'0'},{asset:'ETH',free:'0.01',locked:'0'},{asset:'USDT',free:'10',locked:'0'}]});
  if(url.pathname==='/api/v3/exchangeInfo')return ok({symbols:[market('BTC'),market('ETH')]});
  if(url.pathname==='/api/v3/ticker/price'){
   if(ticker==='fail')return {status:503,headers:{},body:'{}'};
   const rows=ticker==='both'?[{symbol:'BTCUSDT',price:'50000'},{symbol:'ETHUSDT',price:'2500'}]:[{symbol:'BTCUSDT',price:'50000'}];
   return ok(rows);
  }
  throw new Error('unexpected '+url.pathname);
 }};
 const quotes=new SpotQuoteReader(network,()=>now);
 const reader=new DirectSpot(credentials,network,quotes,()=>now,100);
 reader.setVisible(true);reader.authorize('1',ack);
 return {reader,advance:(ms:number)=>{now+=ms;},setTicker:(v:'both'|'btcOnly'|'fail')=>{ticker=v;},get now(){return now;}};
}
test('缺ticker行不增加行情失败次数，下一次刷新仍按60秒节奏',async()=>{
 const h=await harness();await h.reader.sync();await h.reader.refreshQuotes();
 assert.equal(h.reader.getStatus().quoteRetry.canRetry,true);
 h.advance(60_000);h.setTicker('btcOnly');await h.reader.refreshQuotes();
 const quote=h.reader.getDiagnostic().quote!;
 assert.equal(quote.failedRequestCount,0);
 assert.equal(quote.missingQuoteCount,1);
 assert.equal(quote.retainedCount,1);
 assert.equal(h.reader.getStatus().quoteRetry.canRetry,true); // 无退避
 assert.equal(h.reader.valued().report.coveredSubtotal,'85.00000000'); // ETH 旧价仍在 TTL 内
});
test('真实请求失败按30秒起步退避，恢复后立即重新估值',async()=>{
 const h=await harness();await h.reader.sync();await h.reader.refreshQuotes();
 h.advance(60_000);h.setTicker('fail');await h.reader.refreshQuotes();
 assert.equal(h.reader.getDiagnostic().code,'QUOTE_REQUEST_FAILED');
 assert.equal(h.reader.getStatus().quoteRetry.reason,'backoff');
 assert.equal(h.reader.getStatus().quoteRetry.waitSeconds,QUOTE_RETRY_BASE/1000);
 assert.equal(h.reader.valued().report.coveredSubtotal,'85.00000000'); // 失败不清空有效报价
 h.advance(QUOTE_RETRY_BASE);h.setTicker('both');await h.reader.refreshQuotes();
 assert.equal(h.reader.valued().report.coveredSubtotal,'85.00000000');
 assert.equal(h.reader.getDiagnostic().code,'QUOTE_COMPLETE');
});
test('同一份余额上，完整参考不会被后续部分估值降级',async()=>{
 const h=await harness();await h.reader.sync();await h.reader.refreshQuotes();
 assert.equal(h.reader.getReference()?.report.coverage,'complete');
 assert.equal(h.reader.getReference()?.report.coveredSubtotal,'85.00000000');
 h.advance(130_000);h.setTicker('btcOnly');await h.reader.refreshQuotes();
 // ETH 报价已过期，当前只剩 BTC+USDT；历史参考仍保留上一份完整记录
 assert.equal(h.reader.valued().report.coveredSubtotal,'60.00000000');
 assert.equal(h.reader.getReference()?.report.coverage,'complete');
 assert.equal(h.reader.getReference()?.report.coveredSubtotal,'85.00000000');
});
test('断开连接保留历史参考，但当前估值与风险不再可用',async()=>{
 const h=await harness();await h.reader.sync();await h.reader.refreshQuotes();
 h.reader.disconnect();
 assert.equal(h.reader.valued().report.coveredSubtotal,null);
 assert.equal(h.reader.valued().report.stressLoss,null);
 assert.equal(h.reader.getReference()?.report.coveredSubtotal,'85.00000000');
 assert.equal(h.reader.getState().accounts.length,1); // 数量保留，只是当前不可用
});

// ── D. 余额身份与历史匹配 ────────────────────────────────────────
const base=()=>valuation([{asset:'BTC',free:'0.01'},{asset:'USDT',free:'100'}],{BTC:'50000',USDT:'1'});
const ref=(v:ReturnType<typeof base>)=>({...structuredClone(v),at:iso()});
test('同账户同数量新时间可复用历史；卖出或新增资产则不得复用',()=>{
 const value=base(),reference=ref(value);
 const moved=(balances:{asset:string;free:string}[],prices:Record<string,string>,now:number)=>{
  const v=valuation(balances,prices,now);
  const snap=Object.values(v.state.snapshots)[0];snap.batchId='external:spot:new';snap.asOf=iso(now);snap.collectionStartedAt=snap.asOf;snap.collectionEndedAt=snap.asOf;
  return {state:v.state,report:spotRisk(v.state,now)};
 };
 // 数量与构成相同、时间变化：允许历史
 assert.equal(portfolioPresentation(moved([{asset:'BTC',free:'0.01'},{asset:'USDT',free:'100'}],{},NOW+60_000),reference).historical,true);
 // 卖出 BTC
 assert.equal(portfolioPresentation(moved([{asset:'USDT',free:'100'}],{},NOW+60_000),reference).historical,false);
 // 新增 ETH
 assert.equal(portfolioPresentation(moved([{asset:'BTC',free:'0.01'},{asset:'USDT',free:'100'},{asset:'ETH',free:'1'}],{},NOW+60_000),reference).historical,false);
 // 数量变化
 assert.equal(portfolioPresentation(moved([{asset:'BTC',free:'0.02'},{asset:'USDT',free:'100'}],{},NOW+60_000),reference).historical,false);
});

// ── E. 展示口径 ─────────────────────────────────────────────────
test('六种展示状态与Hero标签一一对应',()=>{
 assert.deepEqual(heroLabel('live',true),{title:'Spot 资产总值',tag:'当前有效'});
 assert.deepEqual(heroLabel('live-partial',true),{title:'已定价小计',tag:'部分覆盖'});
 assert.deepEqual(heroLabel('history-complete',true),{title:'上次完整估值',tag:'历史快照'});
 assert.deepEqual(heroLabel('history-partial',true),{title:'上次部分估值',tag:'历史 · 部分覆盖'});
 assert.deepEqual(heroLabel('unavailable',false),{title:'Spot 已估值资产',tag:'等待更新'});
 assert.deepEqual(heroLabel('unavailable',true),{title:'暂无可信估值',tag:'等待更新'});
});
test('只有USDT可计价时是部分覆盖，100%占比仅代表已定价范围',()=>{
 const v=valuation([{asset:'USDT',free:'250'},{asset:'USDC',free:'1000'}],{USDT:'1'});
 const p=portfolioPresentation(v);
 assert.equal(p.state,'live-partial');
 assert.equal(v.report.coveredSubtotal,'250.00000000');
 assert.equal(v.report.total,null);
 assert.equal(p.view.allocation.length,1);
 assert.equal(p.view.allocation[0].code,'USDT');
 assert.equal(p.view.allocation[0].weight,'1.000000');
});
test('市值接近时排序稳定：同值按资产代码，不因刷新抖动换位',()=>{
 const a=valuation([{asset:'AAA',free:'1'},{asset:'BBB',free:'1'}],{AAA:'10',BBB:'10'});
 const b=valuation([{asset:'BBB',free:'1'},{asset:'AAA',free:'1'}],{AAA:'10',BBB:'10'});
 assert.deepEqual(portfolioPresentation(a).view.visible.map(r=>r.code),['AAA','BBB']);
 assert.deepEqual(portfolioPresentation(b).view.visible.map(r=>r.code),['AAA','BBB']);
});
test('微额边界：0.099折叠，0.100与0.101不折叠，缺价不被折叠',()=>{
 for(const [qty,dust] of [['0.099',true],['0.100',false],['0.101',false]] as const){
  const v=valuation([{asset:'DUST',free:qty}],{DUST:'1'});
  assert.equal(portfolioPresentation(v).view.dust.length,dust?1:0,`qty=${qty}`);
 }
 const missing=valuation([{asset:'DUST',free:'0.099'},{asset:'NOPAIR',free:'1'}],{DUST:'1'});
 const p=portfolioPresentation(missing);
 assert.deepEqual(p.view.dust.map(r=>r.code),['DUST']);
 assert.ok(p.view.visible.some(r=>r.code==='NOPAIR'&&r.value===undefined));
});
