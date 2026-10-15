import type { NetworkAPI, NetworkRequest } from '@wealthfolio/addon-sdk';
import { BinanceCredentials } from './credentials';
import { buildOfflineReadRequest, signPayload } from './binance';
import { calibrateTime, classifyResponse, spotSnapshot, SpotError, spotShock } from './spot';
import { PublicMarketReader, mergePublicSpotPrices, PUBLIC_ORIGIN } from './public-market';
import { assetKey, calculateRisk, type PortfolioState } from './domain';

export const DIRECT_INTERVAL=300_000, DIRECT_TTL=360_000;
const blocked=['enableWithdrawals','enableInternalTransfer','enableMargin','enableFutures','permitsUniversalTransfer','enableVanillaOptions','enableFixApiTrade','enableSpotAndMarginTrading','enablePortfolioMarginTrading'];
export const READ_ONLY_FIELDS=['enableReading','ipRestrict',...blocked,'enableFixReadOnly'];
export type PermissionReason='READING_DISABLED'|'EXTRA_PERMISSION'|'PERMISSION_FIELDS_INCOMPLETE';
interface PermissionField {field:string;value:boolean|null}
class ReadOnlyError extends Error {
  constructor(readonly code:PermissionReason,readonly fields:PermissionField[]){super(code);}
}
export function assertReadOnly(value:unknown):void {
  const required=['enableReading','ipRestrict',...blocked];
  const p=value as Record<string,unknown>;
  const missing=required.filter(k=>!p||typeof p[k]!=='boolean');
  if(!p||typeof p!=='object'||Array.isArray(p)||missing.length)throw new ReadOnlyError('PERMISSION_FIELDS_INCOMPLETE',missing.map(field=>({field,value:null})));
  if(p.enableReading!==true)throw new ReadOnlyError('READING_DISABLED',[{field:'enableReading',value:false}]);
  // v0.1.11：本人接受独立小额账户无IP白名单的隐私风险；仍要求此字段明确为布尔值。
  const extra=blocked.filter(k=>p[k]===true);
  const unknown=Object.entries(p).some(([k,v])=>v===true&&!READ_ONLY_FIELDS.includes(k));
  if(extra.length||unknown)throw new ReadOnlyError('EXTRA_PERMISSION',extra.map(field=>({field,value:true})));
  if('enableFixReadOnly' in p&&typeof p.enableFixReadOnly!=='boolean')throw new ReadOnlyError('PERMISSION_FIELDS_INCOMPLETE',[{field:'enableFixReadOnly',value:null}]);
}
// 只携带数值诊断，绝不挂载原始响应、请求或cause。
class DirectRequestError extends SpotError {
  constructor(error:SpotError,readonly httpStatus:number,readonly exchangeCode?:number){super(error.code,error.retryAfterSeconds);}
}
export function restrictionRequest(key:string,secret:string,timestamp:number):NetworkRequest {
  if(!key||!secret||!Number.isSafeInteger(timestamp)||timestamp<=0)throw new SpotError('invalid');
  const q=`timestamp=${timestamp}&recvWindow=5000`;
  return {method:'GET',url:`https://api.binance.com/sapi/v1/account/apiRestrictions?${q}&signature=${signPayload(q,secret)}`,headers:{'X-MBX-APIKEY':key},timeoutSecs:10};
}
const empty=():PortfolioState=>({schemaVersion:1,accounts:[],snapshots:{},statuses:{}});
export type DirectStage='idle'|'credentials'|'clock'|'permissions'|'balance'|'identity'|'quotes'|'complete'|'disconnected';
export interface DirectDiagnostic {stage:DirectStage;code:string;httpStatus?:number;exchangeCode?:number;permissionReason?:PermissionReason;permissionFields?:PermissionField[]}
export interface DirectRetry {canRetry:boolean;reason:'ready'|'in-flight'|'exchange-limit'|'backoff'|'confirmation-required'|'page-hidden';waitSeconds:number}
// 独立真实会话；旧离线reader的硬阻断不变。没有持仓存储/宿主账本写入能力。
export class DirectSpot {
  private state=empty(); private epoch=0; private pending=false; private busy=false;
  private uid=''; private connected=false; private visible=false; private failures=0;
  private due=0; private auto=false; private success=false;
  private cooldownUntil=0;
  private diagnostic:DirectDiagnostic={stage:'idle',code:'NOT_CONNECTED'};
  message='未连接真实账户；首次请求必须本人确认';
  constructor(private credentials:BinanceCredentials,private network:Pick<NetworkAPI,'request'>,private quotes:PublicMarketReader,private now=Date.now,private timeout=15_000){}
  getState(){return structuredClone(this.state);}
  getDiagnostic(){return structuredClone(this.diagnostic);}
  private retry():DirectRetry {
    const remaining=Math.max(this.cooldownUntil,this.quotes.getCooldownUntil())-this.now();
    if(remaining>0)return {canRetry:false,reason:'exchange-limit',waitSeconds:Math.ceil(remaining/1000)};
    if(this.busy||this.pending)return {canRetry:false,reason:'in-flight',waitSeconds:0};
    if(!this.connected)return {canRetry:false,reason:'confirmation-required',waitSeconds:0};
    if(!this.visible)return {canRetry:false,reason:'page-hidden',waitSeconds:0};
    if(this.failures&&this.due>this.now())return {canRetry:false,reason:'backoff',waitSeconds:Math.ceil((this.due-this.now())/1000)};
    return {canRetry:true,reason:'ready',waitSeconds:0};
  }
  getStatus(){return {connected:this.connected,busy:this.busy||this.pending,auto:this.auto,success:this.success,nextDue:Math.max(this.due,this.cooldownUntil,this.quotes.getCooldownUntil()),visible:this.visible,retry:this.retry()};}
  setVisible(value:boolean){if(this.visible&&!value)this.epoch++;this.visible=value;}
  disconnect(){this.epoch++;this.connected=false;this.auto=false;this.success=false;this.failures=0;this.due=0;this.invalidate();this.diagnostic={stage:'disconnected',code:'USER_DISCONNECTED'};this.message='已断开；不再发送新请求，在途SDK请求无法撤回，迟到结果不发布';}
  private invalidate(){for(const a of this.state.accounts)this.state.statuses[a.id]={state:'failed',attemptedAt:new Date(this.now()).toISOString(),reason:'真实Spot读取失效；历史数量仅供参考'};}
  authorize(uid:string,ack:{risk:boolean;smallAccount:boolean;readOnlyPage:boolean;aiIsolated:boolean}){
    if(!/^\d{1,20}$/.test(uid)||Object.values(ack).length!==4||!ack.risk||!ack.smallAccount||!ack.readOnlyPage||!ack.aiIsolated)throw new Error('请本人核对UID、小额只读账户、AI隔离并接受本机签名URL日志风险');
    if(this.uid&&this.uid!==uid)throw new Error('本会话已绑定其他UID，请关闭插件页面后重新开始');
    this.uid=uid;this.connected=true;this.failures=0;this.due=0;
  }
  setAuto(value:boolean,reconciled=false){
    if(value&&(!this.connected||!this.success||!reconciled))throw new Error('先成功查询并由本人对账，才能开启自动刷新');
    this.auto=value;if(value)this.due=Math.max(this.due,this.now()+DIRECT_INTERVAL);
  }
  async tick(){if(this.auto&&this.retry().canRetry&&this.now()>=this.due)await this.sync();}
  private async request(req:NetworkRequest,epoch:number):Promise<unknown>{
    if(!this.connected||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
    this.pending=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const operation=Promise.resolve().then(()=>this.network.request(req)).then(response=>{
      // 即使SDK超时或本人断开后才返回，交易所明确限流也不能被会话epoch丢弃。
      if(response.status===429||response.status===418){
        const retry=Number(Object.entries(response.headers??{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1]);
        const seconds=Number.isSafeInteger(retry)&&retry>0?Math.min(retry,Math.floor((Number.MAX_SAFE_INTEGER-this.now())/1000)):(response.status===418?1800:60);
        this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+seconds*1000);
      }
      return response;
    }).finally(()=>{this.pending=false;});
    try{
      const response=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new SpotError('timeout')),this.timeout);})]);
      if(!this.connected||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
      if(!Number.isInteger(response.status)||response.status<100||response.status>599)throw new SpotError('invalid');
      let data:unknown,parsed=false;
      if(typeof response.body==='string'&&response.body.length<=2*1024*1024&&new TextEncoder().encode(response.body).byteLength<=2*1024*1024){
        try{data=JSON.parse(response.body);parsed=true;}catch{}
      }
      const rawCode=data&&typeof data==='object'&&!Array.isArray(data)?(data as {code?:unknown}).code:undefined;
      const exchangeCode=Number.isSafeInteger(rawCode)?rawCode as number:undefined;
      const retryHeader=Object.entries(response.headers??{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1];
      try{
        classifyResponse({status:response.status,data:exchangeCode===undefined?null:{code:exchangeCode},headers:{'Retry-After':retryHeader??''}});
        if(!parsed)throw new SpotError('invalid');
      }catch(e){throw new DirectRequestError(e instanceof SpotError?e:new SpotError('invalid'),response.status,exchangeCode);}
      return data;
    }catch(e){throw e instanceof SpotError?e:new SpotError('network');}finally{clearTimeout(timer);}
  }
  async sync(){
    if(this.busy||this.pending)throw new SpotError('busy');
    if(!this.connected||!this.visible)throw new SpotError('disconnected');
    if(!this.retry().canRetry)throw new SpotError(this.retry().reason==='exchange-limit'?'rate-limit':'busy');
    this.busy=true;const epoch=this.epoch;
    const mark=(stage:DirectStage)=>{if(epoch===this.epoch)this.diagnostic={stage,code:'RUNNING'};};
    try{
      mark('credentials');
      const pair=await this.credentials.read();if(!pair)throw new SpotError('auth');
      if(pair.apiKey.startsWith('WRISK_')||pair.secret.startsWith('WRISK_'))throw new SpotError('auth');
      mark('clock');
      const start=this.now(), clock=await this.request({method:'GET',url:PUBLIC_ORIGIN+'/api/v3/time',timeoutSecs:10},epoch);
      const offset=calibrateTime(clock,start,this.now());
      mark('permissions');
      const permission=await this.request(restrictionRequest(pair.apiKey,pair.secret,Math.floor(this.now()+offset)),epoch);
      try{assertReadOnly(permission);}catch(e){this.disconnect();this.diagnostic={stage:'permissions',code:'READ_ONLY_REJECTED',...(e instanceof ReadOnlyError?{permissionReason:e.code,permissionFields:e.fields}:{})};throw new Error('只读检查未通过，已停止');}
      mark('balance');
      const began=this.now();
      const body=await this.request({...buildOfflineReadRequest('spot',pair.apiKey,pair.secret,Math.floor(began+offset)),timeoutSecs:10},epoch);
      const ended=this.now();if(ended<began||ended-began>30_000)throw new SpotError('clock');
      const {account,snapshot}=spotSnapshot(body,'external',new Date(began).toISOString(),new Date(ended).toISOString());
      if(account.sourceAccountId!==this.uid){this.disconnect();this.diagnostic={stage:'identity',code:'UID_MISMATCH'};throw new Error('返回UID与预期不符；已停止，不接纳该账户资产');}
      // 公开取价失败保留本次可靠数量及缺价，不沿用失效价格。
      mark('quotes');
      let quoted=true;try{await this.quotes.refresh();}catch{quoted=false;}
      if(!this.connected||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
      this.diagnostic=quoted?{stage:'complete',code:'OK'}:{stage:'quotes',code:'QUOTES_UNAVAILABLE'};
      this.state={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:snapshot.asOf}}};
      this.success=true;this.failures=0;this.due=this.now()+DIRECT_INTERVAL;this.message='真实Spot快照已替换；请核对数量、来源和缺口。未写主程序账本';
    }catch(e){
      if(epoch===this.epoch){
        const failedAt=this.diagnostic.stage;
        this.invalidate();this.failures++;const code=e instanceof SpotError?e.code:null;
        if(code==='rate-limit'){this.failures=0;this.due=0;}
        else this.due=this.now()+Math.min(DIRECT_INTERVAL*2**Math.min(this.failures,3),1_800_000);
        if(code&&['auth','forbidden','signature','invalid','clock'].includes(code))this.disconnect();
        this.diagnostic={stage:failedAt,code:code?`SPOT_${code.toUpperCase().replaceAll('-','_')}`:'INVALID_RESPONSE',...(e instanceof DirectRequestError?{httpStatus:e.httpStatus,...(e.exchangeCode===undefined?{}:{exchangeCode:e.exchangeCode})}:{})};
        this.message=code?`真实Spot读取失败：${e instanceof SpotError?e.message:'不可用'}；历史数据不可作当前资产`:this.message;
      }else {
        if(!['READ_ONLY_REJECTED','UID_MISMATCH','USER_DISCONNECTED'].includes(this.diagnostic.code))this.diagnostic={stage:'disconnected',code:'PAGE_PAUSED'};
        if(!this.connected)this.message='已停止：权限/UID/连接核对未通过，或本人已断开；当前不可用';
      }
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
