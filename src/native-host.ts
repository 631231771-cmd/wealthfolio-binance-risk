import type {AddonContext} from '@wealthfolio/addon-sdk';
import {nonnegative, type PortfolioState} from './domain';
import type {calculateRisk} from './domain';
import {buildNativePlan, type CostBook, type NativeAccountInput, type NativeHoldingInput, type NativePlan, type NativeWarning, reconcilePlan, NATIVE_PROVIDER, NATIVE_CURRENCY, nativeAccountLabel} from './native-sync';
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
  baseCurrency():Promise<string>;
  usdtRate(to:string,date:string):Promise<number|null>;
  today():string;
}
export type NativeErrorCode='NOT_CONFIRMED'|'PREVIEW_STALE'|'BLOCKED'|'HOST_UNAVAILABLE'|'ACCOUNT_CREATE_FAILED'|'SNAPSHOT_SAVE_FAILED'|'READBACK_FAILED'|'UID_INVALID';
export class NativeSyncError extends Error {
  constructor(readonly code:NativeErrorCode,readonly detail?:string){super(code);}
}
export interface NativeProbe {
  available:boolean; baseCurrency:string; usdtRate:number|null; accountCount:number;
  bound:NativeAccount|null; reasons:string[];
}
export interface NativePreview {
  plan:NativePlan; bound:NativeAccount|null; action:'create'|'bind'; rate:number|null;
  existingDates:string[]; symbols:NativeCheck['symbols']; validationErrors:string[];
  blocked:string[]; warnings:NativeWarning[];
}
export interface NativeResult {
  accountId:string; created:boolean; snapshotDate:string;
  positionCount:number; cashCurrencyCount:number;
  reconcile:ReturnType<typeof reconcilePlan>;
  quotesPushed:number; quoteFailures:number; warnings:string[];
}
const call=<T>(fn:()=>Promise<T>):Promise<T>=>Promise.resolve().then(fn);
export function findBoundAccount(accounts:NativeAccount[],key:string):NativeAccount|null{
  return accounts.find(a=>a.provider===NATIVE_PROVIDER&&a.providerAccountId===key)
    ?? accounts.find(a=>a.accountType==='CRYPTOCURRENCY'&&a.name===nativeAccountLabel(key))
    ?? null;
}

export class NativeSync {
  constructor(private host:NativeHostBridge){}
  async probe(accountKey:string):Promise<NativeProbe>{
    try{
      const [accounts,baseCurrency]=await Promise.all([call(()=>this.host.listAccounts()),call(()=>this.host.baseCurrency())]);
      const date=this.host.today();
      const usdtRate=baseCurrency===NATIVE_CURRENCY?1:await this.host.usdtRate(baseCurrency,date);
      const bound=findBoundAccount(accounts,accountKey);
      return {available:true,baseCurrency,usdtRate,accountCount:accounts.length,bound,
        reasons:baseCurrency!==NATIVE_CURRENCY&&usdtRate===null?['NO_USDT_RATE']:[]};
    }catch(error){
      return {available:false,baseCurrency:'',usdtRate:null,accountCount:0,bound:null,reasons:['HOST_UNAVAILABLE']};
    }
  }
  async preview(value:Valuation,accountKey:string,costs:CostBook):Promise<NativePreview>{
    let accounts:NativeAccount[],baseCurrency:string;
    try{[accounts,baseCurrency]=await Promise.all([call(()=>this.host.listAccounts()),call(()=>this.host.baseCurrency())]);}
    catch{throw new NativeSyncError('HOST_UNAVAILABLE');}
    const date=this.host.today();
    const rate=baseCurrency===NATIVE_CURRENCY?1:await this.host.usdtRate(baseCurrency,date);
    const plan=buildNativePlan({state:value.state,report:value.report,accountKey,baseCurrency,date,costs});
    const bound=findBoundAccount(accounts,accountKey);
    let existingDates:string[]=[],symbols:NativeCheck['symbols']=[],validationErrors:string[]=[];
    if(bound){
      try{
        const check=await this.host.checkImport(bound.id,[{date,positions:plan.holdings.map(h=>({symbol:h.symbol,quantity:h.quantity,...(h.averageCost?{avgCost:h.averageCost}:{}),currency:h.currency,quoteCcy:h.quoteCcy,instrumentType:h.instrumentType})),cashBalances:plan.cashBalances}]);
        existingDates=check.existingDates;symbols=check.symbols;validationErrors=check.validationErrors;
      }catch{validationErrors.push('SYMBOL_PREFLIGHT_FAILED');}
    }
    const blocked:string[]=[];
    if(baseCurrency!==NATIVE_CURRENCY&&rate===null)blocked.push('NO_USDT_RATE');
    if(!plan.holdings.length&&!Object.keys(plan.cashBalances).length)blocked.push('EMPTY_PORTFOLIO');
    return {plan,bound,action:bound?'bind':'create',rate,existingDates,symbols,validationErrors,blocked,warnings:plan.warnings};
  }
  // 写入必须显式确认，且预览指纹必须与当前持仓一致，避免用过期预览写账本。
  async apply(value:Valuation,accountKey:string,costs:CostBook,preview:NativePreview,confirmation:'WRITE'):Promise<NativeResult>{
    if(confirmation!=='WRITE')throw new NativeSyncError('NOT_CONFIRMED');
    if(preview.blocked.length)throw new NativeSyncError('BLOCKED',preview.blocked.join(','));
    const current=buildNativePlan({state:value.state,report:value.report,accountKey,baseCurrency:preview.plan.baseCurrency,date:preview.plan.date,costs});
    if(current.fingerprint!==preview.plan.fingerprint)throw new NativeSyncError('PREVIEW_STALE');
    const warnings:string[]=[];
    let account=preview.bound,created=false;
    if(!account){
      try{account=await this.host.createAccount(current.account);created=true;}
      catch{throw new NativeSyncError('ACCOUNT_CREATE_FAILED');}
      if(!account?.id){warnings.push('账户已创建但未返回 id，已停止写入');throw new NativeSyncError('ACCOUNT_CREATE_FAILED');}
    }
    try{await this.host.saveSnapshot(account.id,current.holdings,current.cashBalances,current.date);}
    catch{throw new NativeSyncError('SNAPSHOT_SAVE_FAILED');}
    let rows:NativeSnapshotRow[]=[],actual:NativeActualRow[]=[];
    try{
      [rows,actual]=await Promise.all([call(()=>this.host.listSnapshots(account.id,current.date,current.date)),call(()=>this.host.getByDate(account.id,current.date))]);
    }catch{throw new NativeSyncError('READBACK_FAILED');}
    const reconcile=reconcilePlan(current,actual.map(r=>({symbol:r.symbol,quantity:r.quantity})));
    if(!reconcile.ok)warnings.push('读回数量与预期不一致');
    const snap=rows.find(r=>r.snapshotDate===current.date);
    if(!snap)warnings.push('读回未找到当日快照');
    // 报价是尽力而为：只写非 MANUAL 资产，失败不回滚已写入的持仓。
    let quotesPushed=0,quoteFailures=0;
    const prices=new Map<string,{value:string;asOf:string}>();
    for(const s of Object.values(value.state.snapshots))for(const p of s.positions)if(p.price)prices.set(p.asset.code,{value:p.price.value,asOf:p.price.asOf});
    for(const row of actual){
      const price=prices.get(row.symbol);
      if(!row.assetId||!price||row.quoteMode==='MANUAL')continue;
      let close:number;
      try{close=Number(nonnegative(price.value).toFixed(8));}catch{continue;}
      if(!Number.isFinite(close)||close<=0)continue;
      const timestamp=new Date(price.asOf).toISOString();
      try{
        await this.host.updateQuote(row.assetId,{id:`${row.assetId}_${current.date}_BINANCE`,createdAt:new Date().toISOString(),dataSource:'BINANCE',
          timestamp,assetId:row.assetId,open:close,high:close,low:close,volume:0,close,adjclose:close,currency:NATIVE_CURRENCY});
        quotesPushed++;
      }catch{quoteFailures++;}
    }
    if(quoteFailures)warnings.push(`${quoteFailures} 项报价写入失败，持仓已保留`);
    return {accountId:account.id,created,snapshotDate:current.date,positionCount:snap?.positionCount??actual.length,
      cashCurrencyCount:snap?.cashCurrencyCount??Object.keys(current.cashBalances).length,reconcile,quotesPushed,quoteFailures,warnings};
  }
}

export function createHostBridge(api:AddonContext['api']):NativeHostBridge{
  const today=()=>{const d=new Date(),p=(n:number)=>String(n).padStart(2,'0');return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;};
  return {
    listAccounts:async()=>(await api.accounts.getAll()).map(a=>({id:a.id,name:a.name,accountType:a.accountType,currency:a.currency,trackingMode:a.trackingMode,provider:a.provider,providerAccountId:a.providerAccountId})),
    createAccount:async input=>{const a=await api.accounts.create(input);return {id:a.id,name:a.name,accountType:a.accountType,currency:a.currency,trackingMode:a.trackingMode,provider:a.provider,providerAccountId:a.providerAccountId};},
    checkImport:async(accountId,snapshots)=>{const r=await api.snapshots.checkImport(accountId,snapshots);return {existingDates:r.existingDates,symbols:r.symbols.map(s=>({symbol:s.symbol,found:s.found,assetId:s.assetId,currency:s.currency})),validationErrors:r.validationErrors};},
    saveSnapshot:(accountId,holdings,cashBalances,date)=>api.snapshots.save(accountId,holdings,cashBalances,date),
    listSnapshots:async(accountId,from,to)=>(await api.snapshots.getAll(accountId,from,to)).map(s=>({snapshotDate:s.snapshotDate,positionCount:s.positionCount,cashCurrencyCount:s.cashCurrencyCount})),
    getByDate:async(accountId,date)=>(await api.snapshots.getByDate(accountId,date)).map(h=>({symbol:h.instrument?.symbol??'',quantity:h.quantity,assetId:h.instrument?.id,quoteMode:h.instrument?.quoteMode})),
    updateQuote:(assetId,quote)=>api.quotes.update(assetId,quote),
    baseCurrency:async()=>(await api.settings.get()).baseCurrency,
    usdtRate:async(to,date)=>{const [row]=await api.exchangeRates.getRatesForDates([{fromCurrency:NATIVE_CURRENCY,toCurrency:to,date}]);return row?.rate??null;},
    today
  };
}
