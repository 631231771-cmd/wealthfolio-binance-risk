import test from 'node:test';
import type { NetworkAPI,NetworkResponse } from '@wealthfolio/addon-sdk';
import assert from 'node:assert/strict';
import {DirectSpot,assertReadOnly,DIRECT_INTERVAL,DIRECT_TTL,restrictionRequest} from '../src/direct-spot';
import {BinanceCredentials} from '../src/credentials';
import {SpotQuoteReader} from '../src/public-market';
import {describeDiagnostic} from '../src/direct-panel';
import {signPayload} from '../src/binance';
const permissions={enableReading:true,ipRestrict:true,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
const ack={risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true};
async function harness(timeout=100){
 let now=Date.parse('2026-10-15T00:00:00Z'),calls:string[]=[],mode='ok',quoteFailure=false,release:(()=>void)|undefined,blockedPath='';
 let privateResponse:NetworkResponse|undefined;
 const values=new Map<string,string>(),credentials=new BinanceCredentials({set:async(k,v)=>{values.set(k,v);},get:async k=>values.get(k)??null,delete:async k=>{values.delete(k);}});
 await credentials.save('TEST_KEY_NOT_REAL','TEST_SECRET_NOT_REAL');
 const network:Pick<NetworkAPI,'request'>={request:async(req):Promise<NetworkResponse>=>{
  const u=new URL(req.url);calls.push(u.pathname);
  assert.equal(req.method,'GET');assert.ok(['data-api.binance.vision','api.binance.com'].includes(u.hostname));
  const privateRequest=u.hostname==='api.binance.com'&&u.pathname!=='/api/v3/time';
  if(privateRequest){assert.ok(['/api/v3/account','/sapi/v1/account/apiRestrictions'].includes(u.pathname));const raw=u.searchParams.get('timestamp')!;assert.equal(u.searchParams.get('signature'),signPayload(`timestamp=${raw}&recvWindow=5000`,'TEST_SECRET_NOT_REAL'));assert.equal(req.headers?.['X-MBX-APIKEY'],'TEST_KEY_NOT_REAL');}
  else assert.equal(req.headers,undefined);
  if(u.pathname===blockedPath)await new Promise<void>(r=>{release=r;});
  if(u.pathname==='/api/v3/ticker/price'&&quoteFailure)return {status:503,headers:{},body:'SENSITIVE fake response signature=RAW'};
  if(privateResponse&&privateRequest)return privateResponse;
  if(mode==='network'&&privateRequest)throw new Error('TEST_SECRET_NOT_REAL signature=RAW URL '+req.url);
  if(mode==='limit'&&privateRequest)return {status:429,headers:{'Retry-After':'3600'},body:'<html>WAF</html>'};
  let body:unknown;
  if(u.pathname.endsWith('/time'))body={serverTime:now};
  else if(u.pathname.endsWith('/apiRestrictions'))body=mode==='trade'?{...permissions,enableSpotAndMarginTrading:true}:mode==='no-ip'?{...permissions,ipRestrict:false}:permissions;
  else if(u.pathname.endsWith('/account'))body={uid:mode==='uid'?2:1,accountType:'SPOT',balances:mode==='zero'?[]:mode==='missing'?null:[{asset:'BTC',free:'0.001',locked:'0'},{asset:'USDT',free:'12',locked:'3'},{asset:'NOPAIR',free:'2',locked:'0'}].filter(p=>mode!=='complete'||p.asset!=='NOPAIR')};
  else if(u.pathname.endsWith('/exchangeInfo'))body={symbols:[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}]};
  else body=[{symbol:'BTCUSDT',price:'50000'}];
  return {status:200,headers:{},body:JSON.stringify(body)};
 }};
 const quotes=new SpotQuoteReader(network,()=>now),reader=new DirectSpot(credentials,network,quotes,()=>now,timeout);
 reader.setVisible(true);
 return {reader,calls,credentials,setResponse:(r:NetworkResponse|undefined)=>{privateResponse=r;},setMode:(m:string)=>{mode=m;},setQuoteFailure:(value:boolean)=>{quoteFailure=value;},advance:(ms:number)=>{now+=ms;},block:(path:string)=>{blockedPath=path;},release:()=>release?.()};
}

test('HTTP400先解析数字业务码，诊断不含msg、URL或认证信息',async()=>{
 for(const [exchangeCode,code] of [[-1022,'SPOT_SIGNATURE'],[-1021,'SPOT_CLOCK'],[-2008,'SPOT_AUTH'],[-2015,'SPOT_AUTH'],[-9999,'SPOT_INVALID']] as const){
  const h=await harness();h.reader.authorize('1',ack);
  h.setResponse({status:400,headers:{},body:JSON.stringify({code:exchangeCode,msg:'TEST_SECRET_NOT_REAL https://bad/?signature=RAW'})});
  await h.reader.sync();const d=h.reader.getDiagnostic();
  assert.equal(d.code,code);assert.equal((d as any).httpStatus,400);assert.equal((d as any).exchangeCode,exchangeCode);
  assert.ok(!/TEST_SECRET|signature|https:|msg/.test(JSON.stringify(d)));
 }
});
test('修正普通认证失败后重新确认可重试，不继承旧10分钟退避',async()=>{
 const h=await harness();h.reader.authorize('1',ack);h.setResponse({status:400,headers:{},body:'{"code":-1022}'});await h.reader.sync();
 h.reader.disconnect();await h.credentials.save('TEST_KEY_NOT_REAL','TEST_SECRET_NOT_REAL');h.reader.authorize('1',ack);h.setResponse(undefined);
 await h.reader.sync();assert.equal(h.reader.getStatus().success,true);await h.reader.refreshQuotes();assert.equal(h.reader.valued().report.coveredSubtotal,'65.00000000');
});
test('只读拒绝明确区分缺字段、读取关闭和额外权限，IP布尔字段仍必须完整',()=>{
 for(const [value,code] of [[{...permissions,enableReading:false},'READING_DISABLED'],[{...permissions,ipRestrict:undefined},'PERMISSION_FIELDS_INCOMPLETE'],[{...permissions,enableWithdrawals:true},'EXTRA_PERMISSION'],[{...permissions,enableWithdrawals:undefined},'PERMISSION_FIELDS_INCOMPLETE']] as const){
  assert.throws(()=>assertReadOnly(value),(e:any)=>e.code===code);
 }
});
test('429/418非JSON冷却不被断开、保存、重连或自动开关清除',async()=>{
 for(const status of [429,418]){
  const h=await harness();h.reader.authorize('1',ack);await h.reader.sync();h.reader.setAuto(true,true);
  h.setResponse({status,headers:{'ReTrY-AfTeR':'90'},body:'<html>TEST_SECRET_NOT_REAL signature=RAW</html>'});await h.reader.sync();
  assert.equal(h.reader.getDiagnostic().httpStatus,status);assert.equal(h.reader.getDiagnostic().code,'SPOT_RATE_LIMIT');
  const due=h.reader.getStatus().nextDue;h.reader.setAuto(false);h.reader.setAuto(true,true);assert.ok(h.reader.getStatus().nextDue>=due);
  h.reader.disconnect();await h.credentials.save('TEST_KEY_NOT_REAL','TEST_SECRET_NOT_REAL');h.reader.authorize('1',ack);
  const count=h.calls.length;assert.equal(h.reader.getStatus().retry.reason,'exchange-limit');assert.equal(h.reader.getStatus().retry.waitSeconds,90);
  await assert.rejects(h.reader.sync());assert.equal(h.calls.length,count);assert.equal(h.reader.getStatus().nextDue,due);
  h.advance(89_999);await assert.rejects(h.reader.sync());assert.equal(h.calls.length,count);
  h.advance(1);h.setResponse(undefined);await h.reader.sync();assert.equal(h.reader.getStatus().success,true);
 }
});
test('普通网络失败保留自动退避，明确断开并重新确认后允许受控重试',async()=>{
 const h=await harness();h.reader.authorize('1',ack);h.setMode('network');await h.reader.sync();
 assert.equal(h.reader.getStatus().retry.reason,'backoff');assert.equal(h.reader.getStatus().retry.waitSeconds,600);
 const count=h.calls.length;await assert.rejects(h.reader.sync(),(e:any)=>e.code==='busy');assert.equal(h.calls.length,count);
 h.reader.disconnect();assert.equal(h.reader.getStatus().retry.reason,'confirmation-required');h.reader.authorize('1',ack);h.setMode('ok');await h.reader.sync();assert.equal(h.reader.getStatus().success,true);
});
test('无可靠Retry-After时429和418保守冷却，超大HTML也不影响限流分类',async()=>{
 for(const [status,seconds] of [[429,60],[418,1800]]){
  const h=await harness();h.reader.authorize('1',ack);h.setResponse({status,headers:{'Retry-After':'invalid'},body:'X'.repeat(2*1024*1024+1)});await h.reader.sync();
  assert.equal(h.reader.getDiagnostic().code,'SPOT_RATE_LIMIT');assert.equal(h.reader.getStatus().retry.waitSeconds,seconds);
 }
});
test('错误响应受字符/UTF8大小限制，非JSON保留HTTP分类且不猜业务码',async()=>{
 const cases=[
  {status:403,body:'<html>denied</html>',expected:'SPOT_FORBIDDEN'},
  {status:500,body:'upstream failed',expected:'SPOT_NETWORK'},
  {status:400,body:'not-json',expected:'SPOT_INVALID'},
  {status:400,body:'{"code":"-1022","msg":"TEST_SECRET_NOT_REAL"}',expected:'SPOT_INVALID'},
  {status:400,body:JSON.stringify({code:-1022,msg:'X'.repeat(2*1024*1024)}),expected:'SPOT_INVALID'},
  {status:400,body:JSON.stringify({code:-1022,msg:'密'.repeat(800_000)}),expected:'SPOT_INVALID'}
 ];
 for(const c of cases){const h=await harness();h.reader.authorize('1',ack);h.setResponse({status:c.status,headers:{},body:c.body});await h.reader.sync();const d=h.reader.getDiagnostic();assert.equal(d.code,c.expected);assert.equal(d.httpStatus,c.status);assert.equal(d.exchangeCode,undefined);assert.ok(JSON.stringify(d).length<250);}
});
test('权限诊断只含必要已知字段，不回传未知权限名和完整响应',async()=>{
 for(const [body,reason,field] of [[{...permissions,enableReading:false},'READING_DISABLED','enableReading'],[{...permissions,ipRestrict:undefined},'PERMISSION_FIELDS_INCOMPLETE','ipRestrict'],[{...permissions,enableWithdrawals:true},'EXTRA_PERMISSION','enableWithdrawals'],[{...permissions,enableWithdrawals:'false'},'PERMISSION_FIELDS_INCOMPLETE','enableWithdrawals'],[{...permissions,'TEST_SECRET_NOT_REAL signature=RAW':true},'EXTRA_PERMISSION',undefined]] as const){
  const h=await harness();h.reader.authorize('1',ack);h.setResponse({status:200,headers:{},body:JSON.stringify(body)});await h.reader.sync();const d=h.reader.getDiagnostic();
  assert.equal(d.permissionReason,reason);assert.equal(h.reader.getStatus().connected,false);assert.ok(!h.calls.includes('/api/v3/account'));
  if(field)assert.equal(d.permissionFields?.[0].field,field);assert.ok(!/TEST_SECRET|signature/.test(JSON.stringify(d)));
 }
});
test('SDK超时和断开后的迟到429仍建立冷却，较长Retry-After不降为60秒',async()=>{
 const h=await harness(5);h.reader.authorize('1',ack);h.block('/sapi/v1/account/apiRestrictions');h.setResponse({status:429,headers:{'Retry-After':'172800'},body:'not-json'});
 await h.reader.sync();assert.equal(h.reader.getDiagnostic().code,'SPOT_TIMEOUT');h.reader.disconnect();h.reader.authorize('1',ack);await assert.rejects(h.reader.sync());
 h.release();await new Promise(r=>setTimeout(r,1));assert.equal(h.reader.getStatus().retry.reason,'exchange-limit');assert.equal(h.reader.getStatus().retry.waitSeconds,172800);await assert.rejects(h.reader.sync());
});
test('直接请求只读权限白名单、固定签名构造',()=>{
 assert.doesNotThrow(()=>assertReadOnly(permissions));
 for(const value of [{...permissions,enableWithdrawals:true},{...permissions,enableReading:false},{...permissions,ipRestrict:'false'},{...permissions,enableNewTrading:true},{enableReading:true}])assert.throws(()=>assertReadOnly(value));
 const req=restrictionRequest('FAKE','FAKE',123);assert.equal(new URL(req.url).pathname,'/sapi/v1/account/apiRestrictions');assert.equal(req.method,'GET');
});
test('本人选择小额纯只读无强制IP：false可读，字段缺失/额外权限仍拒绝',async()=>{
 assert.doesNotThrow(()=>assertReadOnly({...permissions,ipRestrict:false}));
 for(const value of [{...permissions,ipRestrict:undefined},{...permissions,ipRestrict:false,enableReading:false},{...permissions,ipRestrict:false,enableWithdrawals:true},{...permissions,ipRestrict:false,enableNewTrading:true}])assert.throws(()=>assertReadOnly(value));
 const h=await harness();h.reader.authorize('1',ack);h.setMode('no-ip');await h.reader.sync();assert.equal(h.reader.getStatus().success,true);assert.equal(h.reader.valued().report.coveredSubtotal,'15.00000000');await h.reader.refreshQuotes();assert.equal(h.reader.valued().report.coveredSubtotal,'65.00000000');
});
test('必须本人确认；权限先于余额；真实来源、缺价与重复不累加',async()=>{
 const h=await harness();await assert.rejects(h.reader.sync());assert.equal(h.calls.length,0);
 assert.throws(()=>h.reader.authorize('1',{...ack,risk:false}));h.reader.authorize('1',ack);await h.reader.sync();await h.reader.refreshQuotes();
 assert.ok(h.calls.indexOf('/sapi/v1/account/apiRestrictions')<h.calls.indexOf('/api/v3/account'));
 for(let i=0;i<2;i++){await h.reader.sync();const v=h.reader.valued();assert.equal(v.report.coveredSubtotal,'65.00000000');assert.equal(v.report.stressLoss,'10.00000000');assert.equal(v.report.total,null);assert.equal(v.report.unpricedPositionCount,1);assert.equal(Object.values(v.state.snapshots)[0].dataMode,'external');assert.equal(Object.values(v.state.snapshots)[0].positions.length,3);}
});
test('单独更新行情只读取当前余额资产代码，不再请求账户/权限接口或混入模拟数量',async()=>{
 const h=await harness();h.reader.authorize('1',ack);await h.reader.sync();
 const privateCount=()=>h.calls.filter(path=>path==='/api/v3/account'||path==='/sapi/v1/account/apiRestrictions').length;
 const before=privateCount(),balance=h.reader.getState().snapshots[Object.keys(h.reader.getState().snapshots)[0]].positions.map(p=>p.quantity);
 await h.reader.refreshQuotes();
 assert.equal(privateCount(),before);assert.deepEqual(h.reader.getState().snapshots[Object.keys(h.reader.getState().snapshots)[0]].positions.map(p=>p.quantity),balance);
 assert.ok(h.calls.includes('/api/v3/exchangeInfo'));assert.ok(h.calls.includes('/api/v3/ticker/price'));
});
test('公开报价503不显示同步成功、不改动已验证余额数量且诊断不带敏感响应',async()=>{
 const h=await harness();h.reader.authorize('1',ack);await h.reader.sync();
 const account=Object.keys(h.reader.getState().snapshots)[0];
 const before=h.reader.getState().snapshots[account].positions.map(position=>position.quantity);
 const privateCallsBefore=h.calls.filter(path=>path==='/api/v3/account'||path==='/sapi/v1/account/apiRestrictions').length;
 h.setQuoteFailure(true);await h.reader.refreshQuotes();
 const diagnostic=h.reader.getDiagnostic(),detail=describeDiagnostic(diagnostic);
 assert.equal(diagnostic.code,'QUOTE_REQUEST_FAILED');assert.equal(diagnostic.quote?.status,'request-failed');
 assert.equal(diagnostic.quote?.failedRequestCount,1);assert.equal(diagnostic.quote?.pricedCount,0);
 assert.match(detail.text,/公开行情请求失败/);assert.match(detail.metadata,/请求失败1/);
 assert.deepEqual(h.reader.getState().snapshots[account].positions.map(position=>position.quantity),before);
 assert.equal(h.calls.filter(path=>path==='/api/v3/account'||path==='/sapi/v1/account/apiRestrictions').length,privateCallsBefore);
 assert.ok(!/SENSITIVE|signature|https:|TEST_SECRET/.test(JSON.stringify(diagnostic)));
});
test('行情诊断映射区分无候选、无市场、部分覆盖及预算截断',()=>{
 const base={assetCount:4,candidateCount:3,marketCount:2,pricedCount:1,failedRequestCount:0,unexaminedCount:1,requestCount:4,fallbackRequestCount:1};
 for(const [status,code,pattern] of [
  ['no-candidates','QUOTE_NO_CANDIDATES',/没有需要查询/],
  ['no-market','QUOTE_NO_MARKET',/没有可用的USDT现货交易对/],
  ['partial','QUOTE_PARTIAL',/部分可用/],
  ['budget-limited','QUOTE_BUDGET_LIMITED',/覆盖受请求预算限制/],
 ] as const){
  const detail=describeDiagnostic({stage:'quotes',code,quote:{...base,status,budgetReason:status==='budget-limited'?'candidate-cap':undefined}});
  assert.equal(detail.code,code);assert.match(detail.text,pattern);assert.match(detail.metadata,/未检查候选1/);assert.doesNotMatch(detail.metadata,/未覆盖1/);
 }
 const hostile=describeDiagnostic({stage:'quotes',code:'QUOTE_PARTIAL',quote:{...base,status:'partial',requestCount:'secret' as any,budgetReason:'secret' as any}});
 assert.ok(!JSON.stringify(hostile).includes('secret'));
});
test('额外权限/错误UID/缺余额停止，不能降级为成功空资产',async()=>{
 for(const mode of ['trade','uid','missing']){const h=await harness();h.reader.authorize('1',ack);h.setMode(mode);await h.reader.sync();assert.equal(h.reader.getStatus().connected,false);assert.equal(h.reader.valued().report.coveredSubtotal,null);assert.equal(h.reader.getDiagnostic().code,{trade:'READ_ONLY_REJECTED',uid:'UID_MISMATCH',missing:'SPOT_INVALID'}[mode]);if(mode==='trade')assert.ok(!h.calls.includes('/api/v3/account'));}
});
test('真零、6分钟TTL与5分钟刷新一致',async()=>{
 const h=await harness();h.reader.authorize('1',ack);h.setMode('zero');await h.reader.sync();assert.equal(h.reader.valued().report.total,'0.00000000');
 h.advance(DIRECT_INTERVAL);assert.equal(h.reader.valued().report.total,'0.00000000');h.advance(DIRECT_TTL-DIRECT_INTERVAL+1);assert.equal(h.reader.valued().report.coveredSubtotal,null);
});
test('自动默认关闭、须对账，隐藏暂停/返回补查/断开不再发请求',async()=>{
 const h=await harness();assert.throws(()=>h.reader.setAuto(true,true));h.reader.authorize('1',ack);await h.reader.sync();assert.throws(()=>h.reader.setAuto(true));h.reader.setAuto(true,true);
 const first=h.calls.length;h.reader.setVisible(false);h.advance(DIRECT_INTERVAL+1);await h.reader.tick();assert.equal(h.calls.length,first);
 h.reader.setVisible(true);await h.reader.tick();assert.ok(h.calls.length>first);const privateCount=h.calls.filter(p=>p.endsWith('/account')).length;await h.reader.tick();assert.equal(h.calls.filter(p=>p.endsWith('/account')).length,privateCount);const second=h.calls.length;await h.reader.tick();assert.equal(h.calls.length,second);
 h.reader.disconnect();h.advance(DIRECT_INTERVAL*3);await h.reader.tick();assert.equal(h.calls.length,second);assert.equal(h.reader.getStatus().auto,false);
});
test('失败保留旧数量/当前不可用、固定错误、退避及429不能开关绕过',async()=>{
 const h=await harness();h.reader.authorize('1',ack);await h.reader.sync();h.reader.setAuto(true,true);h.advance(DIRECT_INTERVAL+1);h.setMode('network');await h.reader.tick();assert.equal(h.reader.valued().report.coveredSubtotal,null);assert.equal(Object.values(h.reader.getState().snapshots)[0].positions.length,3);assert.ok(!/TEST_SECRET|signature|https:/.test(h.reader.message));const first=h.calls.filter(p=>p.endsWith('/apiRestrictions')).length;h.advance(DIRECT_INTERVAL);await h.reader.tick();assert.equal(h.calls.filter(p=>p.endsWith('/apiRestrictions')).length,first);
 h.advance(DIRECT_INTERVAL+1);h.setMode('limit');await h.reader.tick();const due=h.reader.getStatus().nextDue;h.reader.setAuto(false);h.reader.setAuto(true,true);assert.equal(h.reader.getStatus().nextDue,due);
});
test('SDK超时后底层未结束不重叠，断开后迟到结果不发布',async()=>{
 const h=await harness(5);h.reader.authorize('1',ack);h.block('/api/v3/account');await h.reader.sync();assert.equal(h.reader.getDiagnostic().code,'SPOT_TIMEOUT');assert.equal(h.reader.getDiagnostic().stage,'balance');assert.equal(h.reader.getStatus().busy,true);await assert.rejects(h.reader.sync());h.reader.disconnect();h.release();await new Promise(r=>setTimeout(r,1));assert.equal(h.reader.getStatus().busy,false);assert.equal(h.reader.getState().accounts.length,0);assert.equal(h.reader.getDiagnostic().code,'USER_DISCONNECTED');
});
test('页面暂停时在途结果丢弃，不能发后续认证或发布余额',async()=>{
 const h=await harness();h.reader.authorize('1',ack);h.block('/sapi/v1/account/apiRestrictions');const task=h.reader.sync();while(!h.calls.includes('/sapi/v1/account/apiRestrictions'))await new Promise(r=>setTimeout(r,1));h.reader.setVisible(false);h.release();await task;assert.ok(!h.calls.includes('/api/v3/account'));assert.equal(h.reader.getState().accounts.length,0);
});

test('公开行情默认每分钟刷新，与余额TTL和认证退避独立；历史估值保留且不进入当前合计',async()=>{
 const h=await harness();h.reader.authorize('1',ack);await h.reader.sync();
 const authCount=()=>h.calls.filter(p=>p.endsWith('/account')||p.endsWith('/apiRestrictions')).length;
 const before=authCount();await h.reader.tick();assert.equal(authCount(),before);assert.equal(h.reader.getStatus().auto,false);
 assert.equal(h.reader.valued().report.coveredSubtotal,'65.00000000');
 assert.equal(h.reader.getReference()?.report.coveredSubtotal,'65.00000000');
 const count=h.calls.length;h.advance(59_999);await h.reader.tick();assert.equal(h.calls.length,count);
 h.advance(1);await h.reader.tick();assert.equal(h.calls.length,count+1); // cached metadata; ticker only
 h.advance(DIRECT_TTL);await h.reader.tick();assert.equal(authCount(),before);
 assert.equal(h.reader.valued().report.coveredSubtotal,null);assert.equal(h.reader.getHistoricalQuotes().get('BTC')?.value,'50000');
 assert.equal(h.reader.getReference()?.report.coveredSubtotal,'65.00000000');
 h.reader.setVisible(false);h.advance(100_000);const hidden=h.calls.length;await h.reader.tick();assert.equal(h.calls.length,hidden);
 h.reader.setVisible(true);await h.reader.tick();assert.ok(h.calls.length>hidden);assert.equal(authCount(),before);
 h.reader.disconnect();const stopped=h.calls.length;h.advance(600_000);await h.reader.tick();assert.equal(h.calls.length,stopped);
});

test('公开行情失败保留历史报价和估值；失败后退避、成功恢复，不把旧价当本次成功',async()=>{
 const h=await harness();h.reader.authorize('1',ack);await h.reader.sync();await h.reader.tick();
 h.setQuoteFailure(true);h.advance(60_000);await h.reader.tick();
 assert.equal(h.reader.valued().report.coveredSubtotal,'15.00000000');
 assert.equal(h.reader.getHistoricalQuotes().get('BTC')?.value,'50000');
 assert.equal(h.reader.getReference()?.report.coveredSubtotal,'65.00000000');
 const count=h.calls.length;h.advance(60_000);await h.reader.tick();assert.equal(h.calls.length,count);
 h.setQuoteFailure(false);h.advance(60_000);await h.reader.tick();assert.equal(h.reader.valued().report.coveredSubtotal,'65.00000000');
});

test('最新部分估值替代较早完整记录，深拷贝历史且不同余额不复用旧总值',async()=>{
 const h=await harness();h.setMode('complete');h.reader.authorize('1',ack);await h.reader.sync();await h.reader.refreshQuotes();
 const first=h.reader.getReference()!;assert.equal(first.report.coverage,'complete');h.setMode('ok');first.state.snapshots[first.state.accounts[0].id].positions[0].quantity='999999';
 assert.notEqual(h.reader.getReference()!.state.snapshots[first.state.accounts[0].id].positions[0].quantity,'999999');
 h.advance(130_000);await h.reader.sync();assert.equal(h.reader.getReference()!.at,first.at);await h.reader.refreshQuotes();
 const latest=h.reader.getReference()!;
 assert.notEqual(latest.at,first.at);assert.equal(latest.report.coverage,'partial');assert.equal(latest.report.coveredSubtotal,'65.00000000');
 assert.equal(latest.state.snapshots[latest.state.accounts[0].id].asOf,Object.values(h.reader.getState().snapshots)[0].asOf);
});
