import type { NetworkAPI, NetworkRequest } from '@wealthfolio/addon-sdk';
import { BinanceCredentials } from './credentials';
import { buildOfflineReadRequest, signPayload } from './binance';
import { calibrateTime, classifyResponse, spotSnapshot, SpotError, spotShock } from './spot';
import { PublicMarketReader, mergePublicSpotPrices, PUBLIC_ORIGIN } from './public-market';
import { assetKey, calculateRisk, type PortfolioState } from './domain';

export const DIRECT_INTERVAL=300_000, DIRECT_TTL=360_000;
const blocked=['enableWithdrawals','enableInternalTransfer','enableMargin','enableFutures','permitsUniversalTransfer','enableVanillaOptions','enableFixApiTrade','enableSpotAndMarginTrading','enablePortfolioMarginTrading'];
export function assertReadOnly(value:unknown):void {
  const p=value as Record<string,unknown>;
  if(!p || p.enableReading!==true || p.ipRestrict!==true || blocked.some(k=>p[k]!==false) ||
    Object.entries(p).some(([k,v])=>v===true&&!['enableReading','ipRestrict','enableFixReadOnly'].includes(k)))throw new Error('API权限不是已核实的纯只读/IP限制，或权限字段不完整；已停止');
}
export function restrictionRequest(key:string,secret:string,timestamp:number):NetworkRequest {
  if(!key||!secret||!Number.isSafeInteger(timestamp)||timestamp<=0)throw new SpotError('invalid');
  const q=`timestamp=${timestamp}&recvWindow=5000`;
  return {method:'GET',url:`https://api.binance.com/sapi/v1/account/apiRestrictions?${q}&signature=${signPayload(q,secret)}`,headers:{'X-MBX-APIKEY':key},timeoutSecs:10};
}
const empty=():PortfolioState=>({schemaVersion:1,accounts:[],snapshots:{},statuses:{}});
// 独立真实会话；旧离线reader的硬阻断不变。没有持仓存储/宿主账本写入能力。
export class DirectSpot {
  private state=empty(); private epoch=0; private pending=false; private busy=false;
  private uid=''; private connected=false; private visible=false; private failures=0;
  private due=0; private auto=false; private success=false;
  message='未连接真实账户；首次请求必须本人确认';
  constructor(private credentials:BinanceCredentials,private network:Pick<NetworkAPI,'request'>,private quotes:PublicMarketReader,private now=Date.now,private timeout=15_000){}
  getState(){return structuredClone(this.state);}
  getStatus(){return {connected:this.connected,busy:this.busy||this.pending,auto:this.auto,success:this.success,nextDue:this.due,visible:this.visible};}
  setVisible(value:boolean){if(this.visible&&!value)this.epoch++;this.visible=value;}
  disconnect(){this.epoch++;this.connected=false;this.auto=false;this.success=false;this.invalidate();this.message='已断开；不再发送新请求，在途SDK请求无法撤回，迟到结果不发布';}
  private invalidate(){for(const a of this.state.accounts)this.state.statuses[a.id]={state:'failed',attemptedAt:new Date(this.now()).toISOString(),reason:'真实Spot读取失效；历史数量仅供参考'};}
  authorize(uid:string,ack:{risk:boolean;smallAccount:boolean;readOnlyPage:boolean;aiIsolated:boolean}){
    if(!/^\d{1,20}$/.test(uid)||Object.values(ack).length!==4||!ack.risk||!ack.smallAccount||!ack.readOnlyPage||!ack.aiIsolated)throw new Error('请本人核对UID、小额只读账户、AI隔离并接受本机签名URL日志风险');
    if(this.uid&&this.uid!==uid)throw new Error('本会话已绑定其他UID，请关闭插件页面后重新开始');
    this.uid=uid;this.connected=true;
  }
  setAuto(value:boolean,reconciled=false){
    if(value&&(!this.connected||!this.success||!reconciled))throw new Error('先成功查询并由本人对账，才能开启自动刷新');
    this.auto=value;if(value)this.due=Math.max(this.due,this.now()+DIRECT_INTERVAL);
  }
  async tick(){if(this.auto&&this.connected&&this.visible&&!this.busy&&!this.pending&&this.now()>=this.due)await this.sync();}
  private async request(req:NetworkRequest,epoch:number):Promise<unknown>{
    if(!this.connected||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
    this.pending=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const operation=Promise.resolve().then(()=>this.network.request(req)).finally(()=>{this.pending=false;});
    try{
      const response=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SpotError('timeout')),this.timeout);})]);
      if(!this.connected||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
      if(response.status!==200)classifyResponse({status:response.status,data:null,headers:response.headers});
      if(typeof response.body!=='string'||response.body.length>2*1024*1024)throw new SpotError('invalid');
      let data:unknown;try{data=JSON.parse(response.body);}catch{throw new SpotError('invalid');}
      classifyResponse({status:response.status,data,headers:response.headers});return data;
    }catch(e){throw e instanceof SpotError?e:new SpotError('network');}finally{clearTimeout(timer);}
  }
  async sync(){
    if(this.busy||this.pending)throw new SpotError('busy');
    if(!this.connected||!this.visible)throw new SpotError('disconnected');
    if(this.now()<this.due&&this.failures)throw new SpotError('rate-limit');
    this.busy=true;const epoch=this.epoch;
    try{
      const pair=await this.credentials.read();if(!pair)throw new SpotError('auth');
      if(pair.apiKey.startsWith('WRISK_')||pair.secret.startsWith('WRISK_'))throw new SpotError('auth');
      const start=this.now(), clock=await this.request({method:'GET',url:PUBLIC_ORIGIN+'/api/v3/time',timeoutSecs:10},epoch);
      const offset=calibrateTime(clock,start,this.now());
      const permission=await this.request(restrictionRequest(pair.apiKey,pair.secret,Math.floor(this.now()+offset)),epoch);
      try{assertReadOnly(permission);}catch{this.disconnect();throw new Error('API权限不是纯只读或缺少可靠字段/IP限制；已停止，不查询余额');}
      const began=this.now();
      const body=await this.request({...buildOfflineReadRequest('spot',pair.apiKey,pair.secret,Math.floor(began+offset)),timeoutSecs:10},epoch);
      const ended=this.now();if(ended<began||ended-began>30_000)throw new SpotError('clock');
      const {account,snapshot}=spotSnapshot(body,'external',new Date(began).toISOString(),new Date(ended).toISOString());
      if(account.sourceAccountId!==this.uid){this.disconnect();throw new Error('返回UID与预期不符；已停止，不接纳该账户资产');}
      // 公开取价失败保留本次可靠数量及缺价，不沿用失效价格。
      try{await this.quotes.refresh();}catch{}
      if(!this.connected||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
      this.state={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:snapshot.asOf}}};
      this.success=true;this.failures=0;this.due=this.now()+DIRECT_INTERVAL;this.message='真实Spot快照已替换；请核对数量、来源和缺口。未写主程序账本';
    }catch(e){
      if(epoch===this.epoch){
        this.invalidate();this.failures++;const code=e instanceof SpotError?e.code:null;
        this.due=this.now()+Math.max(Math.min(DIRECT_INTERVAL*2**Math.min(this.failures,3),1_800_000),(e instanceof SpotError?e.retryAfterSeconds??0:0)*1000);
        if(code&&['auth','forbidden','signature','invalid','clock'].includes(code))this.disconnect();
        this.message=code?`真实Spot读取失败：${e instanceof SpotError?e.message:'不可用'}；历史数据不可作当前资产`:this.message;
      }else if(!this.connected)this.message='已停止：权限/UID/连接核对未通过，或本人已断开；当前不可用';
      // 不透传URL、header、body、原始异常或cause；宿主事先日志风险仍存在。
    }finally{this.busy=false;}
  }
  valued(){
    const now=this.now(),state=this.getState(),a=state.accounts[0];
    if(a&&state.snapshots[a.id])state.snapshots[a.id]=mergePublicSpotPrices(a,state.snapshots[a.id],this.quotes.getState(),now,DIRECT_TTL);
    const shocks=Object.fromEntries(Object.values(state.snapshots).flatMap(s=>s.positions.map(p=>[assetKey(p.asset),spotShock(p.asset.code)])));
    return {state,report:calculateRisk(state,'USDT',[],shocks,{now:new Date(now).toISOString(),balanceMaxAgeMs:DIRECT_TTL,priceMaxAgeMs:DIRECT_TTL,fxMaxAgeMs:DIRECT_TTL})};
  }
}
