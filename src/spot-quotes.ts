import type { NetworkRequest } from '@wealthfolio/addon-sdk';
import { nonnegative, type Price } from './domain';

const symbolCode=(value:unknown):value is string=>typeof value==='string' && /^[A-Z0-9]{1,40}$/.test(value);
// 资产身份不是交易对 symbol：保留合法 UTF-8 原样，但拒绝不可见/控制字符和过长输入。
export const validSpotAssetCode=(value:unknown):value is string=>typeof value==='string' && value.length>0 && new TextEncoder().encode(value).length<=80 && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
export function candidateUsdtSymbol(asset:string):string|null {
  if(!validSpotAssetCode(asset)||!symbolCode(asset)||asset==='USDT'||asset.length+4>40)return null;
  return `${asset}USDT`;
}
const invalid=()=>new Error('公开行情响应或资产映射无效');

// 只采用明确的 baseAsset/quoteAsset，不截 ticker 后缀推断资产。
// 映射不证明资产法律类型；未知资产仍为 unknown，不作为真实 Stocks 账户。
export function parseUsdtMarkets(data:unknown, expectedAssets?:string[]):Map<string,string> {
  const rows=(data as {symbols?:unknown})?.symbols;
  if(!Array.isArray(rows) || rows.length>1000 || expectedAssets && (expectedAssets.length>100 || expectedAssets.some(asset=>!validSpotAssetCode(asset))))throw invalid();
  const candidates=expectedAssets?new Map(expectedAssets.flatMap(asset=>{const symbol=candidateUsdtSymbol(asset);return symbol?[[symbol,asset] as const]:[]})):undefined;
  const markets=new Map<string,string>(), seen=new Set<string>(), ambiguous=new Set<string>();
  for(const row of rows) {
    if(!row || !symbolCode(row.symbol) || !validSpotAssetCode(row.baseAsset) || !symbolCode(row.quoteAsset) || typeof row.status!=='string' || typeof row.isSpotTradingAllowed!=='boolean' || seen.has(row.symbol))throw invalid();
    seen.add(row.symbol);
    if(row.quoteAsset!=='USDT' || row.baseAsset==='USDT' || row.status!=='TRADING' || !row.isSpotTradingAllowed || candidates && candidates.get(row.symbol)!==row.baseAsset)continue;
    if(markets.has(row.baseAsset)) {markets.delete(row.baseAsset);ambiguous.add(row.baseAsset);}
    if(!ambiguous.has(row.baseAsset))markets.set(row.baseAsset,row.symbol);
  }
  return markets;
}

// 构造公开 GET，不发送。限于本次所需 symbols，不能退化成获取所有 ticker。
export function publicTickerRequest(symbols:string[]):NetworkRequest {
  if(!symbols.length || symbols.length>100 || symbols.some(s=>!symbolCode(s)) || new Set(symbols).size!==symbols.length)throw invalid();
  const params=new URLSearchParams(symbols.length===1?{symbol:symbols[0],symbolStatus:'TRADING'}:{symbols:JSON.stringify(symbols),symbolStatus:'TRADING'});
  return {method:'GET',url:`https://api.binance.com/api/v3/ticker/price?${params}`};
}

export function publicExchangeInfoRequest(symbols:string[]):NetworkRequest {
  if(!symbols.length || symbols.length>100 || symbols.some(s=>!symbolCode(s)) || new Set(symbols).size!==symbols.length)throw invalid();
  return {method:'GET',url:`https://api.binance.com/api/v3/exchangeInfo?${new URLSearchParams({symbols:JSON.stringify(symbols),showPermissionSets:'false'})}`};
}

// ticker 无行情生成时间：receivedAt 是采集时间，不伪装成交易所成交时间。
// 缺失请求的 symbol 保留为缺价，额外/重复/错误值拒绝整个报价响应。
export function parseTickerPrices(data:unknown, expected:string[], receivedAt:string, mode:'fixture'|'external'):Map<string,Price> {
  if(!Number.isFinite(Date.parse(receivedAt)) || !['fixture','external'].includes(mode) || !expected.length || expected.length>100 || expected.some(s=>!symbolCode(s)) || new Set(expected).size!==expected.length)throw invalid();
  const rows=Array.isArray(data)?data:[data];
  if(rows.length>expected.length)throw invalid();
  const prices=new Map<string,Price>();
  for(const row of rows) {
    if(!row || !symbolCode(row.symbol) || !expected.includes(row.symbol) || prices.has(row.symbol) || typeof row.price!=='string' || row.price.length>80)throw invalid();
    let value:string;
    try {const number=nonnegative(row.price);if(number.isZero())throw invalid();value=number.toFixed();}catch{throw invalid();}
    prices.set(row.symbol,{value,currency:'USDT',asOf:receivedAt,source:`${mode}:ticker/price（采集时间，非成交时间）`});
  }
  return prices;
}

// 批量报价中只隔离异常 symbol；重复 symbol 全部作废，其他已验证报价继续可用。
export function parseTickerPricesPartial(data:unknown, expected:string[], receivedAt:string):Map<string,Price> {
  if(!Number.isFinite(Date.parse(receivedAt)) || !expected.length || expected.length>100 || expected.some(s=>!symbolCode(s)) || new Set(expected).size!==expected.length)throw invalid();
  const rows=Array.isArray(data)?data:[data];
  if(rows.length>expected.length)throw invalid();
  const prices=new Map<string,Price>(), seen=new Set<string>();
  for(const row of rows) {
    if(!row || !symbolCode(row.symbol) || !expected.includes(row.symbol))continue;
    // 重复身份本身就是歧义，即使其中一行价格无效也不能保留另一行。
    if(seen.has(row.symbol)){prices.delete(row.symbol);continue;}
    seen.add(row.symbol);
    if(typeof row.price!=='string' || row.price.length>80)continue;
    try {const number=nonnegative(row.price);if(number.isZero())continue;prices.set(row.symbol,{value:number.toFixed(),currency:'USDT',asOf:receivedAt,source:'external:ticker/price（采集时间，非成交时间）'});}catch{/* 该币缺价；不污染同批其他报价 */}
  }
  return prices;
}
