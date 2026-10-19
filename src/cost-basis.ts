import Decimal from 'decimal.js';
import {assetKey, nonnegative, positionKey, type PortfolioState} from './domain';
import type {calculateRisk} from './domain';

// 成本账本只接受用户明确提供的单位成本；未知成本永远不当作 0。
export type CostSource='entered'|'confirmed'|'rebuilt'|'imported';
export type CostBook=Readonly<Record<string,{unitCost:string;source?:CostSource;updatedAt?:string}>>;
export interface CostRow {
  code:string; quantity:string; value?:string; unitCost?:string; cost?:string;
  gain?:string; gainPct?:string; priced:boolean; costKnown:boolean; source?:CostSource; dust:boolean;
}
export interface CostSummary {
  rows:CostRow[];
  totalValue:string|null;      // 当前已定价市值（含微额，与首页口径一致）
  eligibleValue:string;        // 非微额资产的已定价市值，收益率分母
  knownValue:string;           // 其中已有成本的部分
  cost:string|null;            // 已核实成本合计
  gain:string|null;            // 仅已核实成本部分的未实现盈亏
  gainPct:string|null;         // 分母是已核实成本，不是全部市值
  coverage:string|null;        // knownValue / totalValue
  state:'complete'|'partial'|'none';
  allConfirmed:boolean;
  issues:('MISSING_COST'|'MISSING_PRICE')[];
}
export function costSummary(state:PortfolioState,report:ReturnType<typeof calculateRisk>,book:CostBook):CostSummary{
  const rows:CostRow[]=[],issues:('MISSING_COST'|'MISSING_PRICE')[]=[];
  for(const snapshot of Object.values(state.snapshots)){
    for(const position of snapshot.positions){
      const code=position.asset.code;
      const eligible=report.eligiblePositionKeys.includes(positionKey(snapshot.accountId,position.asset));
      const value=eligible?report.assetValues[assetKey(position.asset)]:undefined;
      const entry=book[code];
      let unitCost:Decimal|undefined;
      // USDT 现金按面值计价：宿主把现金成本视为市值，盈亏恒 0，不需要用户录入成本。
      if(entry===undefined&&code==='USDT'&&position.asset.quoteCurrency==='USDT')unitCost=new Decimal(1);
      if(entry!==undefined){
        try{const unit=nonnegative(entry.unitCost);if(!unit.isZero())unitCost=unit;}
        catch{unitCost=undefined;}
      }
      const quantity=nonnegative(position.quantity);
      const cost=unitCost?unitCost.mul(quantity):undefined;
      const gain=cost&&value!==undefined?new Decimal(value).sub(cost):undefined;
      // 微额只按可靠市值判断；USDT 是现金，不参与微额豁免。
      const dust=value!==undefined&&code!=='USDT'&&nonnegative(value).lt('0.1');
      rows.push({code,quantity:quantity.toFixed(),...(entry?.source?{source:entry.source}:{}),
        ...(value!==undefined?{value}:{}),
        ...(unitCost?{unitCost:unitCost.toFixed()}:{}),
        ...(cost?{cost:cost.toFixed()}:{}),
        ...(gain?{gain:gain.toFixed()}:{}),
        ...(gain&&cost&&!cost.isZero()?{gainPct:gain.div(cost).toFixed(6)}:{}),
        priced:value!==undefined,costKnown:!!unitCost,dust});
    }
  }
  const normal=rows.filter(r=>!r.dust);
  if(normal.some(r=>!r.priced))issues.push('MISSING_PRICE');
  if(normal.some(r=>!r.costKnown))issues.push('MISSING_COST');
  const totalValue=report.coveredSubtotal;
  const eligibleValue=normal.reduce((sum,r)=>r.value!==undefined?sum.add(r.value):sum,new Decimal(0));
  const known=normal.filter(r=>r.priced&&r.costKnown);
  const knownValue=known.reduce((sum,r)=>sum.add(r.value!),new Decimal(0));
  const costTotal=known.reduce((sum,r)=>sum.add(r.cost!),new Decimal(0));
  const gainTotal=known.reduce((sum,r)=>sum.add(r.gain!),new Decimal(0));
  // 完整性只看非微额资产：微额无需成本，也不进入收益率分母。
  const complete=normal.length>0&&normal.every(r=>r.priced&&r.costKnown);
  const onlyCash=normal.length>0&&normal.every(r=>r.code==='USDT');
  const securityKnown=known.filter(r=>r.code!=='USDT'||book['USDT']!==undefined);
  const anyKnown=(securityKnown.length>0||onlyCash)&&knownValue.gt(0);
  const allConfirmed=known.length>0&&known.every(r=>r.code==='USDT'||r.source==='confirmed'||r.source==='rebuilt');
  return {
    rows,totalValue,eligibleValue:eligibleValue.toFixed(8),knownValue:knownValue.toFixed(8),
    cost:anyKnown?costTotal.toFixed(8):null,
    gain:anyKnown?gainTotal.toFixed(8):null,
    gainPct:anyKnown&&costTotal.gt(0)?gainTotal.div(costTotal).toFixed(6):null,
    coverage:eligibleValue.gt(0)?knownValue.div(eligibleValue).toFixed(6):null,
    state:complete?'complete':anyKnown?'partial':'none',allConfirmed,
    issues:[...new Set(issues)]
  };
}
// 只在完整覆盖时给账户级盈亏；部分覆盖必须显式标注"仅已核实成本部分"。
export function costHeadline(summary:CostSummary){
  if(summary.state==='none')return {label:'成本尚未核实',value:null as string|null,pct:null as string|null,scope:'none' as const,basis:'成本尚未核实'};
  if(summary.state==='partial')return {label:'仅已填写成本部分',value:summary.gain,pct:summary.gainPct,scope:'partial' as const,basis:'部分资产成本仍未知'};
  return {label:'持仓累计盈亏',value:summary.gain,pct:summary.gainPct,scope:'complete' as const,basis:summary.allConfirmed?'已确认成本':'已填写成本（待确认）'};
}
