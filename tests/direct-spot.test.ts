import test from 'node:test';
import type { NetworkAPI,NetworkResponse } from '@wealthfolio/addon-sdk';
import assert from 'node:assert/strict';
import {DirectSpot,assertReadOnly,DIRECT_INTERVAL,DIRECT_TTL,restrictionRequest} from '../src/direct-spot';
import {BinanceCredentials} from '../src/credentials';
import {PublicMarketReader} from '../src/public-market';
import {signPayload} from '../src/binance';
const permissions={enableReading:true,ipRestrict:true,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
const ack={risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true};
async function harness(timeout=100){
 let now=Date.parse('2026-10-15T00:00:00Z'),calls:string[]=[],mode='ok',release:(()=>void)|undefined,blockedPath='';
 const values=new Map<string,string>(),credentials=new BinanceCredentials({set:async(k,v)=>{values.set(k,v);},get:async k=>values.get(k)??null,delete:async k=>{values.delete(k);}});
 await credentials.save('TEST_KEY_NOT_REAL','TEST_SECRET_NOT_REAL');
 const network:Pick<NetworkAPI,'request'>={request:async(req):Promise<NetworkResponse>=>{
  const u=new URL(req.url);calls.push(u.pathname);
  assert.equal(req.method,'GET');assert.ok(['data-api.binance.vision','api.binance.com'].includes(u.hostname));
  if(u.hostname==='api.binance.com'){assert.ok(['/api/v3/account','/sapi/v1/account/apiRestrictions'].includes(u.pathname));const raw=u.searchParams.get('timestamp')!;assert.equal(u.searchParams.get('signature'),signPayload(`timestamp=${raw}&recvWindow=5000`,'TEST_SECRET_NOT_REAL'));assert.equal(req.headers?.['X-MBX-APIKEY'],'TEST_KEY_NOT_REAL');}
  else assert.equal(req.headers,undefined);
  if(u.pathname===blockedPath)await new Promise<void>(r=>{release=r;});
  if(mode==='network'&&u.hostname==='api.binance.com')throw new Error('TEST_SECRET_NOT_REAL signature=RAW URL '+req.url);
  if(mode==='limit'&&u.hostname==='api.binance.com')return {status:429,headers:{'Retry-After':'3600'},body:'<html>WAF</html>'};
  let body:unknown;
  if(u.pathname.endsWith('/time'))body={serverTime:now};
  else if(u.pathname.endsWith('/apiRestrictions'))body=mode==='trade'?{...permissions,enableSpotAndMarginTrading:true}:permissions;
  else if(u.pathname.endsWith('/account'))body={uid:mode==='uid'?2:1,accountType:'SPOT',balances:mode==='zero'?[]:mode==='missing'?null:[{asset:'BTC',free:'0.001',locked:'0'},{asset:'USDT',free:'12',locked:'3'},{asset:'NOPAIR',free:'2',locked:'0'}]};
  else if(u.pathname.endsWith('/exchangeInfo'))body={symbols:[{symbol:'BTCUSDT',baseAsset:'BTC',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}]};
  else body=[{symbol:'BTCUSDT',price:'50000'}];
  return {status:200,headers:{},body:JSON.stringify(body)};
 }};
 const quotes=new PublicMarketReader(network,()=>now),reader=new DirectSpot(credentials,network,quotes,()=>now,timeout);
 reader.setVisible(true);
 return {reader,calls,credentials,setMode:(m:string)=>{mode=m;},advance:(ms:number)=>{now+=ms;},block:(path:string)=>{blockedPath=path;},release:()=>release?.()};
}
test('直接请求只读权限白名单、固定签名构造',()=>{
 assert.doesNotThrow(()=>assertReadOnly(permissions));
 for(const value of [{...permissions,enableWithdrawals:true},{...permissions,enableReading:false},{...permissions,ipRestrict:false},{...permissions,enableNewTrading:true},{enableReading:true}])assert.throws(()=>assertReadOnly(value));
 const req=restrictionRequest('FAKE','FAKE',123);assert.equal(new URL(req.url).pathname,'/sapi/v1/account/apiRestrictions');assert.equal(req.method,'GET');
});
test('必须本人确认；权限先于余额；真实来源、缺价与重复不累加',async()=>{
 const h=await harness();await assert.rejects(h.reader.sync());assert.equal(h.calls.length,0);
 assert.throws(()=>h.reader.authorize('1',{...ack,risk:false}));h.reader.authorize('1',ack);await h.reader.sync();
 assert.ok(h.calls.indexOf('/sapi/v1/account/apiRestrictions')<h.calls.indexOf('/api/v3/account'));
 for(let i=0;i<2;i++){await h.reader.sync();const v=h.reader.valued();assert.equal(v.report.coveredSubtotal,'65.00000000');assert.equal(v.report.stressLoss,'10.00000000');assert.equal(v.report.total,null);assert.equal(v.report.unpricedPositionCount,1);assert.equal(Object.values(v.state.snapshots)[0].dataMode,'external');assert.equal(Object.values(v.state.snapshots)[0].positions.length,3);}
});
test('额外权限/错误UID/缺余额停止，不能降级为成功空资产',async()=>{
 for(const mode of ['trade','uid','missing']){const h=await harness();h.reader.authorize('1',ack);h.setMode(mode);await h.reader.sync();assert.equal(h.reader.getStatus().connected,false);assert.equal(h.reader.valued().report.coveredSubtotal,null);if(mode==='trade')assert.ok(!h.calls.includes('/api/v3/account'));}
});
test('真零、6分钟TTL与5分钟刷新一致',async()=>{
 const h=await harness();h.reader.authorize('1',ack);h.setMode('zero');await h.reader.sync();assert.equal(h.reader.valued().report.total,'0.00000000');
 h.advance(DIRECT_INTERVAL);assert.equal(h.reader.valued().report.total,'0.00000000');h.advance(DIRECT_TTL-DIRECT_INTERVAL+1);assert.equal(h.reader.valued().report.coveredSubtotal,null);
});
test('自动默认关闭、须对账，隐藏暂停/返回补查/断开不再发请求',async()=>{
 const h=await harness();assert.throws(()=>h.reader.setAuto(true,true));h.reader.authorize('1',ack);await h.reader.sync();assert.throws(()=>h.reader.setAuto(true));h.reader.setAuto(true,true);
 const first=h.calls.length;h.reader.setVisible(false);h.advance(DIRECT_INTERVAL+1);await h.reader.tick();assert.equal(h.calls.length,first);
 h.reader.setVisible(true);await h.reader.tick();assert.ok(h.calls.length>first);const second=h.calls.length;await h.reader.tick();assert.equal(h.calls.length,second);
 h.reader.disconnect();h.advance(DIRECT_INTERVAL*3);await h.reader.tick();assert.equal(h.calls.length,second);assert.equal(h.reader.getStatus().auto,false);
});
test('失败保留旧数量/当前不可用、固定错误、退避及429不能开关绕过',async()=>{
 const h=await harness();h.reader.authorize('1',ack);await h.reader.sync();h.reader.setAuto(true,true);h.advance(DIRECT_INTERVAL+1);h.setMode('network');await h.reader.tick();assert.equal(h.reader.valued().report.coveredSubtotal,null);assert.equal(Object.values(h.reader.getState().snapshots)[0].positions.length,3);assert.ok(!/TEST_SECRET|signature|https:/.test(h.reader.message));const first=h.calls.length;h.advance(DIRECT_INTERVAL);await h.reader.tick();assert.equal(h.calls.length,first);
 h.advance(DIRECT_INTERVAL+1);h.setMode('limit');await h.reader.tick();const due=h.reader.getStatus().nextDue;h.reader.setAuto(false);h.reader.setAuto(true,true);assert.equal(h.reader.getStatus().nextDue,due);
});
test('SDK超时后底层未结束不重叠，断开后迟到结果不发布',async()=>{
 const h=await harness(5);h.reader.authorize('1',ack);h.block('/api/v3/account');await h.reader.sync();assert.equal(h.reader.getStatus().busy,true);await assert.rejects(h.reader.sync());h.reader.disconnect();h.release();await new Promise(r=>setTimeout(r,1));assert.equal(h.reader.getStatus().busy,false);assert.equal(h.reader.getState().accounts.length,0);
});
test('页面暂停时在途结果丢弃，不能发后续认证或发布余额',async()=>{
 const h=await harness();h.reader.authorize('1',ack);h.block('/sapi/v1/account/apiRestrictions');const task=h.reader.sync();while(h.calls.length<2)await new Promise(r=>setTimeout(r,1));h.reader.setVisible(false);h.release();await task;assert.ok(!h.calls.includes('/api/v3/account'));assert.equal(h.reader.getState().accounts.length,0);
});
