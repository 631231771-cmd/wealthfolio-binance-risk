import test from 'node:test';
import assert from 'node:assert/strict';
import type {NetworkAPI,NetworkRequest,NetworkResponse} from '@wealthfolio/addon-sdk';
import {calibrateTime,ClockError} from '../src/spot';
import {DirectSpot} from '../src/direct-spot';
import {BinanceCredentials} from '../src/credentials';
import {SpotQuoteReader} from '../src/public-market';
import {describeDiagnostic,describeTimeObservation} from '../src/direct-panel';

const T=Date.parse('2026-10-15T00:00:00Z');
const ack={risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true};
const permissions={enableReading:true,ipRestrict:false,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
const response=(body:unknown,status=200):NetworkResponse=>({status,headers:{},body:JSON.stringify(body)});
function clockHarness(handler:(req:NetworkRequest,n:number,advance:(ms:number,wallDelta?:number)=>void,wall:()=>number)=>Promise<NetworkResponse>|NetworkResponse,timeout=100){
 let wall=T,mono=0,reads=0;const calls:NetworkRequest[]=[],store=new Map<string,string>();
 const credentials=new BinanceCredentials({get:async k=>{reads++;return store.get(k)??null;},set:async(k,v)=>{store.set(k,v);},delete:async k=>{store.delete(k);}});
 const advance=(ms:number,wallDelta=ms)=>{mono+=ms;wall+=wallDelta;};
 const network:Pick<NetworkAPI,'request'>={request:async req=>{calls.push(req);return handler(req,calls.length,advance,()=>wall);}};
 const reader=new DirectSpot(credentials,network,new SpotQuoteReader(network,()=>wall),()=>wall,timeout,()=>mono);reader.setVisible(true);
 return {reader,calls,credentials,reads:()=>reads};
}
test('校时固定四原因，单调耗时与Unix时间分开，旧2000ms/60000ms边界保留',()=>{
 const cases=[{body:{},end:T+100,mono:100,reason:'SERVER_TIME_INVALID'},
  {body:{serverTime:T},end:T-1,mono:10,reason:'LOCAL_CLOCK_CHANGED'},
  {body:{serverTime:T},end:T+500,mono:100,reason:'LOCAL_CLOCK_CHANGED'},
  {body:{serverTime:T+1001},end:T+2001,mono:2001,reason:'CLOCK_SAMPLE_SLOW'},
  {body:{serverTime:T+60101},end:T+200,mono:200,reason:'CLOCK_OFFSET_EXCESSIVE'}];
 for(const c of cases)assert.throws(()=>calibrateTime(c.body,T,c.end,c.mono),(e:unknown)=>e instanceof ClockError&&e.details.reason===c.reason&&!JSON.stringify(e).includes('serverTime":'));
 assert.equal(calibrateTime({serverTime:T+1000},T,T+2000,2000),0);
 assert.equal(calibrateTime({serverTime:T+60100},T,T+200,200),60000);
 assert.throws(()=>calibrateTime({serverTime:T},T,T,NaN),(e:unknown)=>e instanceof ClockError&&e.details.reason==='LOCAL_CLOCK_CHANGED');
});
test('公开对照六次串行，仅固定time且完全不读取secrets，不授权或发布资产',async()=>{
 let active=0,max=0;const h=clockHarness(async(req,_n,advance,wall)=>{active++;max=Math.max(max,active);assert.equal(req.method,'GET');assert.equal(new URL(req.url).pathname,'/api/v3/time');assert.equal(new URL(req.url).search,'');assert.equal(req.headers,undefined);assert.equal(req.body,undefined);await Promise.resolve();advance(100);active--;return response({serverTime:wall()-50});});
 await h.reader.testPublicTime();assert.equal(h.calls.length,6);assert.equal(max,1);assert.equal(h.reads(),0);
 assert.deepEqual(h.calls.map(r=>new URL(r.url).hostname),Array(3).fill('data-api.binance.vision').concat(Array(3).fill('api.binance.com')));
 assert.equal(h.reader.getPublicObservations().length,6);assert.ok(h.reader.getPublicObservations().every(r=>r.code==='OK'&&r.httpStatus===200&&r.elapsedMs===100&&r.serverTimeValid===true));
 assert.equal(h.reader.getStatus().connected,false);assert.equal(h.reader.getState().accounts.length,0);
});
test('公开对照保留慢样本与原因，不保存服务器绝对时间或响应额外字段',async()=>{
 const h=clockHarness((_req,_n,advance,wall)=>{advance(2500);return response({serverTime:wall()-1250,apiKey:'SENSITIVE',signature:'SENSITIVE'});});
 await h.reader.testPublicTime();const rows=h.reader.getPublicObservations();assert.equal(rows.length,6);assert.ok(rows.every(r=>r.reason==='CLOCK_SAMPLE_SLOW'&&r.elapsedMs===2500&&r.serverTimeValid===true));assert.ok(!/SENSITIVE|serverTime":|apiKey|signature/.test(JSON.stringify(rows)));assert.equal(h.reads(),0);
});
test('宿主字符串拒绝不猜TLS/DNS/timeout，安全摘要无原始异常',async()=>{
 const h=clockHarness(()=>{throw 'operation timed out https://private/?signature=SENSITIVE apiKey=SENSITIVE';});
 await h.reader.testPublicTime();const rows=h.reader.getPublicObservations();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.code==='HOST_REQUEST_FAILED'&&r.layer==='host-call'&&r.httpStatus===undefined));assert.ok(!/SENSITIVE|https:|timed out|apiKey/.test(JSON.stringify(rows)));assert.equal(h.reads(),0);
});
test('收到HTTP错误时保留HTTP与数字码，非JSON429停止两个主机且冷却不可绕过',async()=>{
 const h=clockHarness(()=>response({code:-1121,msg:'SENSITIVE'},400));await h.reader.testPublicTime();assert.equal(h.reader.getPublicObservations()[0].httpStatus,400);assert.equal(h.reader.getPublicObservations()[0].exchangeCode,-1121);assert.equal(h.reader.getPublicObservations()[0].layer,'http-response');
 const limited=clockHarness(()=>({status:429,headers:{'Retry-After':'90'},body:'<html>SENSITIVE</html>'}));await limited.reader.testPublicTime();assert.equal(limited.calls.length,1);assert.equal(limited.reader.getPublicObservations()[0].code,'SPOT_RATE_LIMIT');limited.reader.disconnect();await assert.rejects(limited.reader.testPublicTime());assert.equal(limited.calls.length,1);
});
test('插件计时器超时与宿主拒绝分层，底层未完成不重叠、不继续另一主机',async()=>{
 let release!:()=>void;const h=clockHarness(()=>new Promise<NetworkResponse>(r=>{release=()=>r(response({serverTime:T}));}),5);
 await h.reader.testPublicTime();const row=h.reader.getPublicObservations()[0];assert.equal(row.code,'SPOT_TIMEOUT');assert.equal(row.layer,'plugin-timer');assert.equal(h.calls.length,1);assert.equal(h.reader.getStatus().busy,true);await assert.rejects(h.reader.testPublicTime());release();await new Promise(r=>setTimeout(r,1));assert.equal(h.reader.getStatus().busy,false);assert.equal(h.reader.getState().accounts.length,0);
});
test('隐藏/已授权真实会话不能启动公开对照；断开时不继续采样',async()=>{
 const h=clockHarness(()=>response({serverTime:T}));h.reader.setVisible(false);await assert.rejects(h.reader.testPublicTime());assert.equal(h.calls.length,0);h.reader.setVisible(true);h.reader.authorize('1',ack);await assert.rejects(h.reader.testPublicTime());assert.equal(h.calls.length,0);
 let stop:()=>void=()=>{};const q=clockHarness(()=>{stop();return response({serverTime:T});});stop=()=>q.reader.disconnect();await q.reader.testPublicTime();assert.equal(q.calls.length,1);assert.equal(q.reader.getPublicObservations()[0].code,'SPOT_DISCONNECTED');
});
test('真实链路校时最多三次，全部过慢停止且不发权限/余额请求',async()=>{
 const h=clockHarness((_req,_n,advance,wall)=>{advance(2100);return response({serverTime:wall()-1050});});await h.credentials.save('TEST_KEY','TEST_SECRET');h.reader.authorize('1',ack);await h.reader.sync();
 assert.equal(h.calls.length,3);assert.equal(h.reader.getTimeObservations().length,3);assert.equal(h.reader.getDiagnostic().clock?.reason,'CLOCK_SAMPLE_SLOW');assert.equal(h.reader.getDiagnostic().layer,'clock-validation');assert.equal(h.reader.getDiagnostic().httpStatus,200);assert.equal(h.reader.getStatus().connected,false);
});
test('字段异常/时钟跳变/大偏移不重试，不发私人请求',async()=>{
 for(const mode of ['field','jump','offset']){const h=clockHarness((_req,_n,advance,wall)=>{advance(100,mode==='jump'?800:100);return response(mode==='field'?{}:{serverTime:wall()+(mode==='offset'?70000:-50)});});await h.credentials.save('TEST_KEY','TEST_SECRET');h.reader.authorize('1',ack);await h.reader.sync();assert.equal(h.calls.length,1);assert.equal(h.reader.getDiagnostic().clock?.reason,{field:'SERVER_TIME_INVALID',jump:'LOCAL_CLOCK_CHANGED',offset:'CLOCK_OFFSET_EXCESSIVE'}[mode]);}
});
test('首个合格校时样本后立即继续，保留一次慢样本；签名窗口不放宽',async()=>{
 let timeCount=0,signed=0;const h=clockHarness((req,_n,advance,wall)=>{
  const path=new URL(req.url).pathname;
  if(path==='/api/v3/time'){if(signed)return response({serverTime:wall()});timeCount++;const ms=[2100,100,300][timeCount-1];advance(ms);return response({serverTime:wall()-ms/2+(timeCount===2?20:40)});}
  if(path.includes('apiRestrictions')||path==='/api/v3/account'){const u=new URL(req.url);assert.equal(u.searchParams.get('recvWindow'),'5000');assert.equal(u.searchParams.get('timestamp'),String(wall()+20));signed++;return response(path.includes('apiRestrictions')?permissions:{uid:1,accountType:'SPOT',balances:[]});}
  if(path.includes('exchangeInfo'))return response({symbols:[]});return response([]);
 });await h.credentials.save('TEST_KEY','TEST_SECRET');h.reader.authorize('1',ack);await h.reader.sync();assert.equal(timeCount,2);assert.equal(signed,2);assert.equal(h.reader.getStatus().success,true);assert.equal(h.reader.valued().report.total,'0.00000000');
});
test('真实调用宿主失败仍显示当前阶段及耗时，不继承上次成功',async()=>{
 const h=clockHarness((req,_n,advance,wall)=>{advance(100);if(req.url.includes('/time'))return response({serverTime:wall()-50});throw new Error('SENSITIVE signature=RAW');});await h.credentials.save('TEST_KEY','TEST_SECRET');h.reader.authorize('1',ack);await h.reader.sync();const d=h.reader.getDiagnostic();assert.equal(d.stage,'permissions');assert.equal(d.code,'HOST_REQUEST_FAILED');assert.equal(d.layer,'host-call');assert.equal(d.elapsedMs,100);assert.equal(d.httpStatus,undefined);assert.ok(!JSON.stringify(d).includes('SENSITIVE'));
});
test('诊断显示固定层级/原因与必要数值，未知文本不透传',()=>{
 const d=describeDiagnostic({stage:'clock',code:'SPOT_CLOCK',layer:'clock-validation',elapsedMs:2100,httpStatus:200,clock:{reason:'CLOCK_SAMPLE_SLOW',serverTimeValid:true,elapsedMs:2100}});assert.match(d.metadata,/CLOCK_SAMPLE_SLOW/);assert.match(d.metadata,/2100ms/);
 const text=describeTimeObservation({host:'MARKET',attempt:1,code:'OK',elapsedMs:50,httpStatus:200,serverTimeValid:true,offsetMs:-10});assert.match(text,/MARKET #1/);assert.match(text,/HTTP 200/);assert.match(text,/偏移-10ms/);
 const hostile=describeDiagnostic({stage:'clock',code:'HOST_REQUEST_FAILED',layer:'SENSITIVE' as any,elapsedMs:'SENSITIVE' as any,clock:{reason:'SENSITIVE' as any,serverTimeValid:true}});assert.ok(!JSON.stringify(hostile).includes('SENSITIVE'));
});
