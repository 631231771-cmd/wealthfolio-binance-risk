import type {AddonContext} from '@wealthfolio/addon-sdk';
import {nonnegative, type PortfolioState} from './domain';
import type {calculateRisk} from './domain';
import {buildNativePlan, resolveUsdtRate, type CostBook, type NativeAccountInput, type NativeHoldingInput, type NativePlan, type NativeWarning, type RateRecord, type RateResolution, reconcilePlan, NATIVE_PROVIDER, NATIVE_CURRENCY, nativeAccountLabel} from './native-sync';
import type {Valuation} from './portfolio-view';

export interface NativeAccount {
  id:string; name:string; accountType:string; currency:string; trackingMode:string;
  provider?:string; providerAccountId?:string;
}
export interface NativeCheck {
  existingDates:string[];
  symbols:{symbol:string;found:boolean;assetId?:string;currency?:string}[];
  validationErrors:string[];
}
export interface NativeSnapshotRow {snapshotDate:string;positionCount:number;cashCurrencyCount:number}
export interface NativeActualRow {symbol:string;quantity:number;assetId?:string;quoteMode?:string}
export interface NativeQuote {id:string;createdAt:string;dataSource:string;timestamp:string;assetId:string;open:number;high:number;low:number;volume:number;close:number;adjclose:number;currency:string}

// 只暴露本轮需要的能力，便于用替身完整验证预览/写入/读回，而不接触真实资料库。
export interface NativeHostBridge {
  listAccounts():Promise<NativeAccount[]>;
  createAccount(input:NativeAccountInput):Promise<NativeAccount>;
  checkImport(accountId:string,snapshots:{date:string;positions:{symbol:string;quantity:string;avgCost?:string;currency:string;quoteCcy?:string;instrumentType?:string}[];cashBalances:Record<string,string>}[]):Promise<NativeCheck>;
  saveSnapshot(accountId:string,holdings:NativeHoldingInput[],cashBalances:Record<string,string>,date:string):Promise<void>;
  listSnapshots(accountId:string,from:string,to:string):Promise<NativeSnapshotRow[]>;
  getByDate(accountId:string,date:string):Promise<NativeActualRow[]>;
  updateQuote(assetId:string,quote:NativeQuote):Promise<void>;
  updateQuoteMode(assetId:string,mode:'MARKET'|'MANUAL'):Promise<void>;
  readCosts():Promise<Record<string,{unitCost:string;source?:string;updatedAt?:string}>>;
  writeCosts(book:Record<string,{unitCost:string;source?:string;updatedAt?:string}>):Promise<void>;
  baseCurrency():Promise<string>;
  rateForDate(from:string,to:string,date:string):Promise<{rate:number|null;error?:string|null}>;
  listRates():Promise<RateRecord[]>;
  today():string;
  readBinding(key:string):Promise<string|null>;
  writeBinding(key:string,accountId:string):Promise<void>;
}
export type NativeErrorCode='NOT_CONFIRMED'|'PREVIEW_STALE'|'BLOCKED'|'HOST_UNAVAILABLE'|'ACCOUNT_CREATE_FAILED'|'SNAPSHOT_SAVE_FAILED'|'UID_INVALID';
export class NativeSyncError extends Error {
  constructor(readonly code:NativeErrorCode,readonly detail?:string){super(code);}
}
export interface NativeOptions {allowUnknownCost?:boolean}
export interface NativeProbe {
  available:boolean; baseCurrency:string; usdtRate:number|null; rateDiagnostic:RateResolution; accountCount:number;
  bound:NativeAccount|null; reasons:string[];
}
export interface NativePreview {
  plan:NativePlan; bound:NativeAccount|null; action:'create'|'bind'; rate:number|null;
  existingDates:string[]; symbols:NativeCheck['symbols']; validationErrors:string[];
  blocked:string[]; warnings:NativeWarning[];
  rateDiagnostic:RateResolution;
  allowUnknownCost:boolean; costUnknownSymbols:string[];
}
export type NativeStage='readback-failed'|'quotes-partial'|'reconciled';
export interface NativeResult {
  accountId:string; created:boolean; snapshotDate:string;
  positionCount:number; cashCurrencyCount:number;
  readback:'ok'|'failed';
  stage:NativeStage;
  quoteModeUpdated:number;
  reconcile:ReturnType<typeof reconcilePlan>|null;
  quotesPushed:number; quoteFailures:number; warnings:string[];
}
const call=<T>(fn:()=>Promise<T>):Promise<T>=>Promise.resolve().then(fn);
export function findBoundAccount(accounts:NativeAccount[],key:string,boundId?:string|null):NativeAccount|null{
  // 顺序：持久绑定 → provider 标识 → 确定性名称。用户改名后仍能靠前两者找回。
  if(boundId){const byId=accounts.find(a=>a.id===boundId);if(byId)return byId;}
  return accounts.find(a=>a.provider===NATIVE_PROVIDER&&a.providerAccountId===key)
    ?? accounts.find(a=>a.accountType==='CRYPTOCURRENCY'&&a.name===nativeAccountLabel(key))
    ?? null;
}
function accountMismatch(account:NativeAccount){return account.accountType!=='CRYPTOCURRENCY'||account.trackingMode!=='HOLDINGS';}

export class NativeSync {
  constructor(private host:NativeHostBridge){}
  private async boundId(accountKey:string){
    try{return await this.host.readBinding(accountKey);}catch{return null;}
  }
  // 宿主按日期查询只接受 3 位代码，USDT 会被拒绝；失败时回退到最新汇率列表。
  private async resolveRate(baseCurrency:string,date:string):Promise<RateResolution>{
    if(baseCurrency.trim().toUpperCase()===NATIVE_CURRENCY)return resolveUsdtRate({base:baseCurrency,date});
    let dated:{rate:number|null;error?:string|null}|null=null,datedError:unknown,records:RateRecord[]|null=null,listError:unknown;
    try{dated=await call(()=>this.host.rateForDate(NATIVE_CURRENCY,baseCurrency,date));}catch(error){datedError=error;}
    const quick=resolveUsdtRate({base:baseCurrency,date,dated,datedError});
    if(quick.rate!==null)return quick;
    try{records=await call(()=>this.host.listRates());}catch(error){listError=error;}
    return resolveUsdtRate({base:baseCurrency,date,dated,datedError,records,listError,now:new Date().toISOString()});
  }
  async probe(accountKey:string):Promise<NativeProbe>{
    try{
      const [accounts,baseCurrency]=await Promise.all([call(()=>this.host.listAccounts()),call(()=>this.host.baseCurrency())]);
      const date=this.host.today();
      const rateDiagnostic=await this.resolveRate(baseCurrency,date);
      const bound=findBoundAccount(accounts,accountKey,await this.boundId(accountKey));
      return {available:true,baseCurrency,usdtRate:rateDiagnostic.rate,rateDiagnostic,accountCount:accounts.length,bound,
        reasons:rateDiagnostic.rate===null?['NO_USDT_RATE']:[]};
    }catch{
      return {available:false,baseCurrency:'',usdtRate:null,rateDiagnostic:{rate:null,status:'api-unavailable',source:null},accountCount:0,bound:null,reasons:['HOST_UNAVAILABLE']};
    }
  }
  async preview(value:Valuation,accountKey:string,costs:CostBook,options:NativeOptions={}):Promise<NativePreview>{
    let accounts:NativeAccount[],baseCurrency:string;
    try{[accounts,baseCurrency]=await Promise.all([call(()=>this.host.listAccounts()),call(()=>this.host.baseCurrency())]);}
    catch{throw new NativeSyncError('HOST_UNAVAILABLE');}
    const date=this.host.today();
    const rateDiagnostic=await this.resolveRate(baseCurrency,date);
    const rate=rateDiagnostic.rate;
    const plan=buildNativePlan({state:value.state,report:value.report,accountKey,baseCurrency,date,costs});
    const bound=findBoundAccount(accounts,accountKey,await this.boundId(accountKey));
    let existingDates:string[]=[],symbols:NativeCheck['symbols']=[],validationErrors:string[]=[];
    if(bound){
      try{
        const check=await this.host.checkImport(bound.id,[{date,positions:plan.holdings.map(h=>({symbol:h.symbol,quantity:h.quantity,...(h.averageCost?{avgCost:h.averageCost}:{}),currency:h.currency,quoteCcy:h.quoteCcy,instrumentType:h.instrumentType})),cashBalances:plan.cashBalances}]);
        existingDates=check.existingDates;symbols=check.symbols;validationErrors=check.validationErrors;
      }catch{validationErrors.push('SYMBOL_PREFLIGHT_FAILED');}
    }
    const blocked:string[]=[];
    if(rate===null)blocked.push('NO_USDT_RATE');
    if(bound&&accountMismatch(bound))blocked.push('ACCOUNT_MISMATCH');
    if(plan.summary.costUnknownSymbols.length&&!options.allowUnknownCost)blocked.push('MISSING_COST');
    if(!plan.holdings.length&&!Object.keys(plan.cashBalances).length)blocked.push('EMPTY_PORTFOLIO');
    return {plan,bound,action:bound?'bind':'create',rate,rateDiagnostic,existingDates,symbols,validationErrors,blocked,warnings:plan.warnings,
      allowUnknownCost:!!options.allowUnknownCost,costUnknownSymbols:plan.summary.costUnknownSymbols};
  }
  // 写入必须显式确认，且预览指纹必须与当前持仓一致，避免用过期预览写账本。
  async apply(value:Valuation,accountKey:string,costs:CostBook,preview:NativePreview,confirmation:'WRITE'):Promise<NativeResult>{
    if(confirmation!=='WRITE')throw new NativeSyncError('NOT_CONFIRMED');
    if(preview.blocked.length)throw new NativeSyncError('BLOCKED',preview.blocked.join(','));
    const current=buildNativePlan({state:value.state,report:value.report,accountKey,baseCurrency:preview.plan.baseCurrency,date:preview.plan.date,costs});
    if(current.fingerprint!==preview.plan.fingerprint)throw new NativeSyncError('PREVIEW_STALE');
    const warnings:string[]=[];
    let account=preview.bound,created=false;
    if(account&&accountMismatch(account))throw new NativeSyncError('BLOCKED','ACCOUNT_MISMATCH');
    if(!account){
      try{account=await this.host.createAccount(current.account);created=true;}
      catch{throw new NativeSyncError('ACCOUNT_CREATE_FAILED');}
      if(!account?.id){warnings.push('账户已创建但未返回 id，已停止写入');throw new NativeSyncError('ACCOUNT_CREATE_FAILED');}
      try{await this.host.writeBinding(accountKey,account.id);}catch{warnings.push('账户绑定未持久化，下次可能按名称匹配');}
    }
    try{await this.host.saveSnapshot(account.id,current.holdings,current.cashBalances,current.date);}
    catch{throw new NativeSyncError('SNAPSHOT_SAVE_FAILED');}
    let rows:NativeSnapshotRow[]=[],actual:NativeActualRow[]=[],readback:'ok'|'failed'='ok';
    try{
      [rows,actual]=await Promise.all([call(()=>this.host.listSnapshots(account!.id,current.date,current.date)),call(()=>this.host.getByDate(account!.id,current.date))]);
    }catch{
      // 快照可能已经写入；不重试、不重建账户，交给本人核对。
      readback='failed';warnings.push('快照已提交，但读回失败；请到原生账户核对，不要重复写入。');
    }
    const reconcile=readback==='ok'?reconcilePlan(current,actual.map(r=>({symbol:r.symbol,quantity:r.quantity}))):null;
    if(reconcile&&!reconcile.ok)warnings.push('读回数量与预期不一致');
    const snap=rows.find(r=>r.snapshotDate===current.date);
    if(readback==='ok'&&!snap)warnings.push('读回未找到当日快照');
    // 报价：把资产切到 MANUAL 以停止宿主默认提供者（Yahoo）的自动同步，
    // 再用与成本备用报价相同的 id 写入市场价；成功时覆盖成本价，失败时明确部分完成。
    let quotesPushed=0,quoteFailures=0,quoteModeUpdated=0;
    if(readback==='ok'){
      const prices=new Map<string,{value:string;asOf:string}>();
      for(const s of Object.values(value.state.snapshots))for(const p of s.positions)if(p.price)prices.set(p.asset.code,{value:p.price.value,asOf:p.price.asOf});
      const datePart=current.date.replaceAll('-','');
      for(const row of actual){
        if(!row.assetId)continue;
        if(row.quoteMode!=='MANUAL'){
          try{await this.host.updateQuoteMode(row.assetId,'MANUAL');quoteModeUpdated++;}
          catch{quoteFailures++;}
        }
        const price=prices.get(row.symbol);
        if(!price)continue;
        let close:number;
        try{close=Number(nonnegative(price.value).toFixed(8));}catch{continue;}
        if(!Number.isFinite(close)||close<=0)continue;
        const timestamp=new Date(price.asOf).toISOString();
        try{
          await this.host.updateQuote(row.assetId,{id:`${datePart}_${row.assetId.toUpperCase()}`,createdAt:new Date().toISOString(),dataSource:'BINANCE',
            timestamp,assetId:row.assetId,open:close,high:close,low:close,volume:0,close,adjclose:close,currency:NATIVE_CURRENCY});
          quotesPushed++;
        }catch{quoteFailures++;}
      }
      if(quoteFailures)warnings.push(`${quoteFailures} 项报价或报价模式写入失败；原生页面可能暂时使用成本价或按 0 估值，请使用“仅修复报价”`);
    }
    const stage:NativeStage=readback==='failed'?'readback-failed':quoteFailures?'quotes-partial':'reconciled';
    return {accountId:account.id,created,snapshotDate:current.date,positionCount:snap?.positionCount??actual.length,
      cashCurrencyCount:snap?.cashCurrencyCount??Object.keys(current.cashBalances).length,readback,stage,quoteModeUpdated,reconcile,quotesPushed,quoteFailures,warnings};
  }
  // 只修报价与报价模式，不重写快照；用于快照已提交但报价失败的部分完成状态。
  async repairQuotes(value:Valuation,accountId:string,date:string):Promise<{pushed:number;failed:number;modeUpdated:number}>{
    let actual:NativeActualRow[];
    try{actual=await this.host.getByDate(accountId,date);}
    catch{throw new NativeSyncError('HOST_UNAVAILABLE');}
    const prices=new Map<string,{value:string;asOf:string}>();
    for(const s of Object.values(value.state.snapshots))for(const p of s.positions)if(p.price)prices.set(p.asset.code,{value:p.price.value,asOf:p.price.asOf});
    const datePart=date.replaceAll('-','');
    let pushed=0,failed=0,modeUpdated=0;
    for(const row of actual){
      if(!row.assetId)continue;
      if(row.quoteMode!=='MANUAL'){
        try{await this.host.updateQuoteMode(row.assetId,'MANUAL');modeUpdated++;}
        catch{failed++;}
      }
      const price=prices.get(row.symbol);
      if(!price)continue;
      let close:number;
      try{close=Number(nonnegative(price.value).toFixed(8));}catch{failed++;continue;}
      if(!Number.isFinite(close)||close<=0){failed++;continue;}
      try{
        await this.host.updateQuote(row.assetId,{id:`${datePart}_${row.assetId.toUpperCase()}`,createdAt:new Date().toISOString(),dataSource:'BINANCE',
          timestamp:new Date(price.asOf).toISOString(),assetId:row.assetId,open:close,high:close,low:close,volume:0,close,adjclose:close,currency:NATIVE_CURRENCY});
        pushed++;
      }catch{failed++;}
    }
    return {pushed,failed,modeUpdated};
  }
}

export function createHostBridge(api:AddonContext['api']):NativeHostBridge{
  const today=()=>{const d=new Date(),p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;};
  const bindingKey=(key:string)=>`native-account-${key}`;
  const COST_KEY='native-costs-v1';
  return {
    listAccounts:async()=>(await api.accounts.getAll()).map(a=>({id:a.id,name:a.name,accountType:a.accountType,currency:a.currency,trackingMode:a.trackingMode,provider:a.provider,providerAccountId:a.providerAccountId})),
    createAccount:async input=>{const a=await api.accounts.create(input);return {id:a.id,name:a.name,accountType:a.accountType,currency:a.currency,trackingMode:a.trackingMode,provider:a.provider,providerAccountId:a.providerAccountId};},
    checkImport:async(accountId,snapshots)=>{const r=await api.snapshots.checkImport(accountId,snapshots);return {existingDates:r.existingDates,symbols:r.symbols.map(s=>({symbol:s.symbol,found:s.found,assetId:s.assetId,currency:s.currency})),validationErrors:r.validationErrors};},
    saveSnapshot:(accountId,holdings,cashBalances,date)=>api.snapshots.save(accountId,holdings,cashBalances,date),
    listSnapshots:async(accountId,from,to)=>(await api.snapshots.getAll(accountId,from,to)).map(s=>({snapshotDate:s.snapshotDate,positionCount:s.positionCount,cashCurrencyCount:s.cashCurrencyCount})),
    getByDate:async(accountId,date)=>(await api.snapshots.getByDate(accountId,date)).map(h=>({symbol:h.instrument?.symbol??'',quantity:h.quantity,assetId:h.instrument?.id,quoteMode:h.instrument?.quoteMode})),
    updateQuote:(assetId,quote)=>api.quotes.update(assetId,quote),
    updateQuoteMode:async(assetId,mode)=>{await api.assets.updateQuoteMode(assetId,mode);},
    readCosts:async()=>{
      try{
        const raw=await api.storage.get(COST_KEY);
        if(!raw)return {};
        const parsed=JSON.parse(raw) as Record<string,{unitCost?:unknown;source?:unknown;updatedAt?:unknown}>;
        const out:Record<string,{unitCost:string;source?:string;updatedAt?:string}>={};
        for(const [code,entry] of Object.entries(parsed)){
          if(typeof entry?.unitCost!=='string'||!/^[A-Z0-9]{1,20}$/.test(code))continue;
          out[code]={unitCost:entry.unitCost,...(typeof entry.source==='string'?{source:entry.source}:{}),...(typeof entry.updatedAt==='string'?{updatedAt:entry.updatedAt}:{})};
        }
        return out;
      }catch{return {};}
    },
    writeCosts:async book=>{await api.storage.set(COST_KEY,JSON.stringify(book));},
    baseCurrency:async()=>(await api.settings.get()).baseCurrency,
    rateForDate:async(from,to,date)=>{const [row]=await api.exchangeRates.getRatesForDates([{fromCurrency:from,toCurrency:to,date}]);return {rate:row?.rate??null,error:row?.error??null};},
    listRates:async()=>(await api.exchangeRates.getAll()).map(r=>({fromCurrency:r.fromCurrency,toCurrency:r.toCurrency,rate:r.rate,source:r.source,timestamp:r.timestamp})),
    today,
    readBinding:async key=>{try{return await api.storage.get(bindingKey(key));}catch{return null;}},
    writeBinding:async(key,accountId)=>{await api.storage.set(bindingKey(key),accountId);}
  };
}
