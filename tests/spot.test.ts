import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DummyCredentials, DUMMY } from '../src/credentials';
import { SpotOfflineReader, SpotError, createMockTransport, calibrateTime, publicSpotRequest, spotSnapshot, spotRisk, validateSpotAccount, type MockResponse } from '../src/spot';
import { spotFixtureTransport, type SpotScenario } from '../src/spot-fixture';
import { syncedFixture, fixtureShocks } from '../src/fixtures';
import { calculateRisk, type PortfolioState } from '../src/domain';
import { exportState } from '../src/backup';

const TIME=Date.parse('2026-10-14T00:00:00Z');
async function credential() {
  const values=new Map<string,string>();
  const c=new DummyCredentials({get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},delete:async k=>{values.delete(k);}});
  await c.save(1);return c;
}
const balance=(rows=[{asset:'BTC',free:'0.3',locked:'0.1'},{asset:'USDT',free:'4000',locked:'0'}],uid=42)=>({uid,accountType:'SPOT',balances:rows});
async function setup() {
  let now=TIME, scenario:SpotScenario='normal';const c=await credential();
  const reader=new SpotOfflineReader(c,spotFixtureTransport(()=>scenario,()=>now),()=>now);
  return {reader,c,setTime:(t:number)=>{now=t;},setScenario:(s:SpotScenario)=>{scenario=s;},risk:()=>spotRisk(reader.getState(),now)};
}
test('Spot GET 固定白名单与实际序列化签名；公开请求不携带凭据',async()=> {
  const seen:string[]=[], c=await credential();
  const mock=createMockTransport(async request=> {
    assert.equal(request.method,'GET');const url=new URL(request.url);seen.push(url.pathname);
    assert.equal(url.origin,'https://api.binance.com');
    if(url.pathname==='/api/v3/time'){assert.equal(request.headers,undefined);return{status:200,data:{serverTime:TIME+250}};}
    if(url.pathname==='/api/v3/account') {
      assert.equal(request.headers?.['X-MBX-APIKEY'],DUMMY[1].apiKey);
      assert.equal(url.searchParams.get('timestamp'),String(TIME+250));
      assert.equal(url.searchParams.get('recvWindow'),'5000');
      const payload=url.search.slice(1).split('&signature=')[0];
      assert.equal(url.searchParams.get('signature'),createHmac('sha256',DUMMY[1].secret).update(payload).digest('hex'));
      return{status:200,data:balance()};
    }
    assert.equal(request.headers,undefined);assert.equal(url.search,'?symbol=BTCUSDT');
    return{status:200,data:{symbol:'BTCUSDT',price:'50000'}};
  });
  await new SpotOfflineReader(c,mock,()=>TIME).sync();assert.deepEqual(seen,['/api/v3/time','/api/v3/account','/api/v3/ticker/price']);
  assert.throws(()=>publicSpotRequest('price','BTCUSDT&signature=fake'),SpotError);
  assert.throws(()=>publicSpotRequest('order' as any),SpotError);
});
test('Spot 服务器时间中点偏移、慢请求、反向时间、微秒/无效响应与过大偏移',()=> {
  assert.equal(calibrateTime({serverTime:TIME+350},TIME,TIME+200),250);
  for(const [data,start,end] of [[{},TIME,TIME],[{serverTime:TIME*1000},TIME,TIME],[{serverTime:TIME},TIME,TIME+2001],[{serverTime:TIME},TIME+1,TIME]] as const)assert.throws(()=>calibrateTime(data,start,end),SpotError);
});
test('Spot 单账号全链路、精确数量、来源、时间、风险和原有 USD 基准',async()=> {
  const s=await setup();await s.reader.sync();const state=s.reader.getState(), r=s.risk();
  assert.equal(state.accounts.length,1);assert.equal(state.accounts[0].sourceAccountId,'fixture:42');
  const snap=Object.values(state.snapshots)[0];assert.equal(snap.dataMode,'fixture');assert.equal(snap.positions[0].quantity,'0.4');
  assert.equal(snap.collectionStartedAt,snap.collectionEndedAt);assert.equal(r.total,'24000.00000000');assert.equal(r.stressLoss,'4000.00000000');
  assert.equal(r.baseCurrency,'USDT');assert.equal(r.accountHhi,'1.000000');assert.equal(r.assetHhi,'0.722222');
  const old=calculateRisk(syncedFixture(),'USD',[],fixtureShocks());assert.equal(old.coveredSubtotal,'30000.00000000');assert.equal(old.stressLoss,'5500.00000000');
  assert.throws(()=>exportState(state,null)); // 新会话不偷偷进入旧备份格式。
  const serialized=JSON.stringify(state);assert.ok(!serialized.includes(DUMMY[1].apiKey));assert.ok(!serialized.includes(DUMMY[1].secret));assert.ok(!serialized.includes('signature'));
});
test('Spot 换固定假 Key 和重复同步仍是同一 UID 一份余额，不累加',async()=> {
  const s=await setup();await s.reader.sync();await s.c.save(2);await s.reader.sync();
  assert.equal(Object.keys(s.reader.getState().snapshots).length,1);assert.equal(s.risk().total,'24000.00000000');
});
for(const [scenario,code] of [['401','auth'],['403','forbidden'],['429','rate-limit'],['signature','signature'],['clock','clock'],['timeout','timeout']] as const) {
  test(`Spot ${scenario} 分类且失败保留数量；当前小计与压力不可用`,async()=> {
    const s=await setup();await s.reader.sync();const old=s.reader.getState().snapshots;s.setScenario(scenario);
    await assert.rejects(s.reader.sync(),e=>e instanceof SpotError && e.code===code);
    assert.deepEqual(s.reader.getState().snapshots,old);assert.equal(s.risk().coveredSubtotal,null);assert.equal(s.risk().stressLoss,null);assert.equal(s.risk().lastKnownSubtotal,'24000.00000000');
    if(scenario==='429'){s.setScenario('normal');await assert.rejects(s.reader.sync(),/限流/);s.setTime(TIME+60_000);await s.reader.sync();assert.equal(s.risk().total,'24000.00000000');}
  });
}
test('Spot 实际计时超时会中止模拟信号；原异常不进入状态/消息',async()=> {
  let signal:AbortSignal|undefined;const mock=createMockTransport(async(_r,s)=>{signal=s;return new Promise(()=>{});});
  const reader=new SpotOfflineReader(await credential(),mock,()=>TIME,10);
  await assert.rejects(reader.sync(),e=>e instanceof SpotError && e.code==='timeout');assert.equal(signal?.aborted,true);
  const failing=createMockTransport(async()=>{throw new Error(`https://api.binance.com/?signature=FAKE ${DUMMY[1].secret}`);});
  await assert.rejects(new SpotOfflineReader(await credential(),failing,()=>TIME).sync(),e=>e instanceof SpotError && !String(e).includes('signature=') && !String(e).includes(DUMMY[1].secret));
});
test('Spot 限流无自动重试；真实发送始终阻断且不读取凭据或调用传输',async()=> {
  let calls=0;const c=await credential(), t=createMockTransport(async()=>{calls++;return{status:429,data:{},headers:{'Retry-After':'3'}};});
  const r=new SpotOfflineReader(c,t,()=>TIME);await assert.rejects(r.sync());await assert.rejects(r.sync());assert.equal(calls,1);
  const before=calls;await assert.rejects(r.requestReal(),/阻断/);assert.equal(calls,before);
  assert.throws(()=>new SpotOfflineReader(c,{mode:'fixture',request:t.request},()=>TIME),SpotError);
});
test('Spot 未连接/断开/删除与在途断开不发布成功快照；并发同步拒绝',async()=> {
  const s=await setup();await s.reader.sync();s.reader.disconnect();await s.c.disconnectAndDelete();await assert.rejects(s.reader.sync(),/断开/);assert.equal(s.risk().coveredSubtotal,null);
  let resolve:((r:MockResponse)=>void)|undefined;
  const slow=createMockTransport(async()=>new Promise<MockResponse>(r=>{resolve=r;}));
  const r=new SpotOfflineReader(await credential(),slow,()=>TIME);const pending=r.sync();
  while(!resolve)await new Promise(r=>setImmediate(r));
  await assert.rejects(r.sync(),/进行中/);r.disconnect();resolve({status:200,data:{serverTime:TIME}});
  await assert.rejects(pending,/断开/);assert.deepEqual(r.getState().snapshots,{});
});
test('Spot 真零余额仍为零；缺价格/未知资产保留数量但只报告部分',async()=> {
  const s=await setup();s.setScenario('zero');await s.reader.sync();assert.equal(s.risk().total,'0.00000000');assert.equal(s.risk().stressLoss,'0.00000000');
  s.setScenario('missing-price');await s.reader.sync();assert.equal(s.risk().coveredSubtotal,'4000.00000000');assert.equal(s.risk().total,null);assert.equal(s.risk().unpricedPositionCount,1);
  const v=spotSnapshot(balance([{asset:'ABC',free:'2',locked:'0'}]),'fixture',new Date(TIME).toISOString(),new Date(TIME).toISOString());
  const state:PortfolioState={schemaVersion:1,accounts:[v.account],snapshots:{[v.account.id]:v.snapshot},statuses:{[v.account.id]:{state:'ready',attemptedAt:v.snapshot.asOf}}};
  assert.equal(v.snapshot.positions[0].asset.type,'unknown');assert.equal(spotRisk(state,TIME).coveredSubtotal,null);
});
test('Spot 余额/价格/缺 FX/未来数据会失效；fixture 链路也执行 TTL',async()=> {
  const s=await setup();await s.reader.sync();const state=s.reader.getState();
  assert.equal(spotRisk(state,TIME+60_001).coveredSubtotal,null);assert.equal(spotRisk(state,TIME-1).coveredSubtotal,null);
  Object.values(state.snapshots)[0].positions[0].price!.asOf=new Date(TIME-120_001).toISOString();
  assert.equal(spotRisk(state,TIME).coveredSubtotal,'4000.00000000');assert.equal(spotRisk(state,TIME).total,null);
  assert.equal(spotRisk(state,TIME,'USD').coveredSubtotal,null); // 绝不隐含 USDT=USD。
});
test('Spot 响应错误/重复资产/负数/错误 UID/错误类型拒绝；真实身份没有模拟报价或成本',()=> {
  for(const data of [{},{code:-1022},balance([{asset:'BTC',free:'1',locked:'0'},{asset:'BTC',free:'2',locked:'0'}]),balance([{asset:'BTC',free:'-1',locked:'0'}]),{...balance(),uid:'42'},{...balance(),accountType:'MARGIN'},balance([{asset:'WRISKDEMO_BTC',free:'1',locked:'0'}])])assert.throws(()=>validateSpotAccount(data),SpotError);
  const at=new Date(TIME).toISOString(), f=spotSnapshot(balance(),'fixture',at,at), e=spotSnapshot(balance(),'external',at,at);
  assert.notEqual(f.account.sourceAccountId,e.account.sourceAccountId);assert.notEqual(f.account.id,e.account.id);
  assert.equal(e.snapshot.dataMode,'external');assert.equal(e.snapshot.positions[0].price,undefined);assert.equal('cost' in e.snapshot.positions[0],false);assert.equal(e.snapshot.positions[0].asset.type,'unknown');
});
test('Spot 账户 UID 改变拒绝替换旧来源；API 权限字段不是读取授权证明',async()=> {
  let uid=42;const t=createMockTransport(async request=> {
    if(new URL(request.url).pathname==='/api/v3/time')return{status:200,data:{serverTime:TIME}};
    if(new URL(request.url).pathname==='/api/v3/account')return{status:200,data:balance([],uid)};
    return{status:500,data:{}};
  });
  const r=new SpotOfflineReader(await credential(),t,()=>TIME);await r.sync();uid=43;await assert.rejects(r.sync(),SpotError);
  assert.equal(r.getState().accounts[0].sourceAccountId,'fixture:42');assert.equal(spotRisk(r.getState(),TIME).coveredSubtotal,null);
});
test('Spot 首次失败没有历史零资产；报价故障不继承之前报价',async()=> {
  const s=await setup();s.setScenario('401');await assert.rejects(s.reader.sync());assert.equal(s.risk().lastKnownSubtotal,null);
  s.setScenario('normal');await s.reader.sync();s.setScenario('missing-price');await s.reader.sync();
  assert.equal(Object.values(s.reader.getState().snapshots)[0].positions[0].price,undefined);
  assert.equal(s.risk().coveredSubtotal,'4000.00000000');
});
test('Spot ticker 错误 symbol/零价格/非十进制拒绝估值；原始附加字段不保留',async()=> {
  for(const quote of [{symbol:'ETHUSDT',price:'50000'},{symbol:'BTCUSDT',price:'0'},{symbol:'BTCUSDT',price:'NaN'}]) {
    const t=createMockTransport(async request=> {
      const path=new URL(request.url).pathname;
      if(path==='/api/v3/time')return {status:200,data:{serverTime:TIME}};
      if(path==='/api/v3/account')return{status:200,data:{...balance(),apiKey:'private-field-must-not-retain'}};
      return{status:200,data:quote};
    });
    const r=new SpotOfflineReader(await credential(),t,()=>TIME);await r.sync();assert.equal(spotRisk(r.getState(),TIME).coveredSubtotal,'4000.00000000');
    assert.ok(!JSON.stringify(r.getState()).includes('private-field-must-not-retain'));
  }
});
