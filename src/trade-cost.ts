import Decimal from 'decimal.js';
import {nonnegative} from './domain';

// myTrades 成本重建原型：只处理能证明的部分，任何缺口都让 coverage 变成 partial。
export interface MyTrade {
  id:string; orderId:string; symbol:string; price:string; qty:string; quoteQty:string;
  commission:string; commissionAsset:string; time:number; isBuyer:boolean;
}
export type TradeIssueCode='FEE_THIRD_ASSET'|'OVERSELL'|'EMPTY'|'QUANTITY_MISMATCH'|'BASE_FEE_EXCEEDS_QTY';
export interface TradeIssue {code:TradeIssueCode;detail:string}
export interface Reconstruction {
  baseAsset:string; quoteAsset:string; trades:number;
  remainingQty:string; remainingCost:string; averageCost:string|null;
  realizedPnl:string; coverage:'complete'|'partial'; issues:TradeIssue[];
}
function parseSymbol(symbol:string){
  const match=/^([A-Z0-9]{2,20})(USDT|USDC|BTC|ETH|BNB)$/.exec(symbol);
  return match?{baseAsset:match[1],quoteAsset:match[2]}:null;
}
export function reconstructFifo(trades:MyTrade[],symbol:string,quoteAsset='USDT'):Reconstruction{
  const issues:TradeIssue[]=[];
  const parsed=parseSymbol(symbol);
  const baseAsset=parsed?.baseAsset??symbol.replace(new RegExp(quoteAsset+'$'),'');
  const quote=parsed?.quoteAsset??quoteAsset;
  const lots:{qty:Decimal;cost:Decimal}[]=[];
  let realized=new Decimal(0),coverage:'complete'|'partial'='complete';
  const flag=(code:TradeIssueCode,detail:string)=>{issues.push({code,detail});coverage='partial';};
  if(!trades.length)flag('EMPTY','没有可用的成交记录');
  const sorted=[...trades].sort((a,b)=>a.time-b.time||a.id.localeCompare(b.id));
  for(const trade of sorted){
    if(!trade.symbol.endsWith(quote)){flag('FEE_THIRD_ASSET',`${trade.id} 不是 ${quote} 计价市场，无法直接折算`);continue;}
    let qty:Decimal,price:Decimal,quoteQty:Decimal,commission:Decimal;
    try{qty=nonnegative(trade.qty);price=nonnegative(trade.price);quoteQty=nonnegative(trade.quoteQty);commission=nonnegative(trade.commission);}
    catch{flag('FEE_THIRD_ASSET',`${trade.id} 数值无效`);continue;}
    if(trade.isBuyer){
      let netQty=qty,cost=quoteQty;
      if(trade.commissionAsset===baseAsset){
        netQty=qty.sub(commission);
        if(netQty.lte(0)){flag('BASE_FEE_EXCEEDS_QTY',`${trade.id} 手续费不小于成交数量`);continue;}
      }else if(trade.commissionAsset===quote){
        cost=cost.add(commission);
      }else{
        // 第三币手续费需要成交时汇率，不能猜。
        flag('FEE_THIRD_ASSET',`${trade.id} 手续费为 ${trade.commissionAsset}，缺少当时汇率`);
      }
      lots.push({qty:netQty,cost});
    }else{
      let remaining=qty,proceeds=quoteQty;
      if(trade.commissionAsset===quote)proceeds=proceeds.sub(commission);
      else if(trade.commissionAsset===baseAsset)proceeds=proceeds.sub(commission.mul(price));
      else flag('FEE_THIRD_ASSET',`${trade.id} 手续费为 ${trade.commissionAsset}，缺少当时汇率`);
      while(remaining.gt(0)&&lots.length){
        const lot=lots[0],take=Decimal.min(lot.qty,remaining);
        const unitCost=lot.cost.div(lot.qty),costPart=unitCost.mul(take);
        realized=realized.add(proceeds.mul(take).div(qty).sub(costPart));
        lot.qty=lot.qty.sub(take);lot.cost=lot.cost.sub(costPart);remaining=remaining.sub(take);
        if(lot.qty.lte(0))lots.shift();
      }
      if(remaining.gt(0))flag('OVERSELL',`${trade.id} 卖出数量超过已知持仓，历史记录不完整`);
    }
  }
  const remainingQty=lots.reduce((sum,lot)=>sum.add(lot.qty),new Decimal(0));
  const remainingCost=lots.reduce((sum,lot)=>sum.add(lot.cost),new Decimal(0));
  return {baseAsset,quoteAsset:quote,trades:sorted.length,remainingQty:remainingQty.toFixed(8),
    remainingCost:remainingCost.toFixed(8),averageCost:remainingQty.gt(0)?remainingCost.div(remainingQty).toFixed(8):null,
    realizedPnl:realized.toFixed(8),coverage,issues};
}
// 成交重建结果必须与当前余额对账；不一致时不能把重建成本当作账户成本。
export function matchBalance(reconstruction:Reconstruction,balance:string):{ok:boolean;detail?:string}{
  let qty:Decimal;
  try{qty=nonnegative(balance);}catch{return {ok:false,detail:'余额无效'};}
  const rebuilt=new Decimal(reconstruction.remainingQty);
  if(rebuilt.eq(qty))return {ok:true};
  return {ok:false,detail:`重建 ${rebuilt.toFixed(8)} ≠ 余额 ${qty.toFixed(8)}`};
}
