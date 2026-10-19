// DS 独立回归：v0.2.1 展示可信度。
// 全部为虚构余额与内存数据，不访问网络、不读凭据。
// 本文件只断言"页面是否把已知事实说清楚"，不改动风险核心或刷新调度。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {createRequire} from 'node:module';
const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:ReturnType<typeof createElement>)=>string};
import {spotSnapshot,spotRisk} from '../src/spot';
import {portfolioPresentation,assetTone,displayAmount as money,type Valuation,type Reference} from '../src/portfolio-view';
import {PortfolioOverview} from '../src/portfolio-overview';
import {DirectSpotPanel} from '../src/direct-panel';
import type {DirectSpot,DirectDiagnostic,DirectRetry} from '../src/direct-spot';
import type {BinanceCredentials} from '../src/credentials';
import type {SpotQuoteRefreshResult} from '../src/public-market';
import type {PortfolioState} from '../src/domain';

const NOW=Date.parse('2026-10-19T10:00:00Z');
const at=(offset=0)=>new Date(NOW+offset).toISOString();
const AT=at();

// 虚构账户：USDC 为主仓，含微额、无市场资产与计价单位。
// 已定价合计 15,484.46；NOPAIR 无价，因此永远不是"完整估值"。
const PRICES:Record<string,string>={USDC:'0.9987',BTC:'65000',DUST:'0.02',USDT:'1'};
const BALANCES=[{asset:'USDC',free:'12000',locked:'0'},{asset:'BTC',free:'0.05',locked:'0'},{asset:'DUST',free:'3',locked:'0'},{asset:'USDT',free:'250',locked:'0'},{asset:'NOPAIR',free:'0.0000001',locked:'0'}];

function fixture(priced=true):Valuation{
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:BALANCES},'external',AT,AT);
 if(priced)for(const p of snapshot.positions)if(p.asset.code!=='NOPAIR')p.price={value:PRICES[p.asset.code],currency:'USDT',asOf:AT,source:'external:test'};
 const state:PortfolioState={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:AT}}};
 return {state,report:spotRisk(state,NOW)};
}
function frozen(value:Valuation):Reference{return {...structuredClone(value),at:AT};}
function staleOf(value:Valuation,offset=400_000):Valuation{
 const state=structuredClone(value.state);
 return {state,report:spotRisk(state,NOW+offset)};
}
// 新余额快照：同数量或改数量，可选是否带价。
function rebalance(value:Valuation,offset:number,mutate:(positions:PortfolioState['snapshots'][string]['positions'])=>void,priced:boolean):Valuation{
 const state=structuredClone(value.state),snapshot=Object.values(state.snapshots)[0];
 snapshot.asOf=at(offset);snapshot.collectionStartedAt=snapshot.asOf;snapshot.collectionEndedAt=snapshot.asOf;
 snapshot.batchId=`external:spot:${snapshot.asOf}`;
 for(const p of snapshot.positions)delete p.price;
 mutate(snapshot.positions);
 // 生产路径里 USDT 始终按同币种单位计价，即使公开报价全部失败。
 for(const p of snapshot.positions){
  if(p.asset.code==='USDT')p.price={value:'1',currency:'USDT',asOf:snapshot.asOf,source:'unit:USDT/USDT'};
  else if(priced&&PRICES[p.asset.code])p.price={value:PRICES[p.asset.code],currency:'USDT',asOf:snapshot.asOf,source:'external:test'};
 }
 return {state,report:spotRisk(state,NOW+offset)};
}
const render=(value:Valuation,reference:Reference|null=null)=>renderToStaticMarkup(createElement(PortfolioOverview,{value,reference}));
const strip=(html:string)=>html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
const hero=(html:string)=>strip(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)![1]);
const toneOf=(html:string,code:string)=>html.split(`aria-label="查看 ${code} 配置详情"`)[1]?.match(/tone-(\d)/)?.[1];

// ── 1. 同一份余额快照过期：历史配置与微额折叠保持同一口径 ─────────────
test('同一快照过期后，历史配置、占比与微额折叠来自同一份冻结估值',()=>{
 const value=fixture(),reference=frozen(value),p=portfolioPresentation(staleOf(value),reference);
 const expected=portfolioPresentation(reference);
 assert.equal(p.historical,true);
 assert.deepEqual(p.view.allocation.map(r=>[r.code,r.value,r.weight]),expected.view.allocation.map(r=>[r.code,r.value,r.weight]));
 assert.deepEqual(p.view.dust.map(r=>r.code),['DUST']);
 assert.deepEqual(p.view.rows.map(r=>r.quantity),expected.view.rows.map(r=>r.quantity));
 assert.equal(p.displayed.report.coveredSubtotal,'15484.46000000');

 const html=render(staleOf(value),reference);
 assert.match(html,/历史资产配置/);
 assert.match(html,/历史持仓/);
 assert.match(html,/已计入当时总值/);
 assert.match(html,/不代表当前资产/);
 // 历史配置不得借用当前（已失效）的空白状态
 assert.doesNotMatch(html,/等待可用估值/);
 assert.ok(html.includes('15,484.46'));
});

// ── 2a. 新快照数量相同、时间变化 ───────────────────────────────────
test('新快照数量相同但时间变化：不复用旧记录，也不把旧总值当当前值',()=>{
 const value=fixture(),reference=frozen(value);
 const same=rebalance(value,60_000,()=>{},false);
 const p=portfolioPresentation(same,reference);
 assert.equal(p.historical,false);
 assert.equal(p.sameBalances,false);
 // 数量必须来自新快照，不能被旧记录替换
 assert.deepEqual([...p.view.rows.map(r=>r.quantity)].sort(),['0.0000001','0.05','12000','250','3'].sort());
 assert.equal(same.report.coveredSubtotal,'250.00000000'); // 仅 USDT 可计价
 const html=render(same,reference);
 assert.equal(hero(html).includes('250.00'),true);
 assert.equal(hero(html).includes('15,484.46'),false); // 旧总值不得出现在主数值
 assert.match(html,/此前估值 15,484.46 USDT/);          // 只作为明确标注的历史参考
 assert.match(html,/属于另一份余额快照/);
});
test('新快照数量相同且报价有效时，总值与排序完全按当前快照计算',()=>{
 const value=fixture(),reference=frozen(value);
 const same=rebalance(value,60_000,()=>{},true);
 const p=portfolioPresentation(same,reference);
 assert.equal(p.historical,false);
 assert.equal(same.report.coveredSubtotal,'15484.46000000');
 const html=render(same,reference);
 assert.equal(hero(html).includes('15,484.46'),true);
 assert.doesNotMatch(html,/历史快照/);
 assert.doesNotMatch(html,/此前估值/);
});

// ── 2b. 数量确实变化 ─────────────────────────────────────────────
test('数量确实变化：旧金额不得贴到新数量上，旧微额分类也不得沿用',()=>{
 const value=fixture(),reference=frozen(value);
 const changed=rebalance(value,60_000,positions=>{
  positions.find(p=>p.asset.code==='USDC')!.quantity='9000';
  positions.find(p=>p.asset.code==='DUST')!.quantity='5000'; // 旧价下 100 USDT，不再是微额
 },false);
 const p=portfolioPresentation(changed,reference);
 assert.equal(p.historical,false);
 assert.ok(p.view.visible.some(r=>r.code==='USDC'&&r.quantity==='9000'&&r.value===undefined));
 assert.ok(p.view.visible.some(r=>r.code==='DUST'&&r.quantity==='5000'&&r.value===undefined));
 assert.equal(p.view.dust.length,0);
 const html=render(changed,reference);
 assert.match(html,/9000/);
 assert.match(html,/5000/);
 assert.equal(hero(html).includes('11,984.40'),false);
 assert.equal(hero(html).includes('15,484.46'),false);
});

// ── 3. 主仓 USDC 缺价 ────────────────────────────────────────────
test('主仓USDC缺价时显示已定价小计与缺价项数，不冒充完整总值',()=>{
 const value=fixture(),snapshot=Object.values(value.state.snapshots)[0];
 delete snapshot.positions.find(p=>p.asset.code==='USDC')!.price;
 const current:Valuation={state:value.state,report:spotRisk(value.state,NOW)};
 const view=portfolioPresentation(current);
 assert.equal(view.current.priced,3);           // BTC / DUST / USDT
 assert.equal(view.current.rows.length,5);
 assert.equal(current.report.complete,false);
 assert.equal(current.report.total,null);

 const html=render(current);
 assert.match(html,/已定价小计/);
 assert.match(html,/3 \/ 5 项已估值/);
 assert.match(html,/缺价 2 项/);                // USDC + NOPAIR
 assert.equal(hero(html).includes('3,500.06'),true);
 assert.equal(hero(html).includes('15,484.46'),false);
 assert.doesNotMatch(html,/Spot 资产总值/);
 // 缺价资产仍必须可见，且保留数量
 assert.match(html,/USDC/);
 assert.match(html,/12000/);
 assert.match(html,/缺少有效价格/);
});

// ── 4. 历史配置不进入当前风险 ─────────────────────────────────────
test('历史配置只用于展示，不进入当前风险，也不修改当前数量',()=>{
 const value=fixture(),reference=frozen(value),stale=staleOf(value);
 const before=JSON.stringify(stale.state);
 const p=portfolioPresentation(stale,reference);
 assert.equal(p.historical,true);
 assert.equal(JSON.stringify(stale.state),before); // 展示层不得回写状态
 assert.equal(stale.report.coveredSubtotal,null);
 assert.equal(stale.report.stressLoss,null);
 assert.notEqual(reference.report.stressLoss,null); // 历史值确实存在
 const html=render(stale,reference);
 assert.match(html,/历史配置不参与当前风险计算/);
 assert.equal(html.includes(money(reference.report.stressLoss)),false); // 不得泄漏到总览
});

// ── 5. 正常零余额 vs 无有效数据 ───────────────────────────────────
test('成功零余额与无有效数据在数值、标签与空态上明确区分',()=>{
 const value=fixture(),snapshot=Object.values(value.state.snapshots)[0];
 snapshot.positions=[];
 const zero:Valuation={state:value.state,report:spotRisk(value.state,NOW)};
 const zeroHtml=render(zero);
 assert.equal(hero(zeroHtml).includes('0.00'),true);
 assert.match(zeroHtml,/本次成功快照余额为零。/);
 assert.match(zeroHtml,/零余额不计算占比/);
 assert.doesNotMatch(zeroHtml,/aria-label="不可用"/);
 assert.doesNotMatch(zeroHtml,/历史快照/);

 const empty:Valuation={state:{schemaVersion:1,accounts:[],snapshots:{},statuses:{}},report:spotRisk({schemaVersion:1,accounts:[],snapshots:{},statuses:{}},NOW)};
 const emptyHtml=render(empty);
 assert.equal(hero(emptyHtml).includes('—'),true);
 assert.match(emptyHtml,/aria-label="不可用"/);
 assert.match(emptyHtml,/连接后显示你的 Spot 资产/);
 assert.equal(hero(emptyHtml).includes('0.00'),false);

 const expiredNoRef=render(staleOf(fixture()));
 assert.equal(hero(expiredNoRef).includes('—'),true);
 assert.equal(hero(expiredNoRef).includes('0.00'),false);
 assert.doesNotMatch(expiredNoRef,/历史快照/);
});

// ── 6. 报价失败 / 退避 / 限流文案 ────────────────────────────────
const quoteResult=(status:SpotQuoteRefreshResult['status'],o:Partial<SpotQuoteRefreshResult>={}):SpotQuoteRefreshResult=>({status,assetCount:3,candidateCount:3,marketCount:3,pricedCount:0,failedRequestCount:0,unexaminedCount:0,requestCount:2,fallbackRequestCount:0,...o});
const retry=(reason:DirectRetry['reason'],waitSeconds=0):DirectRetry=>({canRetry:reason==='ready',reason,waitSeconds});
function panel(diagnostic:DirectDiagnostic,quoteRetry:DirectRetry,success=true){
 const state=fixture().state;
 const reader={
  valued:()=>fixture(),
  getStatus:()=>({connected:true,busy:false,auto:false,success,nextDue:0,quoteDue:0,quoteRetry,visible:true,retry:retry('ready')}),
  getDiagnostic:()=>diagnostic,
  getTimeObservations:()=>[],getPublicObservations:()=>[],
  getReference:()=>null,getHistoricalQuotes:()=>new Map(),
  setVisible:()=>{},tick:async()=>{},sync:async()=>{},refreshQuotes:async()=>{},authorize:()=>{},disconnect:()=>{},
 } as unknown as DirectSpot;
 const credentials={isSaved:async()=>true} as unknown as BinanceCredentials;
 return renderToStaticMarkup(createElement(DirectSpotPanel,{reader,credentials}));
}
test('报价失败、退避与限流时，页面不冒充刚刚更新成功',()=>{
 const cases:[DirectDiagnostic,DirectRetry,string,string][]=[
  [{stage:'quotes',code:'QUOTE_REQUEST_FAILED',quote:quoteResult('request-failed',{failedRequestCount:1})},retry('backoff',120),'公开行情更新失败','行情等待重试 · 120秒'],
  [{stage:'quotes',code:'QUOTE_RATE_LIMIT',quote:quoteResult('request-failed',{failedRequestCount:1})},retry('exchange-limit',60),'公开行情受到限流','行情等待限流冷却 · 60秒'],
  [{stage:'quotes',code:'QUOTE_TIMEOUT',quote:quoteResult('request-failed')},retry('backoff',240),'公开行情等待超时','行情等待重试 · 240秒'],
 ];
 for(const [diagnostic,quoteRetry,title,cadence] of cases){
  const html=panel(diagnostic,quoteRetry),header=html.split('class="monitor-toolbar"')[0];
  assert.ok(html.includes(title),title);
  assert.equal(html.includes('公开行情已更新'),false,title);
  assert.equal(html.includes('行情每分钟更新'),false,title); // 退避中不得声称每分钟更新
  assert.ok(html.includes(cadence),cadence);
  assert.match(header,/class="status-badge is-good">已连接/); // 连接仍然有效，不冒充认证失败
 }
});
test('报价正常时仍明确显示每分钟更新，失败与成功文案互斥',()=>{
 const html=panel({stage:'quotes',code:'QUOTE_COMPLETE',quote:quoteResult('complete',{pricedCount:3})},retry('ready'));
 assert.ok(html.includes('公开行情已更新'));
 assert.ok(html.includes('行情每分钟更新'));
 assert.equal(html.includes('行情等待重试'),false);
 assert.equal(html.includes('公开行情更新失败'),false);
});

// ── 配色稳定性 ───────────────────────────────────────────────────
test('配置配色与资产身份绑定，排序变化不换色',()=>{
 const a=fixture();
 const b=structuredClone(a);
 // 反转相对市值：让 USDC 不再排第一
 b.state.snapshots[Object.keys(b.state.snapshots)[0]].positions.find(p=>p.asset.code==='BTC')!.quantity='1';
 b.report=spotRisk(b.state,NOW);
 const ha=render(a),hb=render(b);
 for(const code of ['USDC','BTC','DUST','USDT']){
  assert.equal(toneOf(ha,code),toneOf(hb,code),code);
 }
 assert.equal(assetTone('USDC'),assetTone('USDC'));
 assert.notEqual(assetTone('USDC'),assetTone('BTC'));
});
