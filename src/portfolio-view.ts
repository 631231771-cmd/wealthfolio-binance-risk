import {assetKey,positionKey,nonnegative,type PortfolioState,type Price, type calculateRisk} from './domain';

export type Valuation={state:PortfolioState;report:ReturnType<typeof calculateRisk>};
export type Reference=Valuation&{at:string};
// A historical screen is a whole published valuation, never per-row price fallback.
// A newer balance must remain visible even when its valuation is incomplete.
export function portfolioPresentation(value:Valuation,reference:Reference|null=null){
  const current=portfolioView(value);
  const balanceIdentity=(v:Valuation)=>JSON.stringify(Object.values(v.state.snapshots).map(s=>[
    s.accountId,s.dataMode,s.batchId,s.asOf,s.collectionStartedAt,s.collectionEndedAt,
    s.positions.map(p=>[assetKey(p.asset),p.quantity])
  ]));
  const sameBalances=reference!==null&&balanceIdentity(value)===balanceIdentity(reference);
  const old=reference?portfolioView(reference):null;
  const historical=!!(sameBalances&&old&&reference!.report.coveredSubtotal!==null&&
    (!current.balanceCurrent||(!current.allocation.some(r=>r.code!=='USDT')&&old.allocation.some(r=>r.code!=='USDT'))));
  const displayed=historical?reference!:value,view=historical?old!:current;
  const priceTimes=[...new Set(view.allocation.filter(r=>r.code!=='USDT').map(r=>r.price?.asOf).filter((v):v is string=>!!v))].sort();
  return {view,current,displayed,historical,sameBalances,at:historical?reference!.at:undefined,
    balanceAt:Object.values(displayed.state.snapshots)[0]?.asOf,
    priceFrom:priceTimes[0],priceTo:priceTimes.at(-1)};
}
export function portfolioView(value:Valuation,history:ReadonlyMap<string,Price>=new Map()){
  const {state,report}=value;
  const rows=Object.values(state.snapshots).flatMap(snapshot=>snapshot.positions.map(position=>{
    const key=assetKey(position.asset),eligible=report.eligiblePositionKeys.includes(positionKey(snapshot.accountId,position.asset));
    const amount=eligible?report.assetValues[key]:undefined;
    return {key:positionKey(snapshot.accountId,position.asset),code:position.asset.code,quantity:position.quantity,
      price:eligible?position.price:undefined,previousPrice:history.get(position.asset.code),value:amount,
      weight:eligible?report.assetWeights[key]:undefined,balanceAt:snapshot.asOf,
      balanceCurrent:report.currentAccountIds.includes(snapshot.accountId),
      dust:amount!==undefined&&nonnegative(amount).lt('0.1')};
  })).sort((a,b)=>a.value===undefined?(b.value===undefined?a.code.localeCompare(b.code):1):b.value===undefined?-1:nonnegative(b.value).comparedTo(a.value));
  return {rows,visible:rows.filter(r=>!r.dust),dust:rows.filter(r=>r.dust),allocation:rows.filter(r=>r.value!==undefined),
    priced:rows.filter(r=>r.value!==undefined).length,complete:report.coverage==='complete',balanceCurrent:report.currentAccountIds.length>0};
}
// 配色只跟随资产身份，不跟随排序或微额过滤；同一代码在任何视图都是同一色调。
export function assetTone(code:string){
  let hash=0;
  for(const ch of code)hash=(hash*31+ch.codePointAt(0)!)>>>0;
  return hash%5;
}
export function displayAmount(value:string|null|undefined,places=2){
  if(value==null)return '—';
  const n=nonnegative(value);
  if(!n.isZero()&&n.lt('0.01')&&places===2)return '<0.01';
  const [whole,fraction]=n.toFixed(places).split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction===undefined?'':'.'+fraction);
}
export function displayPercent(v:string|undefined|null){
  if(v==null)return '—';
  const n=nonnegative(v).mul(100);
  return (!n.isZero()&&n.lt('0.01')?'<0.01':n.toFixed(2))+'%';
}
export const displayTime=(v:string|undefined)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'尚未更新';
