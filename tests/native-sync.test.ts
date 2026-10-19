// 原生同步核心：映射、身份、去重、预览、写入与读回。全部为合成数据，不接触真实宿主。
import test from 'node:test';
import assert from 'node:assert/strict';
import {spotSnapshot,spotRisk} from '../src/spot';
import {buildNativePlan,nativeAccountKey,nativeAccountLabel,reconcilePlan,resolveUsdtRate} from '../src/native-sync';
import {NativeSync,findBoundAccount,type NativeHostBridge,type NativeAccount} from '../src/native-host';
import type {PortfolioState} from '../src/domain';

const NOW=Date.parse('2026-10-19T10:00:00Z'),AT=new Date(NOW).toISOString(),DATE='2026-10-19';
function valuation(balances:{asset:string;free:string}[],prices:Record<string,string>){
  const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:balances.map(b=>({...b,locked:'0'}))},'external',AT,AT);
  for(const p of snapshot.positions)if(prices[p.asset.code])p.price={value:prices[p.asset.code],currency:'USDT',asOf:AT,source:'external:test'};
  const state:PortfolioState={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:AT}}};
  return {state,report:spotRisk(state,NOW)};
}
const KEY=nativeAccountKey('123456789');
const base=()=>valuation([{asset:'USDT',free:'750'},{asset:'BTC',free:'0.01'},{asset:'ETH',free:'0.5'},{asset:'NOPAIR',free:'3'}],{BTC:'65000',ETH:'2500',USDT:'1'});

test('映射：USDT 作为现金，其余为 CRYPTO/USDT 持仓，零数量与非法代码不写入',()=>{
 const v=valuation([{asset:'USDT',free:'100'},{asset:'BTC',free:'0.5'},{asset:'ZERO',free:'0'},{asset:'币',free:'2'}],{BTC:'65000',USDT:'1'});
 const plan=buildNativePlan({state:v.state,report:v.report,accountKey:KEY,baseCurrency:'USD',date:DATE});
 assert.deepEqual(plan.cashBalances,{USDT:'100'});
 assert.deepEqual(plan.holdings.map(h=>[h.symbol,h.quantity,h.currency,h.quoteCcy,h.instrumentType]),[['BTC','0.5','USDT','USDT','CRYPTO']]);
 assert.ok(plan.warnings.some(w=>w.code==='UNSUPPORTED_SYMBOL'&&w.symbol==='币'));
 assert.ok(plan.warnings.some(w=>w.code==='USDT_AS_CASH'));
 assert.equal(plan.summary.positions,1);
});
test('账户身份：同UID稳定、不同UID不同，原始UID不进入计划',()=>{
 assert.equal(nativeAccountKey('123456789'),KEY);
 assert.notEqual(nativeAccountKey('987654321'),KEY);
 assert.equal(nativeAccountLabel(KEY),`Binance Spot · ${KEY.slice(0,6)}`);
 const plan=buildNativePlan({state:base().state,report:base().report,accountKey:KEY,baseCurrency:'USD',date:DATE});
 assert.equal(plan.account.providerAccountId,KEY);
 assert.ok(!JSON.stringify(plan).includes('123456789'));
 assert.equal(plan.account.accountType,'CRYPTOCURRENCY');
 assert.equal(plan.account.trackingMode,'HOLDINGS');
});
test('去重：优先 provider 绑定，其次确定性名称，不碰其他账户',()=>{
 const bound:NativeAccount={id:'a1',name:'任意名',accountType:'CRYPTOCURRENCY',currency:'USDT',trackingMode:'HOLDINGS',provider:'binance-spot',providerAccountId:KEY};
 assert.equal(findBoundAccount([bound],KEY)?.id,'a1');
 const named:NativeAccount={id:'a2',name:nativeAccountLabel(KEY),accountType:'CRYPTOCURRENCY',currency:'USDT',trackingMode:'HOLDINGS'};
 assert.equal(findBoundAccount([named],KEY)?.id,'a2');
 const other:NativeAccount={id:'a3',name:'WRISK 模拟',accountType:'CRYPTOCURRENCY',currency:'USD',trackingMode:'HOLDINGS'};
 assert.equal(findBoundAccount([other],KEY),null);
});
test('成本只写已知值，未知成本保留为缺省而不是 0',()=>{
 const v=base();
 const plan=buildNativePlan({state:v.state,report:v.report,accountKey:KEY,baseCurrency:'USD',date:DATE,costs:{BTC:{unitCost:'60000'},ETH:{unitCost:'0'}}});
 const btc=plan.holdings.find(h=>h.symbol==='BTC')!,eth=plan.holdings.find(h=>h.symbol==='ETH')!;
 assert.equal(btc.averageCost,'60000');
 assert.equal(eth.averageCost,undefined);
 assert.ok(plan.warnings.some(w=>w.code==='NO_COST'&&w.symbol==='ETH'));
 assert.equal(plan.summary.costKnown,1);
});
test('指纹：数量或日期变化会改变，纯报价变化不进入指纹',()=>{
 const a=buildNativePlan({state:base().state,report:base().report,accountKey:KEY,baseCurrency:'USD',date:DATE});
 const b=buildNativePlan({state:base().state,report:base().report,accountKey:KEY,baseCurrency:'USD',date:'2026-10-20'});
 assert.notEqual(a.fingerprint,b.fingerprint);
 const changed=valuation([{asset:'USDT',free:'750'},{asset:'BTC',free:'0.02'},{asset:'ETH',free:'0.5'},{asset:'NOPAIR',free:'3'}],{BTC:'70000',ETH:'2500',USDT:'1'});
 const c=buildNativePlan({state:changed.state,report:changed.report,accountKey:KEY,baseCurrency:'USD',date:DATE});
 assert.notEqual(a.fingerprint,c.fingerprint);
 // 仅报价变化：数量与成本不变，预览不应失效
 const repriced=valuation([{asset:'USDT',free:'750'},{asset:'BTC',free:'0.01'},{asset:'ETH',free:'0.5'},{asset:'NOPAIR',free:'3'}],{BTC:'71000',ETH:'2600',USDT:'1'});
 const d=buildNativePlan({state:repriced.state,report:repriced.report,accountKey:KEY,baseCurrency:'USD',date:DATE});
 assert.equal(a.fingerprint,d.fingerprint);
});
test('对账：浮点容差、缺失与多余都能区分',()=>{
 const plan=buildNativePlan({state:base().state,report:base().report,accountKey:KEY,baseCurrency:'USD',date:DATE});
 const ok=reconcilePlan(plan,[{symbol:'BTC',quantity:0.01},{symbol:'ETH',quantity:0.5},{symbol:'NOPAIR',quantity:3}]);
 assert.equal(ok.ok,true);assert.equal(ok.matched,3);
 const bad=reconcilePlan(plan,[{symbol:'BTC',quantity:0.02},{symbol:'NOPAIR',quantity:3}]);
 assert.equal(bad.ok,false);assert.deepEqual(bad.mismatched.map(m=>m.symbol),['BTC']);assert.deepEqual(bad.missing,['ETH']);
 const extra=reconcilePlan(plan,[{symbol:'BTC',quantity:0.01},{symbol:'ETH',quantity:0.5},{symbol:'NOPAIR',quantity:3},{symbol:'DOGE',quantity:1}]);
 assert.deepEqual(extra.extra,['DOGE']);assert.equal(extra.ok,true);
});

function harness(overrides:{rate?:number|null;base?:string;existing?:NativeAccount[];manual?:boolean;quoteFail?:boolean;dated?:{rate:number|null;error?:string|null};records?:{fromCurrency:string;toCurrency:string;rate:number|string;source?:string;timestamp?:string}[]}={}){
 const accounts:NativeAccount[]=[...(overrides.existing??[])];
 const saves:{accountId:string;holdings:any[];cash:Record<string,string>;date:string}[]=[];
 const quotes:string[]=[];
 const modes=new Map<string,'MARKET'|'MANUAL'>();
 const quoteStore=new Map<string,{price:number;source:string}>();
 let checkCalls=0,createCalls=0,boundId:string|null=null,saveFail=false,readFail=false;
 const bridge:NativeHostBridge={
  listAccounts:async()=>accounts,
  createAccount:async input=>{createCalls++;const a:NativeAccount={id:'acc-new',...input};accounts.push(a);return a;},
  checkImport:async()=>{checkCalls++;return {existingDates:[],symbols:[],validationErrors:[]};},
  saveSnapshot:async(accountId,holdings,cash,date)=>{
    if(saveFail){saveFail=false;throw new Error('save');}
    saves.push({accountId,holdings,cash,date});
    // 复刻宿主副作用：MANUAL 资产在快照时用 averageCost 生成 12:00 备用报价。
    for(const h of holdings){
      const assetId='asset-'+h.symbol;
      if((overrides.manual||modes.get(assetId)==='MANUAL')&&h.averageCost){
        quoteStore.set(`${date.replaceAll('-','')}_${assetId.toUpperCase()}`,{price:Number(h.averageCost),source:'MANUAL'});
      }
    }
  },
  listSnapshots:async()=>[{snapshotDate:DATE,positionCount:saves.at(-1)?.holdings.length??0,cashCurrencyCount:Object.keys(saves.at(-1)?.cash??{}).length}],
  getByDate:async()=>{if(readFail){readFail=false;throw new Error('read');}return (saves.at(-1)?.holdings??[]).map(h=>({symbol:h.symbol,quantity:Number(h.quantity),assetId:'asset-'+h.symbol,quoteMode:modes.get('asset-'+h.symbol)??(overrides.manual?'MANUAL':'MARKET')}));},
  updateQuote:async(assetId,quote)=>{if(overrides.quoteFail)throw new Error('x');quoteStore.set(quote.id,{price:quote.close,source:quote.dataSource});quotes.push(assetId);},
  updateQuoteMode:async(assetId,mode)=>{modes.set(assetId,mode);},
  readCosts:async()=>({}),
  writeCosts:async()=>{},
  baseCurrency:async()=>overrides.base??'USD',
  rateForDate:async()=>overrides.dated??{rate:null,error:'Invalid currency code: USDT'},
  listRates:async()=>overrides.records??(overrides.rate===null?[]:[{fromCurrency:'USDT',toCurrency:'USD',rate:overrides.rate===undefined?0.9998:overrides.rate,source:'MANUAL',timestamp:'2026-10-19T00:00:00Z'}]),
  today:()=>DATE,
  readBinding:async()=>boundId,
  writeBinding:async(_key,id)=>{boundId=id;}
 };
 return {bridge,saves,quotes,accounts,modes,quoteStore,get createCalls(){return createCalls;},get checkCalls(){return checkCalls;},failNextSave:()=>{saveFail=true;},failNextRead:()=>{readFail=true;}};
}
test('预览：无绑定账户时建议创建；USDT→基础货币无汇率时阻止写入',async()=>{
 const v=base();
 const blocked=await new NativeSync(harness({rate:null}).bridge).preview(v,KEY,{},{allowUnknownCost:true});
 assert.equal(blocked.action,'create');
 assert.deepEqual(blocked.blocked,['NO_USDT_RATE']);
 const ok=await new NativeSync(harness().bridge).preview(v,KEY,{},{allowUnknownCost:true});
 assert.deepEqual(ok.blocked,[]);assert.equal(ok.rate,0.9998);
 assert.equal(ok.plan.holdings.length,3); // BTC、ETH 与缺价的 NOPAIR 都要保留
});
test('预览：已绑定账户会做符号预检，并把平均成本映射为 avgCost',async()=>{
 const existing:NativeAccount={id:'acc-1',name:'Binance Spot',accountType:'CRYPTOCURRENCY',currency:'USDT',trackingMode:'HOLDINGS',provider:'binance-spot',providerAccountId:KEY};
 const h=harness({existing:[existing]});
 let captured:any;
 h.bridge.checkImport=async(_id,snaps)=>{captured=snaps;return {existingDates:[DATE],symbols:[{symbol:'BTC',found:true,assetId:'asset-BTC'}],validationErrors:[]};};
 const preview=await new NativeSync(h.bridge).preview(base(),KEY,{BTC:{unitCost:'60000'}});
 assert.equal(preview.action,'bind');
 assert.deepEqual(preview.existingDates,[DATE]);
 assert.equal(captured[0].positions.find((p:any)=>p.symbol==='BTC').avgCost,'60000');
});
test('写入：必须显式确认；过期预览被拒绝；成功后读回对账并写报价',async()=>{
 const h=harness();const sync=new NativeSync(h.bridge),v=base();
 const preview=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 await assert.rejects(sync.apply(v,KEY,{},preview,'NOPE' as never),(e:any)=>e.code==='NOT_CONFIRMED');
 const stale=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 const changed=valuation([{asset:'USDT',free:'750'},{asset:'BTC',free:'0.02'},{asset:'ETH',free:'0.5'},{asset:'NOPAIR',free:'3'}],{BTC:'65000',ETH:'2500',USDT:'1'});
 await assert.rejects(sync.apply(changed,KEY,{},stale,'WRITE'),(e:any)=>e.code==='PREVIEW_STALE');
 const result=await sync.apply(v,KEY,{},preview,'WRITE');
 assert.equal(result.created,true);assert.equal(result.accountId,'acc-new');
 assert.equal(result.reconcile?.ok,true);
 assert.equal(result.quotesPushed,2);
 assert.equal(h.saves.length,1);
 assert.equal(h.saves[0].date,DATE);
 assert.deepEqual(h.saves[0].cash,{USDT:'750'});
});
test('重复同步：第二次绑定同一账户，不重复创建',async()=>{
 const h=harness();const sync=new NativeSync(h.bridge),v=base();
 const first=await sync.preview(v,KEY,{},{allowUnknownCost:true});await sync.apply(v,KEY,{},first,'WRITE');
 const second=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 assert.equal(second.action,'bind');
 const result=await sync.apply(v,KEY,{},second,'WRITE');
 assert.equal(result.created,false);
 assert.equal(h.createCalls,1);
 assert.equal(h.saves.length,2);
 assert.equal(h.saves[1].accountId,h.saves[0].accountId);
});
test('MANUAL 资产不覆盖报价；报价失败不回滚持仓',async()=>{
 const manual=harness({manual:true});const v=base();
 const p1=await new NativeSync(manual.bridge).preview(v,KEY,{},{allowUnknownCost:true});
 const r1=await new NativeSync(manual.bridge).apply(v,KEY,{},p1,'WRITE');
 // MANUAL 只表示不参与宿主提供者同步；本连接器仍写入市场报价。
 assert.equal(r1.quotesPushed,2);assert.equal(r1.quoteModeUpdated,0);
 const failing=harness({quoteFail:true});
 const p2=await new NativeSync(failing.bridge).preview(v,KEY,{},{allowUnknownCost:true});
 const r2=await new NativeSync(failing.bridge).apply(v,KEY,{},p2,'WRITE');
 assert.equal(r2.quotesPushed,0);assert.equal(r2.quoteFailures,2);
 assert.equal(r2.reconcile?.ok,true);
 assert.equal(r2.stage,'quotes-partial');
 assert.ok(r2.warnings.some(w=>w.includes('报价或报价模式写入失败')));
});
test('宿主不可用时预览直接报固定错误，不伪造成功',async()=>{
 const bridge={listAccounts:async()=>{throw new Error('boom');}} as unknown as NativeHostBridge;
 await assert.rejects(new NativeSync(bridge).preview(base(),KEY,{}),(e:any)=>e.code==='HOST_UNAVAILABLE');
});

test('成本未知默认阻止原生写入；显式允许后才可继续',async()=>{
 const h=harness();
 const blocked=await new NativeSync(h.bridge).preview(base(),KEY,{});
 assert.ok(blocked.blocked.includes('MISSING_COST'));
 assert.deepEqual(blocked.costUnknownSymbols,['BTC','ETH','NOPAIR']);
 await assert.rejects(new NativeSync(h.bridge).apply(base(),KEY,{},blocked,'WRITE'),(e:any)=>e.code==='BLOCKED');
 const allowed=await new NativeSync(h.bridge).preview(base(),KEY,{},{allowUnknownCost:true});
 assert.equal(allowed.blocked.includes('MISSING_COST'),false);
 assert.equal(allowed.allowUnknownCost,true);
});
test('绑定账户不是 HOLDINGS 加密账户时阻止写入',async()=>{
 const existing:NativeAccount={id:'acc-t',name:'Binance Spot',accountType:'CRYPTOCURRENCY',currency:'USDT',trackingMode:'TRANSACTIONS',provider:'binance-spot',providerAccountId:KEY};
 const h=harness({existing:[existing]});
 const preview=await new NativeSync(h.bridge).preview(base(),KEY,{},{allowUnknownCost:true});
 assert.ok(preview.blocked.includes('ACCOUNT_MISMATCH'));
 assert.equal(h.saves.length,0);
});
test('读回失败时保留账户与快照，不重试也不重建',async()=>{
 const h=harness();const sync=new NativeSync(h.bridge),v=base();
 const preview=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 h.failNextRead();
 const result=await sync.apply(v,KEY,{},preview,'WRITE');
 assert.equal(result.readback,'failed');
 assert.equal(result.reconcile,null);
 assert.equal(result.created,true);
 assert.equal(h.createCalls,1);
 assert.equal(h.saves.length,1);
 assert.equal(result.quotesPushed,0);
 assert.ok(result.warnings.some(w=>w.includes('读回失败')));
});
test('用户改名或宿主丢弃 provider 后，仍通过持久绑定找回账户',async()=>{
 const h=harness();const sync=new NativeSync(h.bridge),v=base();
 const p1=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 await sync.apply(v,KEY,{},p1,'WRITE');
 h.accounts[0].name='我改过的名字';
 delete h.accounts[0].provider;
 delete h.accounts[0].providerAccountId;
 const p2=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 assert.equal(p2.action,'bind');
 assert.equal(p2.bound?.id,h.accounts[0].id);
 assert.equal(h.createCalls,1);
});
test('写快照失败后重试：账户保留且不重复创建，同日覆盖',async()=>{
 const h=harness();const sync=new NativeSync(h.bridge),v=base();
 const p1=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 h.failNextSave();
 await assert.rejects(sync.apply(v,KEY,{},p1,'WRITE'),(e:any)=>e.code==='SNAPSHOT_SAVE_FAILED');
 assert.equal(h.createCalls,1);
 assert.equal(h.saves.length,0);
 const p2=await sync.preview(v,KEY,{},{allowUnknownCost:true});
 assert.equal(p2.action,'bind');
 const result=await sync.apply(v,KEY,{},p2,'WRITE');
 assert.equal(result.created,false);
 assert.equal(h.createCalls,1);
 assert.equal(h.saves.length,1);
 assert.equal(h.saves[0].date,p1.plan.date);
});

// 真实宿主 3.10.0：日期汇率接口只接受 3 位代码，USDT 返回 InvalidCurrencyCode；
// 手动汇率本身有效，必须回退到 exchangeRates.getAll() 的最新记录。
test('日期接口拒绝USDT时回退到最新手动汇率，不再误报不可用',async()=>{
 const h=harness({rate:1,dated:{rate:null,error:'Invalid currency code: USDT'}});
 const probe=await new NativeSync(h.bridge).probe(KEY);
 assert.equal(probe.usdtRate,1);
 assert.equal(probe.rateDiagnostic.status,'valid');
 assert.equal(probe.rateDiagnostic.source,'latest');
 assert.deepEqual(probe.reasons,[]);
 const preview=await new NativeSync(h.bridge).preview(base(),KEY,{},{allowUnknownCost:true});
 assert.equal(preview.blocked.includes('NO_USDT_RATE'),false);
 assert.equal(preview.rate,1);
});
test('汇率解析矩阵：日期优先、最新回退、反向、无记录、不可解析、权限、过期',()=>{
 assert.deepEqual(resolveUsdtRate({base:'USDT',date:DATE}),{rate:1,status:'valid',source:'same'});
 assert.equal(resolveUsdtRate({base:'USD',date:DATE,dated:{rate:1}}).source,'dated');
 const latest=resolveUsdtRate({base:'USD',date:DATE,dated:{rate:null,error:'Invalid currency code: USDT'},records:[{fromCurrency:'USDT',toCurrency:'USD',rate:'1.0',source:'MANUAL',timestamp:'2026-10-19T00:00:00Z'}],now:'2026-10-19T12:00:00Z'});
 assert.equal(latest.rate,1);assert.equal(latest.source,'latest');assert.equal(latest.status,'valid');
 const inverse=resolveUsdtRate({base:'USD',date:DATE,dated:{rate:null},records:[{fromCurrency:'USD',toCurrency:'USDT',rate:1.25}],now:'2026-10-19T00:00:00Z'});
 assert.equal(inverse.rate,0.8);assert.equal(inverse.source,'inverse');
 assert.equal(resolveUsdtRate({base:'USD',date:DATE,dated:{rate:null},records:[]}).status,'no-record');
 assert.equal(resolveUsdtRate({base:'USD',date:DATE,dated:{rate:null},records:[{fromCurrency:'USDT',toCurrency:'USD',rate:'abc'}]}).status,'unparseable');
 assert.equal(resolveUsdtRate({base:'USD',date:DATE,listError:new Error('permission denied')}).status,'permission-denied');
 assert.equal(resolveUsdtRate({base:'USD',date:DATE,listError:new Error('boom')}).status,'api-unavailable');
 const stale=resolveUsdtRate({base:'USD',date:DATE,dated:{rate:null},records:[{fromCurrency:'USDT',toCurrency:'USD',rate:1,timestamp:'2026-10-01T00:00:00Z'}],now:'2026-10-19T00:00:00Z'});
 assert.equal(stale.rate,1);assert.equal(stale.status,'stale');
});
test('汇率接口权限被拒绝时区分于缺少汇率，并保持写入阻断',async()=>{
 const h=harness({});
 h.bridge.rateForDate=async()=>{throw new Error('permission denied');};
 h.bridge.listRates=async()=>{throw new Error('permission denied');};
 const probe=await new NativeSync(h.bridge).probe(KEY);
 assert.equal(probe.available,true);
 assert.equal(probe.usdtRate,null);
 assert.equal(probe.rateDiagnostic.status,'permission-denied');
 const preview=await new NativeSync(h.bridge).preview(base(),KEY,{},{allowUnknownCost:true});
 assert.ok(preview.blocked.includes('NO_USDT_RATE'));
});

test('MANUAL 快照的成本备用报价被市场价覆盖，成本不会成为最终市价',async()=>{
 const v=valuation([{asset:'BTC',free:'1'},{asset:'USDT',free:'100'}],{BTC:'700',USDT:'1'});
 const costs={BTC:{unitCost:'500'},USDT:{unitCost:'1'}};
 const h=harness();const sync=new NativeSync(h.bridge);
 const p1=await sync.preview(v,KEY,costs);await sync.apply(v,KEY,costs,p1,'WRITE');
 const p2=await sync.preview(v,KEY,costs);const r2=await sync.apply(v,KEY,costs,p2,'WRITE');
 assert.equal(r2.stage,'reconciled');
 const id=`${DATE.replaceAll('-','')}_ASSET-BTC`;
 assert.equal(h.quoteStore.get(id)?.price,700);
 assert.equal(h.quoteStore.get(id)?.source,'BINANCE');
 assert.equal(h.modes.get('asset-BTC'),'MANUAL'); // 宿主不再把该资产交给默认提供者
});
test('提交状态区分已对账、报价待修复与读回失败',async()=>{
 const v=valuation([{asset:'BTC',free:'1'},{asset:'USDT',free:'100'}],{BTC:'700',USDT:'1'});
 const costs={BTC:{unitCost:'500'},USDT:{unitCost:'1'}};
 const ok=new NativeSync(harness().bridge);const p=await ok.preview(v,KEY,costs);
 assert.equal((await ok.apply(v,KEY,costs,p,'WRITE')).stage,'reconciled');
 const qf=harness({quoteFail:true});const s2=new NativeSync(qf.bridge);const p2=await s2.preview(v,KEY,costs);
 const r2=await s2.apply(v,KEY,costs,p2,'WRITE');
 assert.equal(r2.stage,'quotes-partial');
 assert.ok(r2.warnings.some(w=>w.includes('仅修复报价')));
 const rf=harness();const s3=new NativeSync(rf.bridge);const p3=await s3.preview(v,KEY,costs);
 rf.failNextRead();
 assert.equal((await s3.apply(v,KEY,costs,p3,'WRITE')).stage,'readback-failed');
});
