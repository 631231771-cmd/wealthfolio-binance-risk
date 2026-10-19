import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {createRequire} from 'node:module';
const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:ReturnType<typeof createElement>)=>string};
import {DirectSpotPanel,describeDiagnostic,describeRetry,formatPrice} from '../src/direct-panel';
import type {DirectSpot,DirectDiagnostic} from '../src/direct-spot';
import type {BinanceCredentials} from '../src/credentials';
import type {SpotQuoteRefreshResult} from '../src/public-market';
import {spotSnapshot,spotShock} from '../src/spot';
import {assetKey,calculateRisk,type PortfolioState} from '../src/domain';
const at='2026-10-15T00:00:00.000Z';
function render(state:PortfolioState,connected:boolean,success=connected,busy=false,diagnostic?:DirectDiagnostic){
 const shocks=Object.fromEntries(Object.values(state.snapshots).flatMap(s=>s.positions.map(p=>[assetKey(p.asset),spotShock(p.asset.code)])));
 const report=calculateRisk(state,'USDT',[],shocks,{now:at,balanceMaxAgeMs:360000,priceMaxAgeMs:360000,fxMaxAgeMs:360000});
 const reader={valued:()=>({state,report}),getTimeObservations:()=>[],getPublicObservations:()=>[],getStatus:()=>({connected,busy,auto:false,success,nextDue:0,visible:true,retry:{canRetry:connected&&!busy,reason:busy?'in-flight':connected?'ready':'confirmation-required',waitSeconds:0}}),getDiagnostic:()=>diagnostic??({stage:connected?'complete':'idle',code:connected?'OK':'NOT_CONNECTED'})} as unknown as DirectSpot;
 return renderToStaticMarkup(createElement(DirectSpotPanel,{reader,credentials:{} as BinanceCredentials}));
}
function sample(){const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:[{asset:'BTC',free:'0.001',locked:'0'},{asset:'USDT',free:'15',locked:'0'},{asset:'NOPAIR',free:'2',locked:'0'}]},'external',at,at);for(const p of snapshot.positions)if(p.asset.code!=='NOPAIR')p.price={value:p.asset.code==='BTC'?'50000':'1',currency:'USDT',asOf:at,source:'external:test'};return {schemaVersion:1 as const,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready' as const,attemptedAt:at}}};}
function quoteResult(status:SpotQuoteRefreshResult['status'],overrides:Partial<SpotQuoteRefreshResult>={}):SpotQuoteRefreshResult{return {status,assetCount:2,candidateCount:2,marketCount:2,pricedCount:status==='complete'?2:0,retainedCount:0,missingQuoteCount:0,noMarketCount:0,failedRequestCount:0,unexaminedCount:0,requestCount:2,fallbackRequestCount:0,...overrides};}
test('主面板空态、连接设置默认关闭，保留明确本人确认项',()=>{
 const html=render({schemaVersion:1,accounts:[],snapshots:{},statuses:{}},false);
 assert.ok(html.includes('资产总览'));assert.ok(html.includes('Spot 已估值资产'));assert.ok(html.includes('连接后显示真实Spot持仓'));
 assert.match(html,/<details class="connection-settings">/);assert.ok(!html.includes('<details class="connection-settings" open'));
 assert.equal((html.match(/type="password"/g)??[]).length,2);assert.ok(html.includes('本人确认并首次查询'));assert.ok(html.includes('签名URL可能进入本机宿主错误日志'));
});
test('首次查询进行中或失败仍保留UID与凭据输入，只有成功快照后隐藏',()=>{
 const empty={schemaVersion:1 as const,accounts:[],snapshots:{},statuses:{}};
 for(const [connected,busy] of [[true,true],[true,false],[false,false]]){
  const html=render(empty,connected,false,busy);
  assert.equal((html.match(/type="password"/g)??[]).length,2);assert.ok(html.includes('预期账户 UID'));assert.ok(html.includes('本人确认并首次查询'));
 }
 const done=render(sample(),true,true);assert.ok(!done.includes('type="password"'));
});
test('真实持仓简表不混入开发样例，成功连接不渲染凭据输入',()=>{
 const html=render(sample(),true);assert.ok(html.includes('65.00'));assert.ok(!html.includes('压力情景损失'));assert.equal((html.match(/<th>/g)??[]).length,4);assert.ok(html.includes('NOPAIR'));assert.ok(html.includes('缺少有效价格'));assert.ok(html.includes('0.001'));
 assert.ok(!html.includes('type="password"'));for(const text of ['WRISKDEMO','37100','30000','导入本地余额快照'])assert.ok(!html.includes(text));
});
test('界面区分有效零和失效历史，不显示失效资产为0',()=>{
 const state=sample();state.snapshots[state.accounts[0].id].positions=[];assert.ok(render(state,true).includes('本次成功快照余额为零。'));assert.ok(render(state,true).includes('0.00'));
 const stale=sample();stale.statuses[stale.accounts[0].id].state='failed' as any;const html=render(stale,false);assert.ok(html.includes('保留上次持仓'));assert.ok(html.includes('余额已失效'));assert.ok(html.includes('aria-label="不可用"'));
});
test('小额非零报价显示实际精度，市值仍保留两位',()=>{
 const state=sample();state.snapshots[state.accounts[0].id].positions[0].price!.value='0.000000012345';
 const html=render(state,true);assert.ok(html.includes('0.000000012345'));assert.ok(html.includes('15.00'));
});
test('报价保留有效小数，重试原因与安全元数据不透传任意内容',()=>{
 for(const value of ['0.00000001','0.000000000000000000000000001','0.12345678','12345.6789'])assert.equal(formatPrice(value),value);
 assert.equal(formatPrice('0.00'),'0');
 assert.match(describeRetry({canRetry:false,reason:'exchange-limit',waitSeconds:90}),/交易所限流.*90秒/);
 assert.match(describeRetry({canRetry:false,reason:'backoff',waitSeconds:600}),/普通失败退避/);
 assert.match(describeRetry({canRetry:false,reason:'confirmation-required',waitSeconds:0}),/本人/);
 const detail=describeDiagnostic({stage:'permissions',code:'READ_ONLY_REJECTED',httpStatus:400,exchangeCode:-1022,permissionReason:'READING_DISABLED',permissionFields:[{field:'enableReading',value:false},{field:'signature=SECRET',value:true}]});
 assert.ok(detail.text.includes('未启用读取'));assert.equal(detail.metadata,'HTTP 400 · Binance -1022 · enableReading=false');assert.ok(!JSON.stringify(detail).includes('SECRET'));
 const auth=describeDiagnostic({stage:'permissions',code:'SPOT_AUTH',httpStatus:400,exchangeCode:-2008});assert.ok(auth.text.includes('连接资料未通过平台验证'));assert.ok(auth.text.includes('已保存不代表有效'));assert.equal(auth.metadata,'HTTP 400 · Binance -2008');
});
test('错误阶段与安全码明确区分，未知码不透传任意文本',()=>{
 const cases=[['permissions','READ_ONLY_REJECTED','只读权限'],['identity','UID_MISMATCH','UID'],['balance','SPOT_TIMEOUT','超时'],['disconnected','USER_DISCONNECTED','断开']] as const;
 for(const [stage,code,text] of cases){const value=describeDiagnostic({stage,code});assert.equal(value.code,code);assert.ok(value.text.includes(text));}
 const unknown=describeDiagnostic({stage:'balance',code:'https://bad/?signature=SECRET'});assert.equal(unknown.code,'UNKNOWN');assert.ok(!JSON.stringify(unknown).includes('SECRET'));
});

test('余额拒绝的主提示直接呈现HTTP/JSON/字段路径/固定原因，不只显示SPOT_INVALID',()=>{
 const html=render({schemaVersion:1,accounts:[],snapshots:{},statuses:{}},false,false,false,{stage:'balance',code:'SPOT_INVALID',httpStatus:200,jsonValid:true,layer:'account-validation',elapsedMs:100,validation:{layer:'balance',path:'balances[2].locked',reason:'DECIMAL_INVALID'}});
 const notice=html.split('class="monitor-toolbar"')[0];for(const text of ['HTTP 200','JSON有效','账户字段校验','balances[2].locked','DECIMAL_INVALID'])assert.ok(notice.includes(text));
});

test('公开行情成功不显示错误提示且余额连接仍标记已连接',()=>{
 const html=render(sample(),true,true,false,{stage:'quotes',code:'QUOTE_COMPLETE',quote:quoteResult('complete')});
 const main=html.split('class="monitor-toolbar"')[0];
 assert.match(main,/class="status-badge is-good">已连接/);assert.match(main,/data-quote-state="success"/);
 assert.ok(main.includes('公开行情已更新'));assert.ok(!main.includes('notice-error'));assert.ok(!main.includes('公开报价未完成'));
});

test('无市场与无候选以中性行情信息显示，不冒充余额连接错误',()=>{
 for(const [code,status,text] of [['QUOTE_NO_MARKET','no-market','没有可用的USDT现货交易对'],['QUOTE_NO_CANDIDATES','no-candidates','没有需要查询的USDT现货交易对']] as const){
  const html=render(sample(),true,true,false,{stage:'quotes',code,quote:quoteResult(status)}),main=html.split('class="monitor-toolbar"')[0];
  assert.match(main,/class="status-badge is-good">已连接/);assert.match(main,/data-quote-state="info"/);
  assert.ok(html.includes(text));assert.ok(!main.includes('notice-error'));assert.ok(!main.includes('Spot余额读取未完成'));
 }
});

test('部分行情和预算截断提示覆盖不足但不冒充完整成功',()=>{
 for(const [code,status,text] of [['QUOTE_PARTIAL','partial','公开行情部分可用'],['QUOTE_BUDGET_LIMITED','budget-limited','公开行情覆盖受限']] as const){
  const html=render(sample(),true,true,false,{stage:'quotes',code,quote:quoteResult(status,{pricedCount:1,unexaminedCount:1,budgetReason:status==='budget-limited'?'candidate-cap':undefined})}),main=html.split('class="monitor-toolbar"')[0];
  assert.match(main,/data-quote-state="warning"/);assert.match(main,/notice-warning/);assert.ok(html.includes(text));assert.ok(!main.includes('notice-error'));assert.ok(!main.includes('公开行情已更新'));
 }
});

test('公开行情失败明确归属行情且不撤销已验证Spot连接和持仓',()=>{
 const q=quoteResult('request-failed',{marketCount:2,pricedCount:0,failedRequestCount:1,unexaminedCount:0,requestCount:3});
 const html=render(sample(),true,true,false,{stage:'quotes',code:'QUOTE_REQUEST_FAILED',quote:q}),main=html.split('class="monitor-toolbar"')[0];
 assert.match(main,/class="status-badge is-good">已连接/);assert.match(main,/公开行情更新失败/);
 assert.ok(main.includes('余额数量保留，报价等待重试'));assert.ok(html.includes('公开行情请求失败'));assert.ok(html.includes('0.001'));assert.ok(html.includes('65.00'));
 assert.ok(html.includes('2 / 3 项已估值'));assert.ok(!main.includes('Spot余额读取未完成'));
 assert.ok(html.includes('未检查候选0'));assert.ok(!main.includes('未覆盖0'));
});

test('行情超时限流无效响应及生命周期状态不冒充余额认证错误',()=>{
 const cases=[['QUOTE_TIMEOUT','公开行情等待超时','error'],['QUOTE_RATE_LIMIT','公开行情受到限流','error'],['QUOTE_INVALID','公开行情响应无效','error'],['QUOTE_DISCONNECTED','公开行情已暂停','info'],['QUOTE_BUSY','公开行情请求进行中','info']] as const;
 for(const [code,title,severity] of cases){
  const html=render(sample(),true,true,false,{stage:'quotes',code}),main=html.split('class="monitor-toolbar"')[0];
  assert.match(main,new RegExp(`data-quote-state="${severity}"`));assert.ok(main.includes(title));
  assert.match(main,/class="status-badge is-good">已连接/);assert.ok(!main.includes('Spot余额读取未完成'));
 }
});

test('过期余额仍为已连接会话，不在首页堆叠认证失败提示；自动同步需本人勾选',()=>{
 const state=sample();state.statuses[state.accounts[0].id].state='failed' as any;
 const html=render(state,true,true),main=html.split('class="monitor-toolbar"')[0];
 assert.match(main,/class="status-badge is-good">已连接/);assert.doesNotMatch(main,/数据失效|当前数据不可用|notice-error/);
 assert.match(html,/我已逐项核对本次持仓，同意自动同步余额/);
 assert.match(html,/<button disabled="">确认开启 · 每5分钟<\/button>/);
 assert.match(html,/aria-label="不可用"/);assert.ok(!html.includes('type="password"'));
});
