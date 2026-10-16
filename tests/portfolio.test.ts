import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {createRequire} from 'node:module';
const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:ReturnType<typeof createElement>)=>string};
import {spotSnapshot,spotRisk} from '../src/spot';
import {SpotQuoteReader,mergeDynamicPublicSpotPrices} from '../src/public-market';
import {portfolioView} from '../src/portfolio-view';
import {PortfolioOverview} from '../src/portfolio-overview';
import {parseTickerPricesPartial} from '../src/spot-quotes';
const now=Date.parse('2026-10-16T00:00:00Z'),at=new Date(now).toISOString();
const response=(data:unknown,status=200)=>({status,headers:{},body:JSON.stringify(data)});
const market=(baseAsset:string)=>({baseAsset,symbol:baseAsset+'USDT',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true});
const symbols=(url:string)=>{const u=new URL(url);return u.searchParams.has('symbol')?[u.searchParams.get('symbol')!]:JSON.parse(u.searchParams.get('symbols')!);};

test('同symbol的畸形重复行也撤销该币报价，不污染其他市场',()=>{
 for(const duplicate of [[{symbol:'USDCUSDT',price:'1'},{symbol:'USDCUSDT',price:2}],[{symbol:'USDCUSDT',price:2},{symbol:'USDCUSDT',price:'1'}]]){
  const result=parseTickerPricesPartial([...duplicate,{symbol:'BTCUSDT',price:'50000'}],['USDCUSDT','BTCUSDT','ETHUSDT'],at);
  assert.equal(result.has('USDCUSDT'),false);assert.equal(result.get('BTCUSDT')?.value,'50000');
 }
});

test('USDC占多数的虚构账户：市场报价、精确数量、估值、微额折叠、配置分母与界面贯通',async()=>{
 const reader=new SpotQuoteReader({request:async r=>new URL(r.url).pathname.endsWith('exchangeInfo')?response({symbols:['USDC','BTC','DUST'].map(market)}):response([{symbol:'USDCUSDT',price:'0.9987'},{symbol:'BTCUSDT',price:'65000'},{symbol:'DUSTUSDT',price:'0.01'}])},()=>now);
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:[{asset:'USDC',free:'10000',locked:'2000'},{asset:'BTC',free:'0.01',locked:'0'},{asset:'DUST',free:'3',locked:'0'},{asset:'USDT',free:'100',locked:'0'},{asset:'NOPAIR',free:'0.0000001',locked:'0'}]},'external',at,at);
 await reader.refreshSpotAssets(snapshot.positions.map(p=>p.asset.code));
 const quoted=mergeDynamicPublicSpotPrices(account,snapshot,reader.getSpotQuotes(),now);
 const state={schemaVersion:1 as const,accounts:[account],snapshots:{[account.id]:quoted},statuses:{[account.id]:{state:'ready' as const,attemptedAt:at}}};
 const value={state,report:spotRisk(state,now)},view=portfolioView(value);
 assert.equal(value.report.coveredSubtotal,'12734.43000000');assert.equal(view.complete,false);
 assert.equal(view.allocation[0].code,'USDC');assert.equal(view.allocation[0].value,'11984.40000000');
 assert.deepEqual(view.dust.map(r=>r.code),['DUST']);assert.ok(view.visible.some(r=>r.code==='NOPAIR'));
 assert.equal(view.allocation.length,4);assert.equal(view.rows.length,5);
 const html=renderToStaticMarkup(createElement(PortfolioOverview,{value}));
 assert.ok(html.includes('12,734.43'));assert.ok(html.includes('4 / 5 项已估值'));assert.ok(html.includes('成本尚未核实'));assert.ok(!html.includes('压力情景损失'));
 assert.match(html,/<details class="dust">/);assert.ok(html.includes('NOPAIR'));
 const reference={...value,at},failed=structuredClone(state);failed.statuses[account.id].state='failed' as any;
 const stale={state:failed,report:spotRisk(failed,now+400_000)};
 const historical=renderToStaticMarkup(createElement(PortfolioOverview,{value:stale,reference,history:reader.getHistoricalQuotes()}));
 assert.ok(historical.includes('上次估值 · 历史参考'));assert.ok(historical.includes('12,734.43'));assert.ok(historical.includes('当时仅部分覆盖'));assert.equal(stale.report.coveredSubtotal,null);
 assert.equal(portfolioView(stale).dust.length,0); // no hiding based on historical valuations
});

test('元数据回退额度用完仍给已核对USDC报价，不重复探测明确无市场资产',async()=>{
 let nowMs=now,requests=0;
 const reader=new SpotQuoteReader({request:async r=>{
   requests++;const u=new URL(r.url),s=symbols(r.url);
   if(u.pathname.endsWith('ticker/price'))assert.equal(u.searchParams.get('symbolStatus'),'TRADING');
   else assert.equal(u.searchParams.get('showPermissionSets'),'false');
   if(u.pathname.endsWith('exchangeInfo'))return s.length===1&&s[0]==='USDCUSDT'?response({symbols:[market('USDC')]}):response({code:-1121},400);
   return response([{symbol:'USDCUSDT',price:'0.997'}]);
 }},()=>nowMs);
 const assets=['USDC',...Array.from({length:20},(_,i)=>'MISSING'+i)];
 const first=await reader.refreshSpotAssets(assets);assert.equal(first.status,'budget-limited');assert.equal(reader.getSpotQuotes().get('USDC')?.value,'0.997');assert.ok(first.requestCount<=32);
 const before=requests;nowMs+=60_000;await reader.refreshSpotAssets(['USDC','MISSING0']);assert.equal(requests,before+1);
});

test('合法较长UTF-8未知资产不阻断USDC取价，取消迟到结果且历史不会被外部篡改',async()=>{
 let release!:(v:any)=>void,blocked=false;
 const reader=new SpotQuoteReader({request:async r=>{
   if(blocked)return new Promise(resolve=>{release=resolve;});
   return new URL(r.url).pathname.endsWith('exchangeInfo')?response({symbols:[market('USDC')]}):response([{symbol:'USDCUSDT',price:'1.001'}]);
 }},()=>now);
 await reader.refreshSpotAssets(['USDC','币'.repeat(50)]);assert.equal(reader.getSpotQuotes().get('USDC')?.value,'1.001');
 reader.getHistoricalQuotes().get('USDC')!.value='999';assert.equal(reader.getHistoricalQuotes().get('USDC')?.value,'1.001');
 blocked=true;const pending=reader.refreshSpotAssets(['USDC']);await new Promise(r=>setTimeout(r,0));
 assert.equal(reader.getSpotQuotes().get('USDC')?.value,'1.001'); // no flicker while pending
 reader.disconnect();release(response([{symbol:'USDCUSDT',price:'9'}]));await assert.rejects(pending);
 assert.equal(reader.getSpotQuotes().size,0);assert.equal(reader.getHistoricalQuotes().get('USDC')?.value,'1.001');
});
