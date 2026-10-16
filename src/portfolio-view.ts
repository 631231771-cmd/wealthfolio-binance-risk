import {assetKey,positionKey,nonnegative,type PortfolioState,type Price, type calculateRisk} from './domain';

export type Valuation={state:PortfolioState;report:ReturnType<typeof calculateRisk>};
export type Reference=Valuation&{at:string};
export function portfolioView(value:Valuation,history:ReadonlyMap<string,Price>=new Map()){
  const {state,report}=value;
  const rows=Object.values(state.snapshots).flatMap(snapshot=>snapshot.positions.map(position=>{
    const key=assetKey(position.asset),eligible=report.eligiblePositionKeys.includes(positionKey(snapshot.accountId,position.asset));
    const amount=eligible?report.assetValues[key]:undefined;
    return {key:positionKey(snapshot.accountId,position.asset),code:position.asset.code,quantity:position.quantity,
      price:position.price,previousPrice:history.get(position.asset.code),value:amount,
      weight:eligible?report.assetWeights[key]:undefined,balanceAt:snapshot.asOf,
      balanceCurrent:report.currentAccountIds.includes(snapshot.accountId),
      dust:amount!==undefined&&nonnegative(amount).lt('0.1')};
  })).sort((a,b)=>a.value===undefined?(b.value===undefined?a.code.localeCompare(b.code):1):b.value===undefined?-1:nonnegative(b.value).comparedTo(a.value));
  return {rows,visible:rows.filter(r=>!r.dust),dust:rows.filter(r=>r.dust),allocation:rows.filter(r=>r.value!==undefined),
    priced:rows.filter(r=>r.value!==undefined).length,complete:report.coverage==='complete',balanceCurrent:report.currentAccountIds.length>0};
}
export function displayAmount(value:string|null|undefined,places=2){
  if(value==null)return '—';
  const n=nonnegative(value);
  if(!n.isZero()&&n.lt('0.01')&&places===2)return '<0.01';
  const [whole,fraction]=n.toFixed(places).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction===undefined?'':'.'+fraction);
}
export const displayPercent=(v:string|undefined|null)=>v==null?'—':nonnegative(v).mul(100).toFixed(2)+'%';
export const displayTime=(v:string|undefined)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'尚未更新';
