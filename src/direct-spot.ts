import type { NetworkAPI, NetworkRequest } from '@wealthfolio/addon-sdk';
import { BinanceCredentials } from './credentials';
import { buildOfflineReadRequest, signPayload } from './binance';
import { calibrateTime, classifyResponse, spotSnapshot, SpotError, spotShock, ClockError, SpotValidationError, type ClockDetails, type SpotValidationDetails } from './spot';
import { PublicMarketError, SpotQuoteReader, mergeDynamicPublicSpotPrices, PUBLIC_ORIGIN, type SpotQuoteRefreshResult } from './public-market';
import { assetKey, calculateRisk, type PortfolioState } from './domain';

export const DIRECT_INTERVAL=300_000, DIRECT_TTL=360_000;
export const QUOTE_INTERVAL=60_000, QUOTE_TTL=120_000;
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
  constructor(error:SpotError,readonly layer:'plugin-timer'|'host-call'|'http-response',readonly elapsedMs:number,readonly httpStatus?:number,readonly exchangeCode?:number,readonly validation?:SpotValidationDetails,readonly jsonValid?:boolean){super(error.code,error.retryAfterSeconds);}
}
export function restrictionRequest(key:string,secret:string,timestamp:number):NetworkRequest {
  if(!key||!secret||!Number.isSafeInteger(timestamp)||timestamp<=0)throw new SpotError('invalid');
  const q=`timestamp=${timestamp}&recvWindow=5000`;
  return {method:'GET',url:`https://api.binance.com/sapi/v1/account/apiRestrictions?${q}&signature=${signPayload(q,secret)}`,headers:{'X-MBX-APIKEY':key},timeoutSecs:10};
}
const empty=():PortfolioState=>({schemaVersion:1,accounts:[],snapshots:{},statuses:{}});
export type DirectStage='idle'|'credentials'|'clock'|'permissions'|'balance'|'identity'|'quotes'|'complete'|'disconnected';
export interface DirectDiagnostic {stage:DirectStage;code:string;httpStatus?:number;exchangeCode?:number;permissionReason?:PermissionReason;permissionFields?:PermissionField[];layer?:'plugin-timer'|'host-call'|'http-response'|'clock-validation'|'account-validation'|'snapshot-validation';elapsedMs?:number;clock?:ClockDetails;jsonValid?:boolean;validation?:SpotValidationDetails;quote?:SpotQuoteRefreshResult}
export interface TimeObservation {host:'MARKET'|'SPOT';attempt:number;code:string;elapsedMs?:number;httpStatus?:number;exchangeCode?:number;serverTimeValid?:boolean;offsetMs?:number;reason?:ClockDetails['reason'];layer?:DirectDiagnostic['layer']}
export interface DirectRetry {canRetry:boolean;reason:'ready'|'in-flight'|'exchange-limit'|'backoff'|'confirmation-required'|'page-hidden';waitSeconds:number}
// 独立真实会话；旧离线reader的硬阻断不变。没有持仓存储/宿主账本写入能力。
export class DirectSpot {
  private state=empty(); private epoch=0; private pending=false; private busy=false;
  private uid=''; private connected=false; private visible=false; private failures=0;
  private due=0; private auto=false; private success=false;
  private cooldownUntil=0;
  private quoteDue=0; private quoteFailures=0;
  private reference: {state:PortfolioState;report:ReturnType<typeof calculateRisk>;at:string}|null=null;
  private diagnostic:DirectDiagnostic={stage:'idle',code:'NOT_CONNECTED'};
  private timeObservations:TimeObservation[]=[];
  private publicObservations:TimeObservation[]=[];
  private lastRequest:{elapsedMs:number;httpStatus:number;jsonValid?:boolean}|undefined;
  message='未连接真实账户；首次请求必须本人确认';
  constructor(private credentials:BinanceCredentials,private network:Pick<NetworkAPI,'request'>,private quotes:SpotQuoteReader,private now=Date.now,private timeout=15_000,private monotonic=()=>performance.now()){}
  getState(){return structuredClone(this.state);}
  getReference(){return structuredClone(this.reference);}
  getHistoricalQuotes(){return this.quotes.getHistoricalQuotes();}
  getDiagnostic(){return structuredClone(this.diagnostic);}
  getTimeObservations(){return structuredClone(this.timeObservations);}
  getPublicObservations(){return structuredClone(this.publicObservations);}
  private retry(publicQuote=false):DirectRetry {
    const remaining=Math.max(this.cooldownUntil,this.quotes.getCooldownUntil())-this.now();
    if(remaining>0)return {canRetry:false,reason:'exchange-limit',waitSeconds:Math.ceil(remaining/1000)};
    if(this.busy||this.pending||this.quotes.isBusy())return {canRetry:false,reason:'in-flight',waitSeconds:0};
    if(!this.connected)return {canRetry:false,reason:'confirmation-required',waitSeconds:0};
    if(!this.visible)return {canRetry:false,reason:'page-hidden',waitSeconds:0};
    const backoff=publicQuote?(this.quoteFailures?this.quoteDue:0):(this.failures?this.due:0);
    if(backoff>this.now())return {canRetry:false,reason:'backoff',waitSeconds:Math.ceil((backoff-this.now())/1000)};
    return {canRetry:true,reason:'ready',waitSeconds:0};
  }
  getStatus(){return {connected:this.connected,busy:this.busy||this.pending||this.quotes.isBusy(),auto:this.auto,success:this.success,nextDue:Math.max(this.due,this.cooldownUntil,this.quotes.getCooldownUntil()),quoteDue:Math.max(this.quoteDue,this.cooldownUntil,this.quotes.getCooldownUntil()),quoteRetry:this.retry(true),visible:this.visible,retry:this.retry()};}
  setVisible(value:boolean){if(this.visible&&!value){this.epoch++;this.quotes.disconnect();}if(!this.visible&&value&&!this.quoteFailures)this.quoteDue=0;this.visible=value;}
  disconnect(){this.epoch++;this.quotes.disconnect();this.connected=false;this.auto=false;this.success=false;this.failures=0;this.due=0;this.invalidate();this.diagnostic={stage:'disconnected',code:'USER_DISCONNECTED'};this.message='已断开；不再发送新请求，在途SDK请求无法撤回，迟到结果不发布';}
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
  async tick(){
    // 一个调度器、全局单飞。余额到期优先；公开行情不读取凭据，也不依赖余额TTL。
    if(this.auto&&this.retry().canRetry&&this.now()>=this.due){await this.sync();return;}
    if(this.success&&this.retry(true).canRetry&&this.now()>=this.quoteDue)await this.refreshQuotes();
  }
  private rememberValuation(){
    const value=this.valued();
    if(value.report.coveredSubtotal!==null&&(value.report.coverage==='complete'||this.reference?.report.coverage!=='complete'))this.reference={...value,at:new Date(this.now()).toISOString()};
  }
  private async request(req:NetworkRequest,epoch:number,publicOnly=false):Promise<unknown>{
    if(publicOnly&&!(req.method==='GET'&&[PUBLIC_ORIGIN+'/api/v3/time','https://api.binance.com/api/v3/time'].includes(req.url)&&!req.headers&&!req.body))throw new SpotError('invalid');
    if((!this.connected&&!publicOnly)||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
    const began=this.monotonic(),elapsed=()=>Math.max(0,Math.round((this.monotonic()-began)*1000)/1000);
    this.lastRequest=undefined;
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
      const response=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new DirectRequestError(new SpotError('timeout'),'plugin-timer',elapsed())),this.timeout);})]);
      if((!this.connected&&!publicOnly)||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
      if(!Number.isInteger(response.status)||response.status<100||response.status>599)throw new DirectRequestError(new SpotError('invalid'),'http-response',elapsed(),undefined,undefined,{layer:'response',path:'$response',reason:'HTTP_STATUS_INVALID'});
      this.lastRequest={elapsedMs:elapsed(),httpStatus:response.status};
      let data:unknown,parsed=false,jsonValid:boolean|undefined,jsonReason:SpotValidationDetails['reason']='RESPONSE_BODY_NOT_TEXT';
      if(typeof response.body==='string'){
        jsonReason='RESPONSE_TOO_LARGE';
        if(response.body.length<=2*1024*1024&&new TextEncoder().encode(response.body).byteLength<=2*1024*1024){
          try{data=JSON.parse(response.body);parsed=true;jsonValid=true;}catch{jsonValid=false;jsonReason='JSON_INVALID';}
        }
      }
      this.lastRequest.jsonValid=jsonValid;
      const rawCode=data&&typeof data==='object'&&!Array.isArray(data)?(data as {code?:unknown}).code:undefined;
      const exchangeCode=Number.isSafeInteger(rawCode)?rawCode as number:undefined;
      const retryHeader=Object.entries(response.headers??{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1];
      try{
        classifyResponse({status:response.status,data:exchangeCode===undefined?null:{code:exchangeCode},headers:{'Retry-After':retryHeader??''}});
        if(!parsed)throw new SpotValidationError({layer:'json',path:'$',reason:jsonReason});
      }catch(e){throw new DirectRequestError(e instanceof SpotError?e:new SpotError('invalid'),'http-response',elapsed(),response.status,exchangeCode,e instanceof SpotValidationError?e.validation:{layer:'response',path:'$response',reason:'HTTP_REJECTED'},jsonValid);}
      return data;
    }catch(e){throw e instanceof SpotError?e:new DirectRequestError(new SpotError('network'),'host-call',elapsed());}finally{clearTimeout(timer);}
  }
  private failureDetails(e:unknown):Partial<DirectDiagnostic>{
    if(e instanceof DirectRequestError)return {layer:e.layer,elapsedMs:e.elapsedMs,...(e.httpStatus===undefined?{}:{httpStatus:e.httpStatus}),...(e.exchangeCode===undefined?{}:{exchangeCode:e.exchangeCode}),...(e.validation?{validation:{...e.validation}}:{}),...(typeof e.jsonValid==='boolean'?{jsonValid:e.jsonValid}:{})};
    if(e instanceof SpotValidationError)return {layer:e.validation.layer==='snapshot'?'snapshot-validation':'account-validation',validation:{...e.validation},...(this.lastRequest?{httpStatus:this.lastRequest.httpStatus,elapsedMs:this.lastRequest.elapsedMs,...(typeof this.lastRequest.jsonValid==='boolean'?{jsonValid:this.lastRequest.jsonValid}:{})}:{})};
    if(e instanceof ClockError)return {layer:'clock-validation',clock:{...e.details},...(e.details.elapsedMs===undefined?{}:{elapsedMs:e.details.elapsedMs}),...(this.lastRequest?{httpStatus:this.lastRequest.httpStatus}:{})};
    return {};
  }
  private failureCode(e:unknown){return e instanceof DirectRequestError&&e.layer==='host-call'?'HOST_REQUEST_FAILED':e instanceof SpotError?`SPOT_${e.code.toUpperCase().replaceAll('-','_')}`:'INVALID_RESPONSE';}
  private async timeSample(host:TimeObservation['host'],attempt:number,epoch:number,rows:TimeObservation[],publicOnly=false){
    const start=this.now(),mono=this.monotonic();
    try{
      const body=await this.request({method:'GET',url:(host==='MARKET'?PUBLIC_ORIGIN:'https://api.binance.com')+'/api/v3/time',timeoutSecs:10},epoch,publicOnly);
      const offset=calibrateTime(body,start,this.now(),this.monotonic()-mono);
      rows.push({host,attempt,code:'OK',elapsedMs:this.lastRequest!.elapsedMs,httpStatus:200,serverTimeValid:true,offsetMs:offset});
      return offset;
    }catch(e){
      const d=this.failureDetails(e);
      rows.push({host,attempt,code:this.failureCode(e),...(d.layer?{layer:d.layer}:{}),...(d.elapsedMs===undefined?{}:{elapsedMs:d.elapsedMs}),...(d.httpStatus===undefined?{}:{httpStatus:d.httpStatus}),...(d.exchangeCode===undefined?{}:{exchangeCode:d.exchangeCode}),...(e instanceof ClockError?{serverTimeValid:e.details.serverTimeValid,reason:e.details.reason,...(e.details.offsetMs===undefined?{}:{offsetMs:e.details.offsetMs})}:{})});
      throw e;
    }
  }
  private async calibrate(epoch:number){
    this.timeObservations=[];let last:unknown;
    for(let attempt=1;attempt<=3;attempt++){
      // 使用认证同一主机；首个合格样本即可签名，不再为优选RTT引入额外失败点。
      try{return await this.timeSample('SPOT',attempt,epoch,this.timeObservations);}
      catch(e){
        const retryable=e instanceof ClockError&&e.details.reason==='CLOCK_SAMPLE_SLOW'||
          e instanceof DirectRequestError&&(e.layer==='host-call'||e.layer==='http-response'&&e.code==='network'&&e.httpStatus!==undefined&&e.httpStatus>=500);
        if(!retryable||this.pending||!this.connected||!this.visible||epoch!==this.epoch)throw e;
        last=e;
      }
    }
    throw last;
  }
  // 仅固定公开time；不读取secrets，不授权会话，不发私人请求，不持久化结果。
  async testPublicTime(){
    if(this.connected||this.busy||this.pending||this.quotes.isBusy()||!this.visible)throw new SpotError('busy');
    if(Math.max(this.cooldownUntil,this.quotes.getCooldownUntil())>this.now())throw new SpotError('rate-limit');
    this.busy=true;const epoch=this.epoch;this.publicObservations=[];
    try{
      for(const host of ['MARKET','SPOT'] as const){
        for(let attempt=1;attempt<=3;attempt++){
          try{await this.timeSample(host,attempt,epoch,this.publicObservations,true);}
          catch(e){if(e instanceof ClockError)continue;if(this.pending||e instanceof SpotError&&['rate-limit','disconnected'].includes(e.code))return;break;}
        }
      }
    }finally{this.busy=false;}
  }
  async sync(){
    if(this.busy||this.pending||this.quotes.isBusy())throw new SpotError('busy');
    if(!this.connected||!this.visible)throw new SpotError('disconnected');
    if(!this.retry().canRetry)throw new SpotError(this.retry().reason==='exchange-limit'?'rate-limit':'busy');
    this.busy=true;const epoch=this.epoch;
    const mark=(stage:DirectStage)=>{if(epoch===this.epoch)this.diagnostic={stage,code:'RUNNING'};};
    try{
      mark('credentials');
      const pair=await this.credentials.read();if(!pair)throw new SpotError('auth');
      if(pair.apiKey.startsWith('WRISK_')||pair.secret.startsWith('WRISK_'))throw new SpotError('auth');
      mark('clock');
      const offset=await this.calibrate(epoch);
      mark('permissions');
      const permission=await this.request(restrictionRequest(pair.apiKey,pair.secret,Math.floor(this.now()+offset)),epoch);
      try{assertReadOnly(permission);}catch(e){this.disconnect();this.diagnostic={stage:'permissions',code:'READ_ONLY_REJECTED',...(e instanceof ReadOnlyError?{permissionReason:e.code,permissionFields:e.fields}:{})};throw new Error('只读检查未通过，已停止');}
      mark('balance');
      const began=this.now();
      const body=await this.request({...buildOfflineReadRequest('spot',pair.apiKey,pair.secret,Math.floor(began+offset)),timeoutSecs:10},epoch);
      const ended=this.now();if(ended<began||ended-began>30_000)throw new SpotError('clock');
      let parsed:ReturnType<typeof spotSnapshot>;
      try{parsed=spotSnapshot(body,'external',new Date(began).toISOString(),new Date(ended).toISOString());}
      catch(e){throw e instanceof SpotValidationError?e:new SpotValidationError({layer:'snapshot',path:'snapshot',reason:'SNAPSHOT_BUILD_FAILED'});}
      const {account,snapshot}=parsed;
      if(account.sourceAccountId!==this.uid){this.disconnect();this.diagnostic={stage:'identity',code:'UID_MISMATCH'};throw new Error('返回UID与预期不符；已停止，不接纳该账户资产');}
      if(!this.connected||!this.visible||epoch!==this.epoch)throw new SpotError('disconnected');
      // 余额独立发布。首次连接不请求行情，估值不能延迟或阻止可靠数量进入界面。
      this.diagnostic={stage:'complete',code:'OK',...this.lastRequest};
      this.state={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:snapshot.asOf}}};
      this.success=true;this.failures=0;this.due=this.now()+DIRECT_INTERVAL;this.message='真实Spot快照已替换；请核对数量、来源和缺口。未写主程序账本';
      this.quoteDue=0;this.quoteFailures=0;this.rememberValuation();
    }catch(e){
      if(epoch===this.epoch){
        const failedAt=this.diagnostic.stage;
        this.invalidate();this.failures++;const code=e instanceof SpotError?e.code:null;
        if(code==='rate-limit'){this.failures=0;this.due=0;}
        else this.due=this.now()+Math.min(DIRECT_INTERVAL*2**Math.min(this.failures,3),1_800_000);
        if(code&&['auth','forbidden','signature','invalid','clock'].includes(code))this.disconnect();
        this.diagnostic={stage:failedAt,code:this.failureCode(e),...this.failureDetails(e)};
        this.message=code?`真实Spot读取失败：${e instanceof SpotError?e.message:'不可用'}；历史数据不可作当前资产`:this.message;
      }else {
        if(!['READ_ONLY_REJECTED','UID_MISMATCH','USER_DISCONNECTED'].includes(this.diagnostic.code))this.diagnostic={stage:'disconnected',code:'PAGE_PAUSED'};
        if(!this.connected)this.message='已停止：权限/UID/连接核对未通过，或本人已断开；当前不可用';
      }
      // 不透传URL、header、body、原始异常或cause；宿主事先日志风险仍存在。
    }finally{this.busy=false;}
  }
  async refreshQuotes(){
    if(!this.success||!this.retry(true).canRetry)throw new SpotError('busy');
    this.busy=true;const epoch=this.epoch;this.diagnostic={stage:'quotes',code:'RUNNING'};
    try{
      const state=this.getState(),account=state.accounts[0],snapshot=account?state.snapshots[account.id]:undefined;
      if(!account||!snapshot||snapshot.dataMode!=='external')throw new SpotError('invalid');
      const result=await this.quotes.refreshSpotAssets(snapshot.positions.map(position=>position.asset.code));
      const codes={complete:'QUOTE_COMPLETE',partial:'QUOTE_PARTIAL','request-failed':'QUOTE_REQUEST_FAILED','no-market':'QUOTE_NO_MARKET','no-candidates':'QUOTE_NO_CANDIDATES','budget-limited':'QUOTE_BUDGET_LIMITED'} as const;
      if(this.connected&&this.visible&&epoch===this.epoch){
        this.diagnostic={stage:'quotes',code:codes[result.status],quote:result};
        this.quoteFailures=result.failedRequestCount?this.quoteFailures+1:0;
        if(result.pricedCount>0||result.status==='no-candidates')this.rememberValuation();
      }
    }catch(error){
      const code=error instanceof PublicMarketError?({
        network:'QUOTE_REQUEST_FAILED',timeout:'QUOTE_TIMEOUT','rate-limit':'QUOTE_RATE_LIMIT',invalid:'QUOTE_INVALID',disconnected:'QUOTE_DISCONNECTED',busy:'QUOTE_BUSY'
      } as const)[error.code]:'QUOTES_UNAVAILABLE';
      if(this.connected&&this.visible&&epoch===this.epoch){this.diagnostic={stage:'quotes',code};this.quoteFailures++;}
    }finally{this.busy=false;this.quoteDue=this.now()+Math.min(QUOTE_INTERVAL*2**Math.min(this.quoteFailures,3),300_000);}
  }
  valued(){
    const now=this.now(),state=this.getState(),a=state.accounts[0];
    if(a&&state.snapshots[a.id])state.snapshots[a.id]=mergeDynamicPublicSpotPrices(a,state.snapshots[a.id],this.quotes.getSpotQuotes(),now,QUOTE_TTL);
    const shocks=Object.fromEntries(Object.values(state.snapshots).flatMap(s=>s.positions.map(p=>[assetKey(p.asset),spotShock(p.asset.code)])));
    return {state,report:calculateRisk(state,'USDT',[],shocks,{now:new Date(now).toISOString(),balanceMaxAgeMs:DIRECT_TTL,priceMaxAgeMs:QUOTE_TTL,fxMaxAgeMs:DIRECT_TTL})};
  }
}
