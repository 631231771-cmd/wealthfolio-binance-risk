import Decimal from 'decimal.js';
import {assetKey, nonnegative, positionKey, type PortfolioState} from './domain';
import type {calculateRisk} from './domain';

// 成本账本只接受用户明确提供的单位成本；未知成本永远不当作 0。
export type CostBook=Readonly<Record<string,{unitCost:string}>>;
export interface CostRow {
  code:string; quantity:string; value?:string; unitCost?:string; cost?:string;
  gain?:string; gainPct?:string; priced:boolean; costKnown:boolean;
}
export interface CostSummary {
  rows:CostRow[];
  totalValue:string|null;      // 当前已定价市值（与首页口径一致）
  knownValue:string;           // 其中已有成本的部分
  cost:string|null;            // 已核实成本合计
  gain:string|null;            // 仅已核实成本部分的未实现盈亏
  gainPct:string|null;         // 分母是已核实成本，不是全部市值
  coverage:string|null;        // knownValue / totalValue
  state:'complete'|'partial'|'none';
  issues:('MISSING_COST'|'MISSING_PRICE')[];
}
export function costSummary(state:PortfolioState,report:ReturnType<typeof calculateRisk>,book:CostBook):CostSummary{
  const rows:CostRow[]=[],issues:('MISSING_COST'|'MISSING_PRICE')[]=[];
  let knownValue=new Decimal(0),costTotal=new Decimal(0),gainTotal=new Decimal(0),pricedRows=0,costedRows=0;
  for(const snapshot of Object.values(state.snapshots)){
    for(const position of snapshot.positions){
      const code=position.asset.code;
      const eligible=report.eligiblePositionKeys.includes(positionKey(snapshot.accountId,position.asset));
      const value=eligible?report.assetValues[assetKey(position.asset)]:undefined;
      const entry=book[code];
      let unitCost:Decimal|undefined;
      if(entry!==undefined){
        try{const unit=nonnegative(entry.unitCost);if(!unit.isZero())unitCost=unit;}
        catch{unitCost=undefined;}
      }
      const quantity=nonnegative(position.quantity);
      const cost=unitCost?unitCost.mul(quantity):undefined;
      const gain=cost&&value!==undefined?new Decimal(value).sub(cost):undefined;
      if(value!==undefined)pricedRows++;
      else issues.push('MISSING_PRICE');
      if(unitCost)costedRows++;
      else issues.push('MISSING_COST');
      if(value!==undefined&&cost){
        knownValue=knownValue.add(value);costTotal=costTotal.add(cost);gainTotal=gainTotal.add(gain!);
      }
      rows.push({code,quantity:quantity.toFixed(),
        ...(value!==undefined?{value}:{}),
        ...(unitCost?{unitCost:unitCost.toFixed()}:{}),
        ...(cost?{cost:cost.toFixed()}:{}),
        ...(gain?{gain:gain.toFixed()}:{}),
        ...(gain&&cost&&!cost.isZero()?{gainPct:gain.div(cost).toFixed(6)}:{}),
        priced:value!==undefined,costKnown:!!unitCost});
    }
  }
  const totalValue=report.coveredSubtotal;
  const complete=pricedRows===rows.length&&costedRows===rows.length&&rows.length>0;
  const anyKnown=costedRows>0&&knownValue.gt(0);
  return {
    rows,totalValue,knownValue:knownValue.toFixed(8),
    cost:anyKnown?costTotal.toFixed(8):null,
    gain:anyKnown?gainTotal.toFixed(8):null,
    gainPct:anyKnown&&costTotal.gt(0)?gainTotal.div(costTotal).toFixed(6):null,
    coverage:totalValue&&Number(totalValue)>0?knownValue.div(totalValue).toFixed(6):null,
    state:complete?'complete':anyKnown?'partial':'none',
    issues:[...new Set(issues)]
  };
}
// 只在完整覆盖时给账户级盈亏；部分覆盖必须显式标注"仅已核实成本部分"。
export function costHeadline(summary:CostSummary){
  if(summary.state==='none')return {label:'成本尚未核实',value:null as string|null,pct:null as string|null,scope:'none' as const};
  if(summary.state==='partial')return {label:'仅已核实成本部分',value:summary.gain,pct:summary.gainPct,scope:'partial' as const};
  return {label:'持仓累计盈亏',value:summary.gain,pct:summary.gainPct,scope:'complete' as const};
}
