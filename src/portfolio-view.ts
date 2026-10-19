import {assetKey,balanceIdentity,positionKey,nonnegative,type PortfolioState,type Price, type calculateRisk} from './domain';

export type Valuation={state:PortfolioState;report:ReturnType<typeof calculateRisk>};
export type Reference=Valuation&{at:string};
// 展示口径：最醒目的金额必须与它真正代表的财务事实一致。
export type ValuationState='live'|'live-partial'|'history-complete'|'history-partial'|'zero'|'unavailable';
// A historical screen is a whole published valuation, never per-row price fallback.
// A newer balance must remain visible even when its valuation is incomplete.
export function portfolioPresentation(value:Valuation,reference:Reference|null=null){
  const current=portfolioView(value);
  // 身份只看账户、来源、资产与数量；同一份持仓换了采集时间仍可复用同一份估值记录。
  const sameBalances=reference!==null&&balanceIdentity(value.state)===balanceIdentity(reference.state);
  const old=reference?portfolioView(reference):null;
  const historical=!!(sameBalances&&old&&reference!.report.coveredSubtotal!==null&&
    (!current.balanceCurrent||(!current.allocation.some(r=>r.code!=='USDT')&&old.allocation.some(r=>r.code!=='USDT'))));
  const displayed=historical?reference!:value,view=historical?old!:current;
  const priceTimes=[...new Set(view.allocation.filter(r=>r.code!=='USDT').map(r=>r.price?.asOf).filter((v):v is string=>!!v))].sort();
  return {view,current,displayed,historical,sameBalances,state:valuationState(historical,view,displayed),at:historical?reference!.at:undefined,
    balanceAt:Object.values(displayed.state.snapshots)[0]?.asOf,
    priceFrom:priceTimes[0],priceTo:priceTimes.at(-1)};
}
export function valuationState(historical:boolean,view:ReturnType<typeof portfolioView>,displayed:Valuation):ValuationState{
  if(displayed.report.coveredSubtotal===null)return 'unavailable';
  if(historical)return displayed.report.coverage==='complete'?'history-complete':'history-partial';
  if(view.rows.length===0)return 'zero';
  return view.complete?'live':'live-partial';
}
// Hero 口径：标题与标签必须由同一个状态派生，避免五处文案各说一套。
export function heroLabel(state:ValuationState,hasRows:boolean){
  switch(state){
    case 'live':case 'zero':return {title:'Spot 资产总值',tag:'当前有效'};
    case 'live-partial':return {title:'已定价小计',tag:'部分覆盖'};
    case 'history-complete':return {title:'上次完整估值',tag:'历史快照'};
    case 'history-partial':return {title:'上次部分估值',tag:'历史 · 部分覆盖'};
    default:return {title:hasRows?'暂无可信估值':'Spot 已估值资产',tag:'等待更新'};
  }
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
  })).sort((a,b)=>a.value===undefined?(b.value===undefined?a.code.localeCompare(b.code):1):b.value===undefined?-1:(nonnegative(b.value).comparedTo(a.value)||a.code.localeCompare(b.code)));
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
