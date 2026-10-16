import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createElement} from 'react';
import {createRequire} from 'node:module';
const {renderToStaticMarkup}=createRequire(import.meta.url)('react-dom/server') as {renderToStaticMarkup:(element:ReturnType<typeof createElement>)=>string};
import type {NetworkRequest,NetworkResponse} from '@wealthfolio/addon-sdk';
import {BinanceCredentials} from '../src/credentials';
import {DirectSpot} from '../src/direct-spot';
import {SpotQuoteReader} from '../src/public-market';
import {DirectSpotPanel} from '../src/direct-panel';

// Entire chain uses memory-only fake secrets and a transport substitute; no SDK/network calls.
const T=Date.parse('2026-10-16T00:00:00Z');
const ack={risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true};
const permission={enableReading:true,ipRestrict:false,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
const reply=(body:unknown):NetworkResponse=>({status:200,headers:{},body:JSON.stringify(body)});
async function fixture(samples:(number|'reject')[],account:unknown={uid:7,accountType:'SPOT',balances:[{asset:'虚构.币-é',free:'0.125',locked:'0.375'},{asset:'FAKE_ZERO',free:'0',locked:'0'}]},quoteResponse?:()=>Promise<NetworkResponse>){
  let wall=T,mono=0,n=0;const calls:NetworkRequest[]=[],values=new Map<string,string>();
  const secrets={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},delete:async(k:string)=>{values.delete(k);}};
  await new BinanceCredentials(secrets).save('TEST_ONLY_KEY','TEST_ONLY_SECRET');
  // Recreate the controller to exercise saved credential read-back, not cached input.
  const credentials=new BinanceCredentials(secrets);
  const network={request:async(req:NetworkRequest)=>{
    calls.push(req);const u=new URL(req.url);assert.equal(req.method,'GET');
    if(u.hostname==='data-api.binance.vision'&&quoteResponse)return quoteResponse();
    if(u.pathname==='/api/v3/time'){
      assert.equal(req.headers,undefined);assert.equal(u.search,'');const sample=samples[n++];
      if(sample==='reject'||sample===undefined)throw 'FAKE host failure signature=DO_NOT_FORWARD';
      wall+=sample;mono+=sample;return reply({serverTime:wall-Math.floor(sample/2)+100});
    }
    if(u.hostname==='data-api.binance.vision')throw 'FAKE quote failure';
    assert.equal(u.hostname,'api.binance.com');assert.equal(req.headers?.['X-MBX-APIKEY'],'TEST_ONLY_KEY');
    const query=u.search.slice(1).split('&signature=')[0];
    assert.equal(u.searchParams.get('signature'),createHmac('sha256','TEST_ONLY_SECRET').update(query).digest('hex'));
    assert.equal(u.searchParams.get('recvWindow'),'5000');assert.equal(u.searchParams.get('timestamp'),String(wall+100));
    if(u.pathname==='/sapi/v1/account/apiRestrictions')return reply(permission);
    assert.equal(u.pathname,'/api/v3/account');return reply(account);
  }};
  const reader=new DirectSpot(credentials,network,new SpotQuoteReader(network,()=>wall,quoteResponse?5:100),()=>wall,100,()=>mono);
  reader.setVisible(true);reader.authorize('7',ack);
  return {reader,calls,credentials};
}

test('首次连接：慢样本后合格即停止，独立HMAC核对，到真实面板数量不依赖行情',async()=>{
  const h=await fixture([2100,200,'reject']);await h.reader.sync();
  assert.equal(h.reader.getStatus().success,true);
  assert.deepEqual(h.calls.map(r=>new URL(r.url).pathname),['/api/v3/time','/api/v3/time','/sapi/v1/account/apiRestrictions','/api/v3/account']);
  assert.ok(h.calls.every(r=>new URL(r.url).hostname==='api.binance.com'));
  const html=renderToStaticMarkup(createElement(DirectSpotPanel,{reader:h.reader,credentials:h.credentials}));
  assert.ok(html.includes('虚构.币-é'));assert.ok(html.includes('0.5'));assert.ok(html.includes('缺少有效价格'));
  assert.ok(!html.includes('FAKE_ZERO'));assert.ok(!/TEST_ONLY|signature=|DO_NOT_FORWARD/.test(html));
  assert.equal(h.reader.valued().report.total,null);
});

test('首次连接：已结束的宿主失败可以有限重试，合格样本后不再探测',async()=>{
  const h=await fixture(['reject',100,'reject']);await h.reader.sync();
  assert.equal(h.reader.getStatus().success,true);assert.equal(h.reader.getTimeObservations().length,2);
  assert.equal(h.reader.getTimeObservations()[0].code,'HOST_REQUEST_FAILED');
});

test('数量连接成功后，独立行情失败不得撤销余额或伪装零；UID/缺余额仍拒绝',async()=>{
  const h=await fixture([100],{uid:7,accountType:'SPOT',balances:[{asset:'BTC',free:'0.5',locked:'0'}]});await h.reader.sync();assert.equal(h.reader.getStatus().success,true);
  const before=h.reader.getState();await h.reader.refreshQuotes();assert.deepEqual(h.reader.getState(),before);
  assert.equal(h.reader.getStatus().success,true);assert.equal(h.reader.getDiagnostic().code,'QUOTE_REQUEST_FAILED');
  for(const body of [{uid:8,accountType:'SPOT',balances:[]},{uid:7,accountType:'SPOT'}]){
    const bad=await fixture([100],body);await bad.reader.sync();assert.equal(bad.reader.getStatus().success,false);assert.equal(bad.reader.valued().report.total,null);
  }
});

test('独立行情超时后仍禁止交叉重叠，断开后的迟到限流也保留',async()=>{
  let release!:(value:NetworkResponse)=>void;
 const h=await fixture([100],{uid:7,accountType:'SPOT',balances:[{asset:'BTC',free:'0.5',locked:'0'}]},()=>new Promise<NetworkResponse>(resolve=>{release=resolve;}));
  await h.reader.sync();await h.reader.refreshQuotes();
  assert.equal(h.reader.getStatus().success,true);assert.equal(h.reader.getStatus().busy,true);
  const count=h.calls.length;await assert.rejects(h.reader.sync());assert.equal(h.calls.length,count);
  h.reader.disconnect();release({status:429,headers:{'Retry-After':'172800'},body:'FAKE'});
  await new Promise(r=>setTimeout(r,0));h.reader.authorize('7',ack);
  assert.equal(h.reader.getStatus().retry.reason,'exchange-limit');assert.equal(h.reader.getStatus().retry.waitSeconds,172800);
  await assert.rejects(h.reader.sync());assert.equal(h.calls.length,count);
});
