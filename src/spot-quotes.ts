import type { NetworkRequest } from '@wealthfolio/addon-sdk';
import { nonnegative, type Price } from './domain';

const code=(value:unknown):value is string=>typeof value==='string' && /^[A-Z0-9]{1,40}$/.test(value);
const invalid=()=>new Error('公开行情响应或资产映射无效');

// 只采用明确的 baseAsset/quoteAsset，不截 ticker 后缀推断资产。
// 映射不证明资产法律类型；未知资产仍为 unknown，不作为真实 Stocks 账户。
export function parseUsdtMarkets(data:unknown):Map<string,string> {
  const rows=(data as {symbols?:unknown})?.symbols;
  if(!Array.isArray(rows) || rows.length>20_000)throw invalid();
  const markets=new Map<string,string>(), seen=new Set<string>(), ambiguous=new Set<string>();
  for(const row of rows) {
    if(!row || !code(row.symbol) || !code(row.baseAsset) || !code(row.quoteAsset) || typeof row.status!=='string' || typeof row.isSpotTradingAllowed!=='boolean' || seen.has(row.symbol))throw invalid();
    seen.add(row.symbol);
    if(row.quoteAsset!=='USDT' || row.baseAsset==='USDT' || row.status!=='TRADING' || !row.isSpotTradingAllowed)continue;
    if(markets.has(row.baseAsset)) {markets.delete(row.baseAsset);ambiguous.add(row.baseAsset);}
    if(!ambiguous.has(row.baseAsset))markets.set(row.baseAsset,row.symbol);
  }
  return markets;
}

// 构造公开 GET，不发送。限于本次所需 symbols，不能退化成获取所有 ticker。
export function publicTickerRequest(symbols:string[]):NetworkRequest {
  if(!symbols.length || symbols.length>100 || symbols.some(s=>!code(s)) || new Set(symbols).size!==symbols.length)throw invalid();
  const params=new URLSearchParams(symbols.length===1?{symbol:symbols[0]}:{symbols:JSON.stringify(symbols)});
  return {method:'GET',url:`https://api.binance.com/api/v3/ticker/price?${params}`};
}

// ticker 无行情生成时间：receivedAt 是采集时间，不伪装成交易所成交时间。
// 缺失请求的 symbol 保留为缺价，额外/重复/错误值拒绝整个报价响应。
export function parseTickerPrices(data:unknown, expected:string[], receivedAt:string, mode:'fixture'|'external'):Map<string,Price> {
  if(!Number.isFinite(Date.parse(receivedAt)) || !['fixture','external'].includes(mode) || !expected.length || expected.length>100 || expected.some(s=>!code(s)) || new Set(expected).size!==expected.length)throw invalid();
  const rows=Array.isArray(data)?data:[data];
  if(rows.length>expected.length)throw invalid();
  const prices=new Map<string,Price>();
  for(const row of rows) {
    if(!row || !code(row.symbol) || !expected.includes(row.symbol) || prices.has(row.symbol) || typeof row.price!=='string' || row.price.length>80)throw invalid();
    let value:string;
    try {const number=nonnegative(row.price);if(number.isZero())throw invalid();value=number.toFixed();}catch{throw invalid();}
    prices.set(row.symbol,{value,currency:'USDT',asOf:receivedAt,source:`${mode}:ticker/price（采集时间，非成交时间）`});
  }
  return prices;
}
