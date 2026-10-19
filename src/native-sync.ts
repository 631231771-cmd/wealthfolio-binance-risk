import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex, utf8ToBytes} from '@noble/hashes/utils.js';
import {nonnegative, type PortfolioState} from './domain';
import type {calculateRisk} from './domain';

// 原生账户身份与映射。纯函数，不接触 SDK，便于用合成数据验证。
export const NATIVE_PROVIDER='binance-spot';
export const NATIVE_CURRENCY='USDT';
export const CRYPTO_INSTRUMENT='CRYPTO';
// Binance 现货资产代码的实际范围；不满足的代码不猜映射。
const NATIVE_SYMBOL=/^[A-Z0-9]{1,20}$/;

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
  summary:{positions:number;priced:number;unpriced:number;costKnown:number;costUnknown:number;valued:string|null;cash:string};
  fingerprint:string;
}
export type CostBook=Readonly<Record<string,{unitCost:string}>>;

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
export function buildNativePlan(args:{state:PortfolioState;report:ReturnType<typeof calculateRisk>;accountKey:string;baseCurrency:string;date:string;costs?:CostBook}):NativePlan{
  const {state,report,accountKey,baseCurrency,date,costs={}}=args;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('DATE_INVALID');
  const holdings:NativeHoldingInput[]=[],warnings:NativeWarning[]=[],cashBalances:Record<string,string>={};
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
  const base:Omit<NativePlan,'fingerprint'>={accountKey,label:nativeAccountLabel(accountKey),currency:NATIVE_CURRENCY,baseCurrency,date,
    account:nativeAccountInput(accountKey),holdings,cashBalances,warnings,
    summary:{positions:holdings.length,priced,unpriced,costKnown,costUnknown,valued:report.coveredSubtotal,cash:cashBalances[NATIVE_CURRENCY]??'0'}};
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
