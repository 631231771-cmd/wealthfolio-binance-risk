import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {createRequire} from 'node:module';
const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:ReturnType<typeof createElement>)=>string};
import {spotSnapshot,spotRisk} from '../src/spot';
import {SpotQuoteReader,mergeDynamicPublicSpotPrices} from '../src/public-market';
import {portfolioView,portfolioPresentation,displayPercent} from '../src/portfolio-view';
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
 assert.equal(portfolioView(stale).dust.length,0); // Raw current risk remains unavailable; only the coherent presentation may use history.
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

function example(){
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:[{asset:'USDC',free:'1000',locked:'0'},{asset:'BTC',free:'0.01',locked:'0'},{asset:'DUST',free:'2',locked:'0'},{asset:'USDT',free:'10',locked:'0'},{asset:'NOPAIR',free:'0.0000001',locked:'0'}]},'external',at,at);
 for(const p of snapshot.positions)if(p.asset.code!=='NOPAIR')p.price={value:({USDC:'0.998',BTC:'50000',DUST:'0.01',USDT:'1'} as Record<string,string>)[p.asset.code],currency:'USDT',asOf:at,source:'external:test'};
 const state={schemaVersion:1 as const,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready' as const,attemptedAt:at}}};
 return {state,report:spotRisk(state,now)};
}
test('过期展示冻结的整份估值：总值、排序、数量、配置、微额不跳变，风险仍不可用',()=>{
 const value=example(),reference={...structuredClone(value),at};
 const stale={state:structuredClone(value.state),report:spotRisk(value.state,now+400_000)};
 const before=portfolioPresentation(value),after=portfolioPresentation(stale,reference);
 assert.equal(after.historical,true);assert.deepEqual(after.view.rows,before.view.rows);assert.deepEqual(after.view.dust.map(r=>r.code),['DUST']);
 assert.equal(after.displayed.report.coveredSubtotal,'1508.02000000');assert.equal(stale.report.coveredSubtotal,null);assert.equal(stale.report.stressLoss,null);
 assert.ok(after.view.visible.some(r=>r.code==='NOPAIR'));assert.equal(after.view.complete,false);
 const html=renderToStaticMarkup(createElement(PortfolioOverview,{value:stale,reference}));
 assert.match(html,/历史资产配置/);assert.match(html,/当时仅部分覆盖/);assert.match(html,/微额资产 · 1 项/);assert.match(html,/已计入当时总值/);assert.match(html,/不代表当前资产/);
 assert.doesNotMatch(html,/暂无有效配置比例/);assert.match(html,/占比仅以这部分市值为分母/);
});
test('报价全部失效仅USDT仍可计价时，历史视图不把USDT小计冒充完整总值',()=>{
 const value=example(),reference={...structuredClone(value),at};
 const state=structuredClone(value.state);for(const p of Object.values(state.snapshots)[0].positions)if(p.asset.code!=='USDT')delete p.price;
 const current={state,report:spotRisk(state,now+60_000)},view=portfolioPresentation(current,reference);
 assert.equal(current.report.coveredSubtotal,'10.00000000');assert.equal(view.historical,true);assert.equal(view.displayed.report.coveredSubtotal,'1508.02000000');
 assert.equal(view.current.priced,1);assert.equal(view.view.priced,4);assert.equal(view.priceFrom,at);
});
test('更新后的余额不可与旧价按行拼接；新缺价持仓不能按旧微额隐藏',()=>{
 const value=example(),reference={...structuredClone(value),at};
 const state=structuredClone(value.state),snapshot=Object.values(state.snapshots)[0];
 snapshot.asOf=new Date(now+60_000).toISOString();snapshot.collectionStartedAt=snapshot.asOf;snapshot.collectionEndedAt=snapshot.asOf;snapshot.positions.find(p=>p.asset.code==='DUST')!.quantity='9000';
 for(const p of snapshot.positions)if(p.asset.code!=='USDT')delete p.price;
 const current={state,report:spotRisk(state,now+60_000)},shown=portfolioPresentation(current,reference);
 assert.equal(shown.historical,false);assert.equal(shown.view.dust.length,0);assert.ok(shown.view.visible.some(r=>r.code==='DUST'&&r.quantity==='9000'&&r.value===undefined));
 const html=renderToStaticMarkup(createElement(PortfolioOverview,{value:current,reference,history:new Map([['DUST',{value:'0.01',asOf:at,currency:'USDT',source:'external:test'}]])}));
 assert.doesNotMatch(html,/历史市值/);assert.match(html,/9000/);assert.match(html,/10.00/);
});
test('数量变更即使时间相同也不复用旧记录；不同账户记录不匹配',()=>{
 const value=example(),reference={...structuredClone(value),at};
 for(const change of ['quantity','account']){
  const state=structuredClone(value.state),s=Object.values(state.snapshots)[0];
  if(change==='quantity')s.positions[0].quantity='999';else {const oldId=s.accountId;s.accountId='external:binance:2:spot';state.accounts[0].id=s.accountId;state.accounts[0].sourceAccountId='2';state.snapshots={[s.accountId]:s};state.statuses={[s.accountId]:state.statuses[oldId]};}
  assert.equal(portfolioPresentation({state,report:spotRisk(state,now+400_000)},reference).historical,false);
 }
});
test('部分新报价使用当前覆盖，不暗中混入历史缺失价格或扩大分母',()=>{
 const value=example(),reference={...structuredClone(value),at},state=structuredClone(value.state);
 delete Object.values(state.snapshots)[0].positions.find(p=>p.asset.code==='USDC')!.price;
 const current={state,report:spotRisk(state,now)},view=portfolioPresentation(current,reference);
 assert.equal(view.historical,false);assert.equal(view.displayed.report.coveredSubtotal,'510.02000000');assert.equal(view.view.priced,3);
 assert.ok(view.view.visible.some(r=>r.code==='USDC'&&r.value===undefined));assert.equal(view.view.allocation[0].code,'BTC');
});
test('合法零余额覆盖历史，不显示旧总值或虚构占比',()=>{
 const value=example(),reference={...structuredClone(value),at},state=structuredClone(value.state);Object.values(state.snapshots)[0].positions=[];
 const current={state,report:spotRisk(state,now)},view=portfolioPresentation(current,reference);
 assert.equal(view.historical,false);assert.equal(view.displayed.report.coveredSubtotal,'0.00000000');assert.equal(view.view.allocation.length,0);
 const html=renderToStaticMarkup(createElement(PortfolioOverview,{value:current,reference}));assert.match(html,/0.00/);assert.match(html,/零余额不计算占比/);
});
test('不同批次报价明确保留时间范围，过期显示原始采集时间而非当前时间',()=>{
 const value=example();Object.values(value.state.snapshots)[0].positions.find(p=>p.asset.code==='BTC')!.price!.asOf=new Date(now-10_000).toISOString();
 value.report=spotRisk(value.state,now);const reference={...structuredClone(value),at};
 const view=portfolioPresentation({state:value.state,report:spotRisk(value.state,now+400_000)},reference);
 assert.equal(view.priceFrom,new Date(now-10_000).toISOString());assert.equal(view.priceTo,at);assert.equal(view.balanceAt,at);assert.equal(view.at,at);
});

test('初次未估值或过期且没有可靠记录时，不用散落历史价格拼出总值',()=>{
 const value=example(),stale={state:structuredClone(value.state),report:spotRisk(value.state,now+400_000)};
 const view=portfolioPresentation(stale);
 assert.equal(view.historical,false);assert.equal(view.displayed.report.coveredSubtotal,null);assert.equal(view.view.dust.length,0);assert.ok(view.view.rows.every(r=>r.price===undefined));
 const html=renderToStaticMarkup(createElement(PortfolioOverview,{value:stale,history:new Map([['USDC',{value:'1',asOf:at,currency:'USDT',source:'external:test'}]])}));
 assert.match(html,/aria-label="不可用"/);assert.doesNotMatch(html,/1,508.02/);assert.doesNotMatch(html,/历史市值/);
});
test('微额边界与缺价分开：0.1不折叠，微额合计保留精确分母',()=>{
 const value=example(),snapshot=Object.values(value.state.snapshots)[0];snapshot.positions.find(p=>p.asset.code==='DUST')!.quantity='10';
 value.report=spotRisk(value.state,now);const view=portfolioPresentation(value).view;
 assert.equal(view.dust.length,0);assert.equal(view.visible.find(r=>r.code==='DUST')!.value,'0.10000000');assert.equal(value.report.coveredSubtotal,'1508.10000000');
 assert.ok(view.visible.some(r=>r.code==='NOPAIR'));assert.equal(view.complete,false);
});


test('微额占比保留非零含义，真实零占比仍为0',()=>{
 assert.equal(displayPercent('0.000000001'),'<0.01%');assert.equal(displayPercent('0'),'0.00%');assert.equal(displayPercent(null),'—');assert.equal(displayPercent('0.6551'),'65.51%');
});
