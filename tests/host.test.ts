import test from 'node:test';
import assert from 'node:assert/strict';
import type { Account, Holding, SnapshotHoldingInput } from '@wealthfolio/addon-sdk';
import { importDemoToHost, readHostSummary, type Host } from '../src/host';
import { syncedFixture } from '../src/fixtures';

function fakeHost() {
  const accounts: Account[]=[],saved=new Map<string,SnapshotHoldingInput[]>(),storage=new Map<string,string>();
  let fail=false,mismatch=false;
  const quotes: string[]=[];
  const api: Host={
    accounts:{getAll:async()=>accounts,create:async input=>{const a={...(input as Account),id:`host-generated-${accounts.length+1}`};accounts.push(a);return a;}},
    snapshots:{save:async(id,holdings)=>{if(fail&&accounts.find(a=>a.id===id)?.providerAccountId==='demo-funding')throw new Error('fixture failure');saved.set(id,structuredClone(holdings));},
      getByDate:async id=>(saved.get(id)??[]).map(h=>({quantity:mismatch?999:Number(h.quantity),instrument:{id:h.assetId,symbol:h.symbol}} as Holding))},
    quotes:{update:async id=>{quotes.push(id);}},
    portfolio:{update:async()=>{}},
    storage:{get:async k=>storage.get(k)??null,set:async(k,v)=>{storage.set(k,v);}}
  };
  return {api,accounts,saved,storage,quotes,setFailure:()=>{fail=true;},setMismatch:()=>{mismatch=true;}};
}
test('正式 SDK 调用契约：创建 HOLDINGS 账户、保存、报价、读回核对；重复导入不增仓', async()=>{
  const host=fakeHost();
  await importDemoToHost(host.api,syncedFixture()); await importDemoToHost(host.api,syncedFixture());
  assert.equal(host.accounts.length,2); assert.equal(host.saved.size,2);
  const spotId=host.accounts.find(a=>a.providerAccountId==='demo-spot')!.id;
  assert.equal(spotId,'host-generated-1');
  assert.equal(host.saved.get(spotId)![0].quantity,'0.4');
  assert.ok(host.saved.get(spotId)!.every(h=>h.symbol.startsWith('WRISKDEMO_')));
  assert.equal(JSON.parse(host.storage.get('host-account-map-v1')!)['demo-spot'],spotId);
  assert.equal(JSON.parse(host.storage.get('host-import-status')!).state,'verified');
  const summary=await readHostSummary({accounts:host.api.accounts,portfolio:{getHoldings:async id=>(host.saved.get(id)??[]).map(h=>({quantity:Number(h.quantity)} as Holding))}});
  assert.deepEqual(summary,{accounts:2,holdings:4});
});
test('主程序部分写入失败明确标记，不能伪装导入成功',async()=>{
  const host=fakeHost();host.setFailure();await assert.rejects(importDemoToHost(host.api,syncedFixture()),/部分写入/);
  assert.equal(JSON.parse(host.storage.get('host-import-status')!).state,'failed');
});
test('读回数量不一致及账户身份冲突均拒绝',async()=>{
  const host=fakeHost();host.setMismatch();await assert.rejects(importDemoToHost(host.api,syncedFixture()),/核对失败/);
  const other=fakeHost();other.accounts.push({id:'existing',providerAccountId:'demo-spot',meta:'other',trackingMode:'HOLDINGS'} as Account);
  await assert.rejects(importDemoToHost(other.api,syncedFixture()));
});
test('复用上一次部分失败创建的账户，拒绝重复来源账户',async()=>{
  const host=fakeHost();
  await host.api.accounts.create({name:'WRISK 模拟验证 / spot',providerAccountId:'demo-spot',meta:'wealthfolio-binance-risk:fixture:v1',trackingMode:'HOLDINGS',currency:'USD'});
  await importDemoToHost(host.api,syncedFixture()); assert.equal(host.accounts.length,2);
  const duplicate=fakeHost(); const account={name:'WRISK 模拟验证 / spot',providerAccountId:'demo-spot',meta:'wealthfolio-binance-risk:fixture:v1',trackingMode:'HOLDINGS',currency:'USD'};
  await duplicate.api.accounts.create(account);await duplicate.api.accounts.create(account);
  await assert.rejects(importDemoToHost(duplicate.api,syncedFixture())); assert.equal(duplicate.saved.size,0);
});
test('不完整批次和非模拟来源不能写入主程序',async()=>{
  const host=fakeHost(),s=syncedFixture();s.statuses['demo-spot'].state='failed';
  await assert.rejects(importDemoToHost(host.api,s));assert.equal(host.accounts.length,0);
  s.statuses['demo-spot'].state='ready';s.snapshots['demo-spot'].dataMode='external';
  await assert.rejects(importDemoToHost(host.api,s));assert.equal(host.accounts.length,0);
});
