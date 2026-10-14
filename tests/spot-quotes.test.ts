import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdtMarkets, publicTickerRequest, parseTickerPrices } from '../src/spot-quotes';
import { SpotOfflineReader, createMockTransport, spotRisk } from '../src/spot';
import { spotFixtureTransport, multiExchangeInfo, type SpotScenario } from '../src/spot-fixture';
import { DummyCredentials } from '../src/credentials';
import { assetKey } from '../src/domain';

const NOW=Date.parse('2026-10-14T00:00:00Z'), AT=new Date(NOW).toISOString();
const market=(baseAsset:string,symbol=baseAsset+'USDT')=>({baseAsset,symbol,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true});
async function credentials() {
  const values=new Map<string,string>();
  const c=new DummyCredentials({get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},delete:async k=>{values.delete(k);}});
  await c.save(1);return c;
}
async function multi() {
  let scenario:SpotScenario='multi';const r=new SpotOfflineReader(await credentials(),spotFixtureTransport(()=>scenario,()=>NOW),()=>NOW);
  await r.sync();return{r,set:(s:SpotScenario)=>{scenario=s;}};
}
test('多币映射使用明确 base/quote，不猜 symbol 后缀；暂停/非 Spot/非 USDT 不报价',()=> {
  const rows=[market('BTC','X1USDT'),{...market('ETH'),status:'BREAK'},{...market('BNB'),isSpotTradingAllowed:false},{...market('SOL'),quoteAsset:'USD'}];
  assert.deepEqual([...parseUsdtMarkets({symbols:rows})],[['BTC','X1USDT']]);
  const ambiguous=[market('BTC'),market('BTC','XBTCUSDT'),market('ETH')];
  assert.deepEqual([...parseUsdtMarkets({symbols:ambiguous})],[['ETH','ETHUSDT']]);
  assert.throws(()=>parseUsdtMarkets({symbols:[market('BTC'),market('ETH','BTCUSDT')]}));
  assert.throws(()=>parseUsdtMarkets({symbols:[{symbol:'BTCUSDT',quoteAsset:'USDT'}]}));
});
test('公开行情单币/批量 GET 白名单，参数编码正确，不携带认证或空全市场请求',()=> {
  for(const symbols of [['BTCUSDT'],['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT']]) {
    const request=publicTickerRequest(symbols), url=new URL(request.url);
    assert.equal(request.method,'GET');assert.equal(url.pathname,'/api/v3/ticker/price');
    assert.equal(request.headers,undefined);assert.equal(request.body,undefined);assert.equal(url.searchParams.has('signature'),false);
    assert.deepEqual(symbols.length===1?[url.searchParams.get('symbol')]:JSON.parse(url.searchParams.get('symbols')!),symbols);
  }
  for(const invalid of [[],['BTCUSDT','BTCUSDT'],['BTCUSDT&signature=x'],Array.from({length:101},(_,i)=>'X'+i)])assert.throws(()=>publicTickerRequest(invalid));
});
test('报价对象与数组解析、缺行保留缺价；额外字段不保存，fixture/external 来源分开',()=> {
  const result=parseTickerPrices([{symbol:'BTCUSDT',price:'50000',secret:'FIXED_FAKE_FIELD'}],['BTCUSDT','ETHUSDT'],AT,'fixture');
  assert.equal(result.get('BTCUSDT')!.value,'50000');assert.equal(result.has('ETHUSDT'),false);
  assert.equal(result.get('BTCUSDT')!.asOf,AT);assert.ok(!JSON.stringify([...result]).includes('FIXED_FAKE_FIELD'));
  const external=parseTickerPrices({symbol:'ETHUSDT',price:'2500'},['ETHUSDT'],AT,'external');
  assert.ok(external.get('ETHUSDT')!.source.startsWith('external:'));assert.ok(!external.get('ETHUSDT')!.source.includes('fixture'));
});
test('重复/未知/零/负数/非法报价和时间拒绝，不能产生可靠零价格',()=> {
  for(const data of [[{symbol:'BTCUSDT',price:'1'},{symbol:'BTCUSDT',price:'2'}],{symbol:'BTCUSD',price:'1'},{symbol:'BTCUSDT',price:'0'},{symbol:'BTCUSDT',price:'-1'},{symbol:'BTCUSDT',price:'NaN'},{symbol:'BTCUSDT',price:50000},{}])assert.throws(()=>parseTickerPrices(data,['BTCUSDT'],AT,'fixture'));
  assert.throws(()=>parseTickerPrices([],['BTCUSDT'],'bad time','fixture'));
});
test('六币种手算：37100 USDT、非 USDT -20% 损失 6620，占比/HHI；未知分类不虚构股票',async()=> {
  const {r}=await multi(), state=r.getState(), snapshot=Object.values(state.snapshots)[0], report=spotRisk(state,NOW);
  assert.equal(report.total,'37100.00000000');assert.equal(report.stressLoss,'6620.00000000');assert.equal(snapshot.positions.length,6);
  const expected={BTC:'20000.00000000',ETH:'5000.00000000',BNB:'5000.00000000',SOL:'3000.00000000',DOGE:'100.00000000',USDT:'4000.00000000'};
  for(const p of snapshot.positions)assert.equal(report.assetValues[assetKey(p.asset)],expected[p.asset.code as keyof typeof expected]);
  const btc=snapshot.positions.find(p=>p.asset.code==='BTC')!;assert.equal(report.assetWeights[assetKey(btc.asset)],'0.539084');
  // 独立整数手算：Σ市值² / 总额² = 475010000 / 1376410000。
  assert.equal(report.assetHhi,'0.345108');assert.equal(snapshot.positions.find(p=>p.asset.code==='DOGE')!.asset.type,'unknown');
  assert.equal(spotRisk(state,NOW,'USD').coveredSubtotal,null);await r.sync();assert.equal(spotRisk(r.getState(),NOW).total,'37100.00000000');
});
test('部分 ticker 缺失及无明确市场资产：保留数量，不回填旧价格、不伪造完整总额',async()=> {
  const {r,set}=await multi();set('multi-missing');await r.sync();const state=r.getState(), s=Object.values(state.snapshots)[0], report=spotRisk(state,NOW);
  assert.equal(report.coveredSubtotal,'32100.00000000');assert.equal(report.total,null);assert.equal(report.stressLoss,'5620.00000000');assert.equal(report.unpricedPositionCount,2);
  for(const code of ['ETH','NOPAIR'])assert.equal(s.positions.find(p=>p.asset.code===code)!.price,undefined);
  assert.equal(s.positions.find(p=>p.asset.code==='NOPAIR')!.quantity,'7');assert.equal(report.coverage,'partial');
});
test('多币价格过期/未来不计当前风险；全部过期保留历史，数量不丢失',async()=> {
  const {r}=await multi(), state=r.getState(), s=Object.values(state.snapshots)[0];
  for(const p of s.positions)p.price!.asOf=new Date(NOW-120_001).toISOString();
  const old=spotRisk(state,NOW);assert.equal(old.coveredSubtotal,null);assert.equal(old.stressLoss,null);assert.equal(old.lastKnownSubtotal,'37100.00000000');
  assert.equal(old.unpricedPositionCount,6);assert.equal(s.positions.find(p=>p.asset.code==='SOL')!.quantity,'20');
  for(const p of s.positions)p.price!.asOf=new Date(NOW+1).toISOString();assert.equal(spotRisk(state,NOW).coveredSubtotal,null);
});
test('市场元数据故障不猜交易对；仍保留六币种，仅同币种 USDT 可估值',async()=> {
  const base=spotFixtureTransport('multi',()=>NOW);let tickers=0;
  const t=createMockTransport(async(request,signal)=>{
    if(new URL(request.url).pathname==='/api/v3/exchangeInfo')return{status:200,data:{symbols:[{symbol:'ETHUSDT'}]}};
    if(new URL(request.url).pathname==='/api/v3/ticker/price')tickers++;
    return base.request(request,signal);
  });
  const r=new SpotOfflineReader(await credentials(),t,()=>NOW);await r.sync();const report=spotRisk(r.getState(),NOW);
  assert.equal(tickers,0);assert.equal(report.coveredSubtotal,'4000.00000000');assert.equal(report.total,null);assert.equal(report.unpricedPositionCount,5);
});
test('超过 100 交易对分批，后批失败只发布已定价部分，不继续或丢弃未定价数量',async()=> {
  const assets=Array.from({length:101},(_,i)=>'X'+i);let batches=0;
  const t=createMockTransport(async request=>{
    const url=new URL(request.url);
    if(url.pathname==='/api/v3/time')return{status:200,data:{serverTime:NOW}};
    if(url.pathname==='/api/v3/account')return{status:200,data:{uid:42,accountType:'SPOT',balances:assets.map(asset=>({asset,free:'1',locked:'0'}))}};
    if(url.pathname==='/api/v3/exchangeInfo')return{status:200,data:{symbols:assets.map(a=>market(a))}};
    batches++;if(batches===2)return{status:503,data:{}};
    const symbols:string[]=JSON.parse(url.searchParams.get('symbols')!);return{status:200,data:symbols.map(symbol=>({symbol,price:'1'}))};
  });
  const r=new SpotOfflineReader(await credentials(),t,()=>NOW);await r.sync();const report=spotRisk(r.getState(),NOW);
  assert.equal(batches,2);assert.equal(report.coveredSubtotal,'100.00000000');assert.equal(report.total,null);assert.equal(report.unpricedPositionCount,1);
  assert.equal(Object.values(r.getState().snapshots)[0].positions.length,101);
});
