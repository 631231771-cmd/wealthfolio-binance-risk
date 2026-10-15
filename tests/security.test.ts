import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { BinanceCredentials, DummyCredentials, DUMMY, requestAuthenticated } from '../src/credentials';
import { parseExternalSpot, parseExternalFunding, buildOfflineReadRequest } from '../src/binance';
import { calculateRisk, applyBatch, type Account, type PortfolioState, type FxRate, DEFAULT_FRESHNESS } from '../src/domain';
import { exportState, restoreState, sanitizeFixtureState } from '../src/backup';
import { syncedFixture, FIXTURE_TIME, fixtureShocks } from '../src/fixtures';

function fakeSecrets() {
  const values=new Map<string,string>();
  let failKey='', afterWrite=false, failReadKey='', failDeleteKey='';
  return {values,fail:(key:string,after=false)=>{failKey=key;afterWrite=after;},failRead:(key:string)=>failReadKey=key,failDelete:(key:string)=>failDeleteKey=key,
    api:{get:async(key:string)=> {if (key===failReadKey) {failReadKey='';throw new Error(DUMMY[1].secret);}return values.get(key)??null;},
      set:async(key:string,value:string)=>{if(key===failKey){failKey='';if(afterWrite)values.set(key,value);throw new Error(value);}values.set(key,value);},
      delete:async(key:string)=>{if(key===failDeleteKey){failDeleteKey='';throw new Error(DUMMY[1].apiKey);}values.delete(key);}}};
}
test('页面查询保存状态只读活动标记，不读取任何凭据槽',async()=>{
 const reads:string[]=[];
 const c=new BinanceCredentials({get:async key=>{reads.push(key);if(key==='risk-binance-spot-active-v1')return 'a';throw new Error('不得读取槽');},set:async()=>{},delete:async()=>{}});
 assert.equal(await c.isSaved(),true);assert.deepEqual(reads,['risk-binance-spot-active-v1']);
});
test('本机 Binance 凭据只经 secrets 保存、替换、读回和删除；备份不包含值',async()=> {
  const host=fakeSecrets(), c=new BinanceCredentials(host.api);
  const first={version:1 as const,apiKey:'FAKE_API_KEY_WINDOWS',secret:'FAKE_SECRET_WINDOWS'};
  assert.equal(await c.isSaved(),false);
  await c.save(first.apiKey,first.secret);
  assert.deepEqual(await c.read(),first);
  assert.ok([...host.values.keys()].every(key=>/^risk-binance-spot-(active|slot-[ab])-v1$/.test(key)));
  const next={version:1 as const,apiKey:'FAKE_API_KEY_ROTATED',secret:'FAKE_SECRET_ROTATED'};
  await c.save(next.apiKey,next.secret);
  assert.deepEqual(await new BinanceCredentials(host.api).read(),next);
  const backup=exportState(syncedFixture(),null);
  for(const value of [first.apiKey,first.secret,next.apiKey,next.secret]) assert.equal(backup.includes(value),false);
  await c.disconnectAndDelete();
  assert.equal(await new BinanceCredentials(host.api).isSaved(),false);
  assert.equal(host.values.size,0);
});
test('本机凭据保存失败不泄露值并保持旧凭据；删除失败时保持断开',async()=> {
  const host=fakeSecrets(), c=new BinanceCredentials(host.api);
  await c.save('FAKE_KEY_OLD','FAKE_SECRET_OLD');
  host.fail('risk-binance-spot-slot-b-v1',true);
  await assert.rejects(c.save('FAKE_KEY_NEW','FAKE_SECRET_NEW'),error=>!String(error).includes('FAKE_KEY_NEW')&&!String(error).includes('FAKE_SECRET_NEW'));
  assert.equal(host.values.has('risk-binance-spot-slot-b-v1'),false);
  assert.deepEqual(await new BinanceCredentials(host.api).read(),{version:1,apiKey:'FAKE_KEY_OLD',secret:'FAKE_SECRET_OLD'});
  host.failDelete('risk-binance-spot-slot-a-v1');
  await assert.rejects(c.disconnectAndDelete(),/断开/);
  assert.equal(await new BinanceCredentials(host.api).isSaved(),false);
  await c.disconnectAndDelete();
});
test('本机凭据拒绝空值、首尾空格和超长输入',async()=> {
  const host=fakeSecrets(), c=new BinanceCredentials(host.api);
  for(const pair of [['','x'],['x',' '],[' x','y'],['x','y '],['x'.repeat(513),'y']] as const) await assert.rejects(c.save(pair[0],pair[1]));
  assert.equal(host.values.size,0);
});
test('断开标记写入失败时不宣称已经断开',async()=> {
  const host=fakeSecrets(), c=new BinanceCredentials(host.api);
  await c.save('FAKE_KEY','FAKE_SECRET');
  host.fail('risk-binance-spot-active-v1',false);
  await assert.rejects(c.disconnectAndDelete(),/连接状态无法确认/);
  assert.equal(await c.isSaved(),true);
  await c.disconnectAndDelete();
});
test('官方 secrets 契约替身：假凭据保存、读回、重建控制器、替换、删除 null',async()=> {
  const host=fakeSecrets(), c=new DummyCredentials(host.api);
  assert.equal(await c.read(),null);await c.save(1);assert.deepEqual(await c.read(),DUMMY[1]);
  const restarted=new DummyCredentials(host.api);assert.deepEqual(await restarted.read(),DUMMY[1]);
  await restarted.save(2);assert.deepEqual(await restarted.read(),DUMMY[2]);
  await restarted.disconnectAndDelete();assert.equal(await new DummyCredentials(host.api).read(),null);assert.equal(host.values.size,0);
});
test('候选写入、读回、切换失败（含写后报错）均保留旧活动凭据',async()=> {
  for (const failure of ['candidate-before','candidate-after','readback','commit-before','commit-after']) {
    const host=fakeSecrets(), c=new DummyCredentials(host.api);await c.save(1);
    if(failure==='readback')host.failRead('risk-dummy-slot-b-v1');
    else host.fail(failure.startsWith('commit')?'risk-dummy-active-v1':'risk-dummy-slot-b-v1',failure.endsWith('after'));
    await assert.rejects(c.save(2),error=>!String(error).includes(DUMMY[2].secret));
    assert.deepEqual(await new DummyCredentials(host.api).read(),DUMMY[1]);
    assert.ok(host.values.get('risk-dummy-slot-a-v1')?.includes(DUMMY[1].secret));
  }
});
test('部分删除失败明确错误；重启不恢复活动凭据，重试清理所有槽位',async()=> {
  const host=fakeSecrets(), c=new DummyCredentials(host.api);await c.save(1);host.failDelete('risk-dummy-slot-a-v1');
  await assert.rejects(c.disconnectAndDelete(),/保持断开/);assert.equal(await new DummyCredentials(host.api).read(),null);
  await c.disconnectAndDelete();assert.equal(host.values.size,0);
  await assert.rejects(requestAuthenticated());
});
test('凭据只有固定插件 secrets 键；没有普通 storage 或任意他插件命名空间',async()=> {
  const host=fakeSecrets(), c=new DummyCredentials(host.api);await c.save(1);
  assert.ok([...host.values.keys()].every(key=>/^risk-dummy-(active|slot-[ab])-v1$/.test(key)));
  assert.equal(exportState(syncedFixture(),null).includes(DUMMY[1].apiKey),false);
  assert.equal(exportState(syncedFixture(),null).includes(DUMMY[1].secret),false);
  host.values.set('other-addon-key','do-not-read'); await c.read();assert.equal(host.values.get('other-addon-key'),'do-not-read');
});

const externalAccount:Account={id:'external-user-spot',platform:'binance',sourceAccountId:'verified-owner-example',name:'外部固定响应样例',kind:'spot',currency:'USD'};
const at='2026-10-14T00:00:00Z', now='2026-10-14T00:00:30Z';
function externalState():PortfolioState {
  const s=parseExternalSpot({balances:[{asset:'BTC',free:'1',locked:'0'}]},externalAccount,'offline-external',at,at);
  s.positions[0].asset.type='crypto';s.positions[0].price={value:'10',currency:'USD',asOf:at,source:'外部脱敏报价样例'};
  return {schemaVersion:1,accounts:[{...externalAccount}],statuses:{[s.accountId]:{state:'ready',attemptedAt:at}},snapshots:{[s.accountId]:s}};
}
const policy={now,...DEFAULT_FRESHNESS};
test('external 来源不继承模拟账户、WRISKDEMO、模拟报价或成本；标识与采集起止保留',()=> {
  const s=externalState(), snapshot=s.snapshots[externalAccount.id];
  assert.equal(snapshot.dataMode,'external');assert.equal(snapshot.collectionStartedAt,at);assert.equal(snapshot.collectionEndedAt,at);
  assert.equal(calculateRisk(s,'USD',[],{},policy).total,'10.00000000');
  assert.throws(()=>parseExternalSpot({balances:[]},{...externalAccount,id:'demo-spot'},'x',at,at));
  assert.throws(()=>exportState(s,null),/备份格式|非模拟/);
  snapshot.positions[0].asset.code='WRISKDEMO_BTC';assert.throws(()=>calculateRisk(s,'USD',[],{},policy),/模拟/);
  snapshot.positions[0].asset.code='BTC';snapshot.positions[0].price!.source='固定测试报价';assert.throws(()=>calculateRisk(s,'USD',[],{},policy),/模拟/);
});
test('同一来源账户换 API Key 不能变成两份资产',()=> {
  const s=externalState();s.accounts.push({...externalAccount,id:'second-key-alias'});
  assert.throws(()=>calculateRisk(s,'USD',[],{},policy),/重复账户身份/);
});
test('余额过期/未来、价格过期/未来、汇率过期分别使当前估值失效，旧数量保留',()=> {
  for (const kind of ['balance','future-balance','price','future-price','fx']) {
    const s=externalState(), snapshot=s.snapshots[externalAccount.id];let currency='USD';let rates:FxRate[]=[];
    if(kind==='balance') {snapshot.collectionStartedAt='2026-10-13T00:00:00Z';snapshot.collectionEndedAt=snapshot.asOf='2026-10-13T00:00:00Z';}
    if(kind==='future-balance') snapshot.collectionStartedAt=snapshot.collectionEndedAt=snapshot.asOf='2026-10-15T00:00:00Z';
    if(kind==='price')snapshot.positions[0].price!.asOf='2026-10-13T00:00:00Z';
    if(kind==='future-price')snapshot.positions[0].price!.asOf='2026-10-15T00:00:00Z';
    if(kind==='fx'){currency='CNY';rates=[{from:'USD',to:'CNY',rate:'7',asOf:'2026-10-13T00:00:00Z',source:'外部汇率样例'}];}
    const r=calculateRisk(s,currency,rates,{},policy);assert.equal(r.coveredSubtotal,null);assert.equal(r.stressLoss,null);assert.equal(r.total,null);
    assert.equal(snapshot.positions[0].quantity,'1');assert.ok(r.issues.some(x=>/过期|未来/.test(x)));
  }
});
test('外部真实空余额为零；部分失败和缺价不冒充完整覆盖',()=> {
  const s=externalState(), snapshot=s.snapshots[externalAccount.id];snapshot.positions=[];
  assert.equal(calculateRisk(s,'USD',[],{},policy).total,'0.00000000');
  const n=applyBatch(s,[externalAccount.id],[{accountId:externalAccount.id,error:'失败'}],now);
  assert.equal(calculateRisk(n,'USD',[],{},policy).coveredSubtotal,null);assert.deepEqual(n.snapshots,s.snapshots);
  const p=externalState();delete p.snapshots[externalAccount.id].positions[0].price;
  assert.equal(calculateRisk(p,'USD',[],{},policy).total,null);
});
test('相同批次标签不能证明跨钱包原子性；外部多账户当前/历史总额均阻断',()=> {
  const s=externalState(), id='external-funding';s.accounts.push({...externalAccount,id,kind:'funding'});
  const copy=structuredClone(s.snapshots[externalAccount.id]);copy.accountId=id;
  copy.collectionStartedAt='2026-10-14T00:00:10Z';copy.collectionEndedAt=copy.asOf='2026-10-14T00:00:20Z';
  s.snapshots[id]=copy;s.statuses[id]={state:'ready',attemptedAt:now};
  const r=calculateRisk(s,'USD',[],{},policy);assert.equal(r.coveredSubtotal,null);assert.equal(r.lastKnownSubtotal,null);assert.deepEqual(r.assetValues,{});
  assert.ok(r.issues.some(x=>x.includes('内部划转')));
  const batch=Object.values(s.snapshots).map(snapshot=>({accountId:snapshot.accountId,snapshot}));
  copy.collectionStartedAt=copy.collectionEndedAt=copy.asOf=at;
  assert.equal(applyBatch(s,s.accounts.map(a=>a.id),batch,now).statuses[id].state,'failed');
});
test('Funding 只保存四个原始字段，无 quantity/total；不完整响应拒绝',()=> {
  const r=parseExternalFunding([{asset:'BTC',free:'1',locked:'2',freeze:'3',withdrawing:'4'}],'external-funding',at);
  assert.deepEqual(r.assets[0].components,{free:'1',locked:'2',freeze:'3',withdrawing:'4'});
  assert.equal('quantity' in r.assets[0],false);assert.equal('total' in r,false);assert.equal(r.status,'unverified');
  assert.throws(()=>parseExternalFunding([{asset:'BTC',free:'1'}],'external-funding',at));
});
test('导出递归白名单丢弃未知/假认证字段，自由文本不透传；恢复未知字段拒绝',()=> {
  const s:any=syncedFixture();s.apiKey=DUMMY[1].apiKey;s.accounts[0].secret=DUMMY[1].secret;s.accounts[0].name=DUMMY[1].secret;
  s.snapshots['demo-spot'].signature='FAKE_SIGNATURE';s.snapshots['demo-spot'].positions[0].apiKey=DUMMY[1].apiKey;
  s.snapshots['demo-spot'].positions[0].price.source=DUMMY[1].secret;
  s.statuses['demo-spot'].reason=DUMMY[1].secret;
  const out=exportState(s,{state:'pending',secret:DUMMY[1].secret});
  for(const value of [DUMMY[1].apiKey,DUMMY[1].secret,'FAKE_SIGNATURE']) assert.equal(out.includes(value),false);
  assert.equal(calculateRisk(restoreState(out),'USD',[],fixtureShocks()).coveredSubtotal,'30000.00000000');
  const parsed=JSON.parse(out);
  for(const inject of [(v:any)=>v.apiKey='fake',(v:any)=>v.state.snapshots['demo-spot'].secret='fake',(v:any)=>v.state.accounts[0].unknown='x',(v:any)=>v.hostStatus.signature='fake',(v:any)=>v.state.snapshots['demo-spot'].positions[0].balanceComponents.secret='fake']) {
    const v=structuredClone(parsed);inject(v);assert.throws(()=>restoreState(JSON.stringify(v)),/未批准/);
  }
  assert.equal(JSON.stringify(sanitizeFixtureState(s)).includes(DUMMY[1].secret),false);
});
test('历史 v1 正常模拟备份兼容；股票成功、external 及污染字段不可注入',()=> {
  const legacy={schemaVersion:1,dataMode:'fixture',state:syncedFixture(),hostStatus:{state:'pending'}};
  assert.equal(calculateRisk(restoreState(JSON.stringify(legacy)),'USD',[],fixtureShocks()).stressLoss,'5500.00000000');
  const bad:any=structuredClone(legacy);bad.state.snapshots['demo-spot'].dataMode='external';assert.throws(()=>restoreState(JSON.stringify(bad)));
  const polluted=JSON.stringify(legacy).replace('"schemaVersion":1','"__proto__":{"secret":"fake"},"schemaVersion":1');assert.throws(()=>restoreState(polluted));
});
test('模拟签名异常全链路替身：宿主先记 URL，界面脱敏不够；阻断门不调用服务器',async()=> {
  let received=0;const logs:string[]=[];
  const server=createServer((req,res)=>{received++;req.socket.destroy();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert.ok(address && typeof address!=='string');
  const signed=buildOfflineReadRequest('spot',DUMMY[1].apiKey,DUMMY[1].secret,1);
  const mockBroker=()=>new Promise<never>((_,reject)=> {
    const connection=request({hostname:'127.0.0.1',port:address.port,path:new URL(signed.url).pathname+new URL(signed.url).search,headers:signed.headers},res=>res.resume());
    connection.on('error',()=>{const error=`error sending request for url (${signed.url})`;logs.push(`[Invoke] Command failed: ${error}`);reject(new Error(error));});connection.end();
  });
  try {
    // 负对照模拟 reqwest 风格错误及宿主 invoke 日志，不运行官方 Rust/代理。
    let display='';try {await mockBroker();}catch {display='固定安全错误';}
    assert.equal(received,1);assert.ok(logs[0].includes('signature='));assert.equal(display.includes('signature='),false);
    logs.length=0;await assert.rejects(requestAuthenticated(),/阻断/);
    assert.equal(received,1);assert.deepEqual(logs,[]);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
