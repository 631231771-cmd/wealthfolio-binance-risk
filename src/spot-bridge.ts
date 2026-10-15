import { nonnegative, calculateRisk, assetKey, DEFAULT_FRESHNESS, type PortfolioState, type Snapshot } from './domain';
import { parseExternalSpot } from './binance';
import { mergePublicSnapshotPrices, mergePublicSpotPrices } from './public-market';

const empty=():PortfolioState=>({schemaVersion:1,accounts:[],snapshots:{},statuses:{}});
const fields=(v:unknown,keys:string[]):Record<string,unknown>=>{
  if(!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).sort().join('|')!==keys.sort().join('|'))throw new Error();
  return v as Record<string,unknown>;
};
export class SpotBridge {
  private state=empty();
  getState(){return structuredClone(this.state);}
  invalidate(now:number){for(const a of this.state.accounts)this.state.statuses[a.id]={state:'failed',attemptedAt:new Date(now).toISOString(),reason:'辅助程序读取或导入失败；旧数量仅历史参考'};}
  importSnapshot(text:string,now:number){
    try{
      if(text.length>1_000_000)throw new Error();
      const x=fields(JSON.parse(text),['format','version','mode','uid','status','startedAt','endedAt','balances']);
      if(x.format!=='wrisk-spot-snapshot' || x.version!==1 || !['fixture','external'].includes(String(x.mode)) || typeof x.uid!=='string' || !/^\d{1,20}$/.test(x.uid) || !['ready','failed'].includes(String(x.status)))throw new Error();
      if(typeof x.startedAt!=='string' || typeof x.endedAt!=='string')throw new Error();
      const start=Date.parse(x.startedAt),end=Date.parse(x.endedAt);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>now||now-start>60_000)throw new Error();
      const id=`${x.mode}:binance:spot:${x.uid}`,old=this.state.accounts[0];
      if(old && old.id!==id)throw new Error();
      const prior=this.state.snapshots[id];
      if(prior && start<Date.parse(prior.collectionStartedAt!))throw new Error();
      if(!Array.isArray(x.balances)||x.balances.length>10000)throw new Error();
      if(x.status==='failed'){
        if(x.balances.length)throw new Error();
        if(!old)this.state.accounts=[{id,platform:'binance',sourceAccountId:x.uid,name:'本地Spot快照',kind:'spot',currency:'USDT'}];
        this.invalidate(now);return;
      }
      const seen=new Set<string>();
      const rows=x.balances.map(v=>{
        const r=fields(v,['asset','free','locked']);
        if(typeof r.asset!=='string'|| !/^[A-Z0-9]{1,40}$/.test(r.asset)||r.asset.startsWith('WRISKDEMO')||seen.has(r.asset))throw new Error();
        seen.add(r.asset);
        for(const key of ['free','locked'])if(typeof r[key]!=='string'||(r[key] as string).length>80)throw new Error();
        nonnegative(r.free as string);nonnegative(r.locked as string);return r;
      });
      const account={id,platform:'binance',sourceAccountId:x.uid,name:x.mode==='external'?'真实 Spot（本机快照）':'辅助程序测试 Spot（虚构数量）',kind:'spot',currency:'USDT'};
      const snapshot:Snapshot={...parseExternalSpot({balances:rows},account,`${id}:${x.endedAt}`,x.startedAt,x.endedAt),dataMode:x.mode as 'fixture'|'external'};
      this.state={schemaVersion:1,accounts:[account],snapshots:{[id]:snapshot},statuses:{[id]:{state:'ready',attemptedAt:x.endedAt}}};
    }catch{this.invalidate(now);throw new Error('余额快照被拒绝：格式、来源、账户或时效无效；历史数据不作为当前成功结果');}
  }
  valued(quotes:PortfolioState,now:number){
    const state=this.getState(),account=state.accounts[0];
    if(account){const s=state.snapshots[account.id];if(s)state.snapshots[account.id]=s.dataMode==='external'?mergePublicSpotPrices(account,s,quotes,now):mergePublicSnapshotPrices(s,quotes,now);}
    const shocks=Object.fromEntries(Object.values(state.snapshots).flatMap(s=>s.positions.map(p=>[assetKey(p.asset),p.asset.code==='USDT'?'0':'-0.2'])));
    return {state,report:calculateRisk(state,'USDT',[],shocks,{...DEFAULT_FRESHNESS,now:new Date(now).toISOString(),enforceFixtureFreshness:true})};
  }
}
