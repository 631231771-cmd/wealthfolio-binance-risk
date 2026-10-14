import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBatch, assetKey, calculateRisk, type PortfolioState } from '../src/domain';
import { emptyState, fixtureBatch, fixtureShocks, syncedFixture, DEMO_IDS, FIXTURE_TIME } from '../src/fixtures';
import { exportState, restoreState } from '../src/host';

test('手算：30000 USD，账户 24000/6000，BTC 25000，情景损失 5500', () => {
  const r=calculateRisk(syncedFixture(),'USD',[],fixtureShocks());
  assert.equal(r.coveredSubtotal,'30000.00000000');
  assert.equal(r.accountValues['demo-spot'],'24000.00000000');
  assert.equal(r.accountWeights['demo-spot'],'0.800000');
  assert.equal(r.maxAssetWeight,'0.833333');
  assert.equal(r.accountHhi,'0.680000');
  assert.equal(r.assetHhi,'0.722222');
  assert.equal(r.stressLoss,'5500.00000000');
  assert.equal(r.total,null); assert.equal(r.complete,false);
  assert.ok(r.issues.some(x=>x.includes('Stocks')));
});
test('所有账户覆盖时才给出完整总资产；真正空账户可以为零', () => {
  const s=syncedFixture(); s.accounts=s.accounts.filter(a=>a.id!=='demo-stocks');
  assert.equal(calculateRisk(s,'USD',[]).total,'30000.00000000');
  s.snapshots['demo-spot'].positions=[]; s.snapshots['demo-funding'].positions=[];
  assert.equal(calculateRisk(s,'USD',[]).total,'0.00000000');
});
test('重复同步替换快照，不增加资产', () => {
  const s=syncedFixture();
  const n=applyBatch(s,DEMO_IDS,fixtureBatch().map(snapshot=>({accountId:snapshot.accountId,snapshot})),FIXTURE_TIME);
  assert.deepEqual(n,s); assert.equal(calculateRisk(n,'USD',[]).coveredSubtotal,'30000.00000000');
});
test('账户间划转保留总量，只改变账户占比', () => {
  const s=syncedFixture(true); const r=calculateRisk(s,'USD',[]);
  assert.equal(r.coveredSubtotal,'30000.00000000');
  assert.equal(r.accountValues['demo-spot'],'19000.00000000');
  assert.equal(r.accountValues['demo-funding'],'11000.00000000');
});
test('同步失败不清零：旧快照保留，当前估值不可用', () => {
  const old=syncedFixture(); const n=applyBatch(old,DEMO_IDS,[{accountId:'demo-spot',error:'权限错误'}],FIXTURE_TIME);
  assert.deepEqual(n.snapshots,old.snapshots);
  const r=calculateRisk(n,'USD',[]);
  assert.equal(r.total,null); assert.equal(r.lastKnownSubtotal,'30000.00000000');
  assert.equal(r.coveredSubtotal,null); assert.equal(r.stressLoss,null);
  assert.equal(r.coverage,'unavailable');
  assert.equal(r.maxAccountWeight,null); assert.equal(r.assetHhi,null);
  assert.deepEqual(r.lastKnownSnapshotTimes,[FIXTURE_TIME]);
  assert.equal(r.accountValues['demo-spot'],undefined);
  assert.equal(n.statuses['demo-funding'].state,'failed');
});

test('未连接、没有账户及 ready 却缺少快照都不等于零', () => {
  const noSnapshot=emptyState(); noSnapshot.statuses['demo-spot'].state='ready';
  for (const s of [emptyState(),noSnapshot,{...emptyState(),accounts:[]}]) {
    const r=calculateRisk(s,'USD',[],fixtureShocks());
    assert.equal(r.coveredSubtotal,null); assert.equal(r.stressLoss,null);
    assert.equal(r.total,null); assert.equal(r.lastKnownSubtotal,null);
    assert.equal(r.complete,false); assert.deepEqual(r.lastKnownSnapshotTimes,[]);
    assert.equal(r.coverage,'unavailable'); assert.deepEqual(r.accountWeights,{});
  }
});

test('首次同步全部失败：没有历史快照，不虚构历史零资产', () => {
  const s=applyBatch(emptyState(),DEMO_IDS,DEMO_IDS.map(accountId=>({accountId,error:'固定失败'})),FIXTURE_TIME);
  const r=calculateRisk(s,'USD',[],fixtureShocks());
  assert.equal(r.coveredSubtotal,null); assert.equal(r.stressLoss,null);
  assert.equal(r.lastKnownSubtotal,null); assert.equal(r.accountHhi,null);
  assert.ok(r.issues.some(x=>x.includes('同步失败')));
});

test('部分账户失效：只计算成功账户，历史持仓不参与当前风险', () => {
  const s=syncedFixture(); s.statuses['demo-spot']={state:'failed',attemptedAt:'2026-10-13T01:00:00Z'};
  const r=calculateRisk(s,'USD',[],fixtureShocks());
  assert.equal(r.coveredSubtotal,'6000.00000000'); assert.equal(r.stressLoss,'1100.00000000');
  assert.equal(r.total,null); assert.equal(r.complete,false); assert.equal(r.coverage,'partial');
  assert.deepEqual(r.currentAccountIds,['demo-funding']); assert.equal(r.accountValues['demo-spot'],undefined);
  assert.equal(r.lastKnownSubtotal,'30000.00000000'); assert.deepEqual(r.lastKnownSnapshotTimes,[FIXTURE_TIME]);
  const btc=assetKey(s.snapshots['demo-spot'].positions[0].asset);
  assert.equal(r.assetValues[btc],'5000.00000000');
});

test('成功空快照及有报价零数量：小计和压力为真实零，集中度无定义', () => {
  for (const empty of [true,false]) {
    const s=syncedFixture(); s.accounts=s.accounts.filter(a=>a.id!=='demo-stocks');
    for (const snapshot of Object.values(s.snapshots)) {
      if (empty) snapshot.positions=[]; else snapshot.positions.forEach(p=>p.quantity='0');
    }
    const r=calculateRisk(s,'USD',[],fixtureShocks());
    assert.equal(r.coveredSubtotal,'0.00000000'); assert.equal(r.stressLoss,'0.00000000');
    assert.equal(r.total,'0.00000000'); assert.equal(r.lastKnownSubtotal,'0.00000000');
    assert.equal(r.coverage,'complete'); assert.equal(r.complete,true);
    assert.equal(r.accountValues['demo-spot'],'0.00000000');
    assert.equal(r.maxAssetWeight,null); assert.equal(r.accountHhi,null);
    assert.deepEqual(r.assetWeights,{});
  }
});

test('成功零账户加失效账户：部分覆盖零不冒充完整零资产', () => {
  const s=syncedFixture(); s.snapshots['demo-funding'].positions=[];
  s.statuses['demo-spot'].state='failed';
  const r=calculateRisk(s,'USD',[],fixtureShocks());
  assert.equal(r.coveredSubtotal,'0.00000000'); assert.equal(r.stressLoss,'0.00000000');
  assert.equal(r.total,null); assert.equal(r.coverage,'partial');
  assert.equal(r.lastKnownSubtotal,'24000.00000000');
});

test('全部缺价或缺汇率：成功同步不等于可估值，不返回有效零风险', () => {
  for (const missing of ['price','fx']) {
    const s=syncedFixture();
    if (missing==='price') for (const snapshot of Object.values(s.snapshots)) snapshot.positions.forEach(p=>delete p.price);
    const r=calculateRisk(s,missing==='fx'?'CNY':'USD',[],fixtureShocks());
    assert.equal(r.coveredSubtotal,null); assert.equal(r.stressLoss,null); assert.equal(r.total,null);
    assert.equal(r.lastKnownSubtotal,null); assert.equal(r.coverage,'unavailable');
    assert.equal(r.unpricedPositionCount,4); assert.equal(r.currentAccountIds.length,2);
    assert.deepEqual(r.accountValues,{}); assert.equal(r.assetHhi,null);
  }
});

test('部分缺价：显式保留估值缺口，只报告有价格部分的风险', () => {
  const s=syncedFixture(); delete s.snapshots['demo-spot'].positions[0].price;
  const r=calculateRisk(s,'USD',[],fixtureShocks());
  assert.equal(r.coveredSubtotal,'10000.00000000'); assert.equal(r.stressLoss,'1500.00000000');
  assert.equal(r.unpricedPositionCount,1); assert.equal(r.coverage,'partial'); assert.equal(r.total,null);
  assert.equal(r.lastKnownPartial,true); assert.deepEqual(r.lastKnownSnapshotTimes,[FIXTURE_TIME]);
  assert.equal(r.accountValues['demo-spot'],'4000.00000000');
});

test('仅未支持账户不可用；历史时间范围不能伪装单一完整快照', () => {
  const unsupported=emptyState(); unsupported.accounts=unsupported.accounts.filter(a=>a.id==='demo-stocks');
  const r=calculateRisk(unsupported,'USD',[]);
  assert.equal(r.coveredSubtotal,null); assert.equal(r.stressLoss,null); assert.equal(r.total,null);
  assert.ok(r.issues.some(x=>x.includes('尚未支持')));
  const mixed=syncedFixture(); mixed.snapshots['demo-spot'].asOf='2026-10-12T00:00:00Z';
  const h=calculateRisk(mixed,'USD',[]);
  assert.deepEqual(h.lastKnownSnapshotTimes,['2026-10-12T00:00:00Z',FIXTURE_TIME]);
  assert.equal(h.lastKnownPartial,true);
});
test('划转过程中混合批次不能发布成功资产', () => {
  const snaps=fixtureBatch(); snaps[1].batchId='different-generation';
  const n=applyBatch(syncedFixture(),DEMO_IDS,snaps.map(snapshot=>({accountId:snapshot.accountId,snapshot})),FIXTURE_TIME);
  assert.equal(n.statuses['demo-spot'].state,'failed'); assert.equal(calculateRisk(n,'USD',[]).total,null);
});
test('账户快照缺失、重复响应和错误账户身份全部拒绝', () => {
  const s=fixtureBatch()[0];
  for (const results of [[{accountId:s.accountId,snapshot:s}], [{accountId:s.accountId,snapshot:s},{accountId:s.accountId,snapshot:s}], [{accountId:'demo-funding',snapshot:s}]]) {
    assert.equal(applyBatch(emptyState(),DEMO_IDS,results,FIXTURE_TIME).statuses['demo-spot'].state,'failed');
  }
});
test('缺价格保留持仓并明确缺口；不能捏造完整估值', () => {
  const s=syncedFixture(); delete s.snapshots['demo-spot'].positions[0].price;
  const r=calculateRisk(s,'USD',[]);
  assert.equal(s.snapshots['demo-spot'].positions[0].quantity,'0.4');
  assert.equal(r.coveredSubtotal,'10000.00000000'); assert.equal(r.total,null);
  assert.ok(r.issues.some(x=>x.includes('缺少价格')));
});
test('通用账户身份去重；币种、交易所、资产类型防止代码冲突', () => {
  const s=syncedFixture(); s.accounts.push({...s.accounts[0],id:'duplicate'});
  assert.throws(()=>calculateRisk(s,'USD',[]),/重复账户/);
  const crypto=fixtureBatch()[0].positions[0].asset;
  assert.notEqual(assetKey(crypto),assetKey({...crypto,type:'equity'}));
  assert.notEqual(assetKey(crypto),assetKey({...crypto,venue:'XSHG'}));
  assert.notEqual(assetKey(crypto),assetKey({...crypto,quoteCurrency:'CNY'}));
});
test('账户分别持有同一资产：保留账户数量，风险敞口正确汇总', () => {
  const s=syncedFixture(),key=assetKey(s.snapshots['demo-spot'].positions[0].asset);
  assert.equal(s.snapshots['demo-spot'].positions[0].quantity,'0.4');
  assert.equal(s.snapshots['demo-funding'].positions[0].quantity,'0.1');
  assert.equal(calculateRisk(s,'USD',[]).assetValues[key],'25000.00000000');
});
test('CNY 与 USD 十进制统一估值并记录汇率时间', () => {
  const s: PortfolioState={schemaVersion:1,accounts:[{id:'broker-demo',platform:'fixture-broker',sourceAccountId:'sample',name:'通用证券样例',kind:'securities',currency:'CNY'}],
    statuses:{'broker-demo':{state:'ready',attemptedAt:FIXTURE_TIME}},snapshots:{'broker-demo':{accountId:'broker-demo',batchId:'fx-test',asOf:FIXTURE_TIME,dataMode:'fixture',positions:[
      {asset:{venue:'XSHG',code:'600000',type:'equity',quoteCurrency:'CNY'},quantity:'100',price:{value:'7',currency:'CNY',source:'固定样例',asOf:FIXTURE_TIME}},
      {asset:{venue:'XNAS',code:'AAPL',type:'equity',quoteCurrency:'USD'},quantity:'1',price:{value:'100',currency:'USD',source:'固定样例',asOf:FIXTURE_TIME}}
    ]}}};
  const fx={from:'USD',to:'CNY',rate:'7',asOf:FIXTURE_TIME,source:'固定汇率'};
  const r=calculateRisk(s,'CNY',[fx]); assert.equal(r.total,'1400.00000000'); assert.deepEqual(r.fxUsed,[fx]);
  assert.equal(calculateRisk(s,'CNY',[]).total,null);
});
test('负数、NaN、重复快照资产、价格币种错误和无效汇率拒绝', () => {
  const s=syncedFixture(); s.snapshots['demo-spot'].positions[0].quantity='-1';
  assert.throws(()=>calculateRisk(s,'USD',[]));
  const d=syncedFixture(); d.snapshots['demo-spot'].positions.push(d.snapshots['demo-spot'].positions[0]);
  assert.throws(()=>calculateRisk(d,'USD',[]));
  const c=syncedFixture(); c.snapshots['demo-spot'].positions[0].price!.currency='CNY';
  assert.throws(()=>calculateRisk(c,'USD',[]));
  assert.throws(()=>calculateRisk(syncedFixture(),'CNY',[{from:'USD',to:'CNY',rate:'0',asOf:FIXTURE_TIME,source:'test'}]));
});
test('插件独立备份恢复保持风险结果；拒绝假股票快照与外部账户', () => {
  const s=syncedFixture(),restored=restoreState(exportState(s,{state:'pending'}));
  assert.deepEqual(calculateRisk(restored,'USD',[],fixtureShocks()),calculateRisk(s,'USD',[],fixtureShocks()));
  const v=structuredClone(s); v.statuses['demo-stocks'].state='ready';
  assert.throws(()=>restoreState(exportState(v,null)),/股票/);
  const e=structuredClone(s); e.accounts[0].sourceAccountId='real-user';
  assert.throws(()=>restoreState(exportState(e,null)),/非模拟/);
});
