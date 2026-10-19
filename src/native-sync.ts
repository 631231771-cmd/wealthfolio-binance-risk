import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js';
import {assetKey, nonnegative, positionKey, type PortfolioState} from './domain';
import type {calculateRisk} from './domain';
import type {CostBook} from './cost-basis';
export type {CostBook} from './cost-basis';

// 原生账户身份与映射。纯函数，不接触 SDK，便于用合成数据验证。
export const NATIVE_PROVIDER='binance-spot';
export const NATIVE_CURRENCY='USDT';
export const CRYPTO_INSTRUMENT='CRYPTO';
// Binance 现货资产代码的实际范围；不满足的代码不猜映射。
const NATIVE_SYMBOL=/^[A-Z0-9]{1,20}$/;
// 微额只按可靠市值判断：没有有效报价的资产不自动归入微额，恰好 0.1 也不算。
export const DUST_THRESHOLD='0.1';
export const isDustValue=(value:string|undefined)=>value!==undefined&&nonnegative(value).lt(DUST_THRESHOLD);

export interface NativeHoldingInput {
  symbol:string;
  quantity:string;
  currency:string;
  quoteCcy:string;
  instrumentType:string;
  averageCost?:string;
  name?:string;
}
export interface NativeAccountInput {
  name:string;
  accountType:'CRYPTOCURRENCY';
  currency:string;
  trackingMode:'HOLDINGS';
  isDefault:boolean;
  isActive:boolean;
  provider:string;
  providerAccountId:string;
}
export interface NativeWarning {
  code:'UNSUPPORTED_SYMBOL'|'NO_PRICE'|'NO_COST'|'ZERO_SKIPPED'|'USDT_AS_CASH';
  symbol?:string;
  detail:string;
}
export interface NativePlan {
  accountKey:string;
  label:string;
  currency:string;
  baseCurrency:string;
  date:string;
  account:NativeAccountInput;
  holdings:NativeHoldingInput[];
  cashBalances:Record<string,string>;
  warnings:NativeWarning[];
  excluded:{symbol:string;quantity:string;value:string}[];
  summary:{positions:number;priced:number;unpriced:number;costKnown:number;costUnknown:number;costUnknownSymbols:string[];valued:string|null;cash:string;excludedCount:number;excludedValue:string;originalValue:string|null;importValue:string|null;difference:string};
  fingerprint:string;
}

// UID 不进原生账本：只保存不可逆的短哈希，用于账户绑定与去重。
export function nativeAccountKey(uid:string, provider=NATIVE_PROVIDER):string{
  if(!/^\d{1,20}$/.test(uid))throw new Error('UID_INVALID');
  return bytesToHex(sha256(utf8ToBytes(`${provider}:${uid}`))).slice(0,16);
}
export function nativeAccountLabel(key:string):string{
  if(!/^[0-9a-f]{6,}$/.test(key))throw new Error('ACCOUNT_KEY_INVALID');
  return `Binance Spot · ${key.slice(0,6)}`;
}
export function nativeAccountInput(key:string):NativeAccountInput{
  return {name:nativeAccountLabel(key),accountType:'CRYPTOCURRENCY',currency:NATIVE_CURRENCY,trackingMode:'HOLDINGS',
    isDefault:false,isActive:true,provider:NATIVE_PROVIDER,providerAccountId:key};
}
function canonical(value:unknown):string{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  const entries=Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b));
  return '{'+entries.map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
}
// 指纹只覆盖真正会写入账本的内容：账户、日期、持仓数量、成本与现金。
// 报价每分钟变化，不能让它把预览变成过期；报价由写入后的独立步骤推送。
export function planFingerprint(plan:Omit<NativePlan,'fingerprint'>):string{
  const writeSet={accountKey:plan.accountKey,date:plan.date,baseCurrency:plan.baseCurrency,
    holdings:plan.holdings.map(h=>[h.symbol,h.quantity,h.currency,h.quoteCcy,h.instrumentType,h.averageCost??null]).sort(),
    cashBalances:plan.cashBalances};
  return bytesToHex(sha256(utf8ToBytes(canonical(writeSet)))).slice(0,32);
}

// 只把能够确定的资产映射为原生持仓；USDT 作为账户现金，而不是一只需要报价的币。
// excludeDust 时，可靠市值 < 0.1 USDT 的持仓不写入快照，也不要求成本。
export function buildNativePlan(args:{state:PortfolioState;report:ReturnType<typeof calculateRisk>;accountKey:string;baseCurrency:string;date:string;costs?:CostBook;excludeDust?:boolean}):NativePlan{
  const {state,report,accountKey,baseCurrency,date,costs={},excludeDust=false}=args;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('DATE_INVALID');
  const holdings:NativeHoldingInput[]=[],warnings:NativeWarning[]=[],cashBalances:Record<string,string>={},excluded:{symbol:string;quantity:string;value:string}[]=[];
  let priced=0,unpriced=0,costKnown=0,costUnknown=0;
  const seen=new Set<string>();
  for(const snapshot of Object.values(state.snapshots)){
    for(const position of snapshot.positions){
      const code=position.asset.code;
      if(seen.has(code)){warnings.push({code:'UNSUPPORTED_SYMBOL',symbol:code,detail:'同一资产出现多次，已跳过重复行'});continue;}
      seen.add(code);
      const quantity=nonnegative(position.quantity);
      if(quantity.isZero()){warnings.push({code:'ZERO_SKIPPED',symbol:code,detail:'零数量不写入原生快照'});continue;}
      if(code===NATIVE_CURRENCY){cashBalances[code]=quantity.toFixed();warnings.push({code:'USDT_AS_CASH',symbol:code,detail:'USDT 作为账户现金，不作为需要报价的持仓'});continue;}
      if(!NATIVE_SYMBOL.test(code)){warnings.push({code:'UNSUPPORTED_SYMBOL',symbol:code,detail:'资产代码不符合 Binance 现货符号范围，未映射'});continue;}
      const eligible=report.eligiblePositionKeys.includes(positionKey(snapshot.accountId,position.asset));
      const value=eligible?report.assetValues[assetKey(position.asset)]:undefined;
      // 只有“可靠市值且低于阈值”才算微额；缺价资产不属于微额，继续按正常资产处理。
      if(excludeDust&&isDustValue(value)){
        excluded.push({symbol:code,quantity:quantity.toFixed(),value:value!});
        continue;
      }
      const price=position.price;
      if(price)priced++;else{unpriced++;warnings.push({code:'NO_PRICE',symbol:code,detail:'当前没有有效报价，原生持仓仍写入数量，估值由宿主决定'});}
      const cost=costs[code]?.unitCost;
      let averageCost:string|undefined;
      if(cost!==undefined){
        try{const unit=nonnegative(cost);if(unit.isZero())throw new Error();averageCost=unit.toFixed();costKnown++;}
        catch{warnings.push({code:'NO_COST',symbol:code,detail:'成本值无效，未写入 averageCost'});costUnknown++;}
      }else costUnknown++;
      holdings.push({symbol:code,quantity:quantity.toFixed(),currency:NATIVE_CURRENCY,quoteCcy:NATIVE_CURRENCY,
        instrumentType:CRYPTO_INSTRUMENT,name:code,...(averageCost?{averageCost}:{})});
    }
  }
  holdings.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  excluded.sort((a,b)=>a.symbol.localeCompare(b.symbol));
  const excludedValue=excluded.reduce((sum,row)=>sum.add(row.value),nonnegative('0'));
  const originalValue=report.coveredSubtotal;
  const importValue=originalValue===null?null:nonnegative(originalValue).sub(excludedValue).toFixed(8);
  const base:Omit<NativePlan,'fingerprint'>={accountKey,label:nativeAccountLabel(accountKey),currency:NATIVE_CURRENCY,baseCurrency,date,
    account:nativeAccountInput(accountKey),holdings,cashBalances,warnings,excluded,
    summary:{positions:holdings.length,priced,unpriced,costKnown,costUnknown,costUnknownSymbols:holdings.filter(h=>!h.averageCost).map(h=>h.symbol),valued:report.coveredSubtotal,cash:cashBalances[NATIVE_CURRENCY]??'0',
      excludedCount:excluded.length,excludedValue:excludedValue.toFixed(8),originalValue,importValue,difference:excludedValue.toFixed(8)}};
  return {...base,fingerprint:planFingerprint(base)};
}

export interface NativeActualHolding {symbol:string;quantity:number}
// 宿主 Holding.quantity 是浮点数；按相对容差比较，避免把浮点表示差异当成失败。
export function reconcilePlan(plan:NativePlan,actual:NativeActualHolding[]){
  const expected=new Map(plan.holdings.map(h=>[h.symbol,h.quantity]));
  const seen=new Set<string>(),mismatched:{symbol:string;expected:string;actual:number}[]=[];
  let matched=0;
  for(const row of actual){
    if(!expected.has(row.symbol)){continue;}
    seen.add(row.symbol);
    const want=Number(expected.get(row.symbol));
    if(Math.abs(want-row.quantity)<=Math.max(1e-12,Math.abs(want)*1e-12))matched++;
    else mismatched.push({symbol:row.symbol,expected:expected.get(row.symbol)!,actual:row.quantity});
  }
  const missing=[...expected.keys()].filter(symbol=>!seen.has(symbol));
  const extra=actual.map(r=>r.symbol).filter(symbol=>!expected.has(symbol));
  return {ok:mismatched.length===0&&missing.length===0,matched,mismatched,missing,extra};
}

// 汇率解析：宿主按日期查询只接受 3 位 ISO 代码，USDT 会被 InvalidCurrencyCode 拒绝。
// 因此先试日期接口，再回退到 exchangeRates.getAll() 的最新记录；绝不默认 1。
export interface RateRecord {fromCurrency:string;toCurrency:string;rate:number|string;source?:string;timestamp?:string}
export type RateStatus='valid'|'stale'|'no-record'|'unparseable'|'api-unavailable'|'permission-denied';
export interface RateResolution {
  rate:number|null;
  status:RateStatus;
  source:'same'|'dated'|'latest'|'inverse'|null;
  asOf?:string;
}
const STALE_DAYS=7;
function positiveRate(value:number|string|undefined|null):number|null{
  if(value===undefined||value===null)return null;
  const n=typeof value==='number'?value:Number(value);
  return Number.isFinite(n)&&n>0?n:null;
}
export function classifyRateError(error:unknown):'permission-denied'|'api-unavailable'{
  const message=error instanceof Error?error.message:String((error as {message?:unknown})?.message??error??'');
  return /permission|denied|not allowed|unauthorized|forbidden|eacces/i.test(message)?'permission-denied':'api-unavailable';
}
export function resolveUsdtRate(args:{
  base:string;
  date:string;
  dated?:{rate:number|null;error?:string|null}|null;
  datedError?:unknown;
  records?:RateRecord[]|null;
  listError?:unknown;
  now?:string;
}):RateResolution{
  const base=args.base.trim().toUpperCase();
  if(base==='USDT')return {rate:1,status:'valid',source:'same'};
  const dated=positiveRate(args.dated?.rate??null);
  if(dated!==null)return {rate:dated,status:'valid',source:'dated',asOf:args.date};
  const records=args.records??[];
  const direct=records.find(r=>r.fromCurrency?.trim().toUpperCase()==='USDT'&&r.toCurrency?.trim().toUpperCase()===base);
  const inverse=records.find(r=>r.fromCurrency?.trim().toUpperCase()===base&&r.toCurrency?.trim().toUpperCase()==='USDT');
  const pick=direct??inverse;
  if(pick){
    const raw=positiveRate(pick.rate);
    if(raw===null)return {rate:null,status:'unparseable',source:null,asOf:pick.timestamp};
    const rate=direct?raw:1/raw;
    const asOf=pick.timestamp;
    const age=asOf?Date.parse(args.now??new Date().toISOString())-Date.parse(asOf):NaN;
    const stale=Number.isFinite(age)&&age>STALE_DAYS*86_400_000;
    return {rate,status:stale?'stale':'valid',source:direct?'latest':'inverse',...(asOf?{asOf}:{})};
  }
  if(args.listError!==undefined&&args.listError!==null)return {rate:null,status:classifyRateError(args.listError),source:null};
  if(args.datedError!==undefined&&args.datedError!==null)return {rate:null,status:classifyRateError(args.datedError),source:null};
  return {rate:null,status:'no-record',source:null};
}
