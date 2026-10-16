import type { NetworkRequest } from '@wealthfolio/addon-sdk';
import { buildOfflineReadRequest } from './binance';
import { DummyCredentials, DUMMY, requestAuthenticated } from './credentials';
import { parseUsdtMarkets, publicTickerRequest, parseTickerPrices } from './spot-quotes';
import { applyBatch, assetKey, calculateRisk, DEFAULT_FRESHNESS, nonnegative, validateSnapshot, SnapshotValidationError, SNAPSHOT_REASONS, type Account, type PortfolioState, type Snapshot } from './domain';

// 只读意图白名单。没有可注入的路径、主机、方法或交易参数。
export const SPOT_PATHS = { time: '/api/v3/time', account: '/api/v3/account', price: '/api/v3/ticker/price', exchangeInfo:'/api/v3/exchangeInfo' } as const;
export type SpotErrorCode = 'auth'|'forbidden'|'rate-limit'|'signature'|'clock'|'timeout'|'network'|'invalid'|'disconnected'|'busy';
const MESSAGES: Record<SpotErrorCode,string> = {
  auth:'认证或只读权限失败', forbidden:'访问受限或 WAF 拒绝，不自动重试', 'rate-limit':'请求限流，等待冷却后再操作',
  signature:'签名校验失败', clock:'服务器时间校准无效或时间窗口过期', timeout:'读取超时', network:'网络读取失败',
  invalid:'响应不完整或字段无效', disconnected:'已断开或没有固定假凭据', busy:'同步进行中'
};
export class SpotError extends Error {
  constructor(readonly code: SpotErrorCode, readonly retryAfterSeconds?: number) { super(MESSAGES[code]); }
}
export interface MockResponse { status: number; data: unknown; headers?: Record<string,string> }
export interface MockTransport { readonly mode: 'fixture'; request(request: NetworkRequest, signal: AbortSignal): Promise<MockResponse> }
const mocks=new WeakSet<object>();
// 此工厂只供固定响应/故障替身，不接收宿主 API。标记不是对任意插件代码的安全沙箱。
export function createMockTransport(handler: MockTransport['request']): MockTransport {
  const transport=Object.freeze({mode:'fixture' as const,request:handler}); mocks.add(transport); return transport;
}
export function classifyResponse(response: MockResponse): void {
  const code=(response.data && typeof response.data==='object') ? (response.data as {code?:unknown}).code : undefined;
  const retry=Number(response.headers?.['Retry-After'] ?? response.headers?.['retry-after']);
  if (response.status===429 || response.status===418) throw new SpotError('rate-limit',Number.isSafeInteger(retry)&&retry>0&&retry<=86400?retry:60);
  // -2008未列于当前币安公开错误表；CCXT币安适配器将其归类为认证错误。
  if (response.status===401 || code===-2008 || code===-2014 || code===-2015) throw new SpotError('auth');
  if (response.status===403) throw new SpotError('forbidden');
  if (code===-1022) throw new SpotError('signature');
  if (code===-1021) throw new SpotError('clock');
  if (response.status>=500) throw new SpotError('network');
  if (code===-1121) throw new SpotError('invalid');
  if (response.status!==200 || typeof code==='number' && code<0) throw new SpotError('invalid');
}
export type ClockReason='SERVER_TIME_INVALID'|'LOCAL_CLOCK_CHANGED'|'CLOCK_SAMPLE_SLOW'|'CLOCK_OFFSET_EXCESSIVE';
export interface ClockDetails {reason:ClockReason;serverTimeValid:boolean;elapsedMs?:number;offsetMs?:number}
export class ClockError extends SpotError {
  constructor(readonly details:ClockDetails){super('clock');}
}
export function calibrateTime(data: unknown, started: number, ended: number, monotonicElapsed=ended-started): number {
  const time=(data as {serverTime?:unknown})?.serverTime;
  const serverTimeValid=Number.isSafeInteger(time)&&(time as number)>0;
  const elapsedMs=Number.isFinite(monotonicElapsed)&&monotonicElapsed>=0?Math.round(monotonicElapsed*1000)/1000:undefined;
  const fail=(reason:ClockReason,offsetMs?:number):never=>{throw new ClockError({reason,serverTimeValid,...(elapsedMs===undefined?{}:{elapsedMs}),...(offsetMs===undefined?{}:{offsetMs})});};
  if(!serverTimeValid)fail('SERVER_TIME_INVALID');
  // Unix时间只用于签名偏移；单调耗时用于样本质量，并以250ms容差检测墙钟跳变。
  if(!Number.isSafeInteger(started)||!Number.isSafeInteger(ended)||ended<started||elapsedMs===undefined||Math.abs((ended-started)-monotonicElapsed)>250)fail('LOCAL_CLOCK_CHANGED');
  if(monotonicElapsed>2000||ended-started>2000)fail('CLOCK_SAMPLE_SLOW');
  const offset=(time as number)-Math.floor((started+ended)/2);
  // 保守限制；不是对交易所时钟真实性的证明。
  if (Math.abs(offset)>60_000)fail('CLOCK_OFFSET_EXCESSIVE',offset);
  return offset;
}
export function publicSpotRequest(kind: 'time'|'price'|'exchangeInfo', symbol?: string): NetworkRequest {
  if (!['time','price','exchangeInfo'].includes(kind) || kind==='price' && (!symbol || !/^[A-Z0-9]{2,40}$/.test(symbol)) || kind!=='price' && symbol!==undefined) throw new SpotError('invalid');
  return {method:'GET',url:`https://api.binance.com${SPOT_PATHS[kind]}${kind==='price'?'?symbol='+symbol:''}`};
}
// 只校验实际使用字段，忽略而不保留上游多余字段；updateTime 是账户更新时间，不冒充余额采集时刻。
export const SPOT_VALIDATION_REASONS=['HTTP_STATUS_INVALID','HTTP_REJECTED','RESPONSE_BODY_NOT_TEXT','RESPONSE_TOO_LARGE','JSON_INVALID','OBJECT_REQUIRED','FIELD_MISSING','UID_NOT_SAFE_POSITIVE_INTEGER','ACCOUNT_TYPE_NOT_SPOT','ARRAY_REQUIRED','COLLECTION_LIMIT','ASSET_ID_INVALID','FIXTURE_IDENTITY_FORBIDDEN','DUPLICATE_ASSET','DECIMAL_STRING_REQUIRED','DECIMAL_LENGTH_LIMIT','DECIMAL_INVALID','SNAPSHOT_BUILD_FAILED',...SNAPSHOT_REASONS] as const;
export interface SpotValidationDetails {layer:'response'|'json'|'account'|'balance'|'snapshot';path:string;reason:typeof SPOT_VALIDATION_REASONS[number]}
export class SpotValidationError extends SpotError {
  constructor(readonly validation:SpotValidationDetails){super('invalid');}
}
export function isSafeValidationPath(path:unknown):path is string {
  return typeof path==='string'&&/^(?:\$(?:response)?|uid|accountType|balances(?:\[\d{1,4}\](?:\.(?:asset|free|locked))?)?|snapshot(?:\.(?:batchId|asOf|dataMode|collection(?:StartedAt|EndedAt)?|positions(?:\[\d{1,4}\]\.(?:asset|quantity|price(?:\.value)?))?))?)$/.test(path);
}
export function validateSpotAccount(data: unknown) {
  const fail=(reason:SpotValidationDetails['reason'],path:string,layer:SpotValidationDetails['layer']='account'):never=>{throw new SpotValidationError({layer,path,reason});};
  const body=data as {uid?:unknown;accountType?:unknown;balances?:unknown;updateTime?:unknown};
  if(!body||typeof body!=='object'||Array.isArray(body))fail('OBJECT_REQUIRED','$');
  if(body.uid===undefined)fail('FIELD_MISSING','uid');
  if(!Number.isSafeInteger(body.uid)||(body.uid as number)<=0)fail('UID_NOT_SAFE_POSITIVE_INTEGER','uid');
  if(body.accountType===undefined)fail('FIELD_MISSING','accountType');
  if(body.accountType!=='SPOT')fail('ACCOUNT_TYPE_NOT_SPOT','accountType');
  if(body.balances===undefined)fail('FIELD_MISSING','balances');
  if(!Array.isArray(body.balances))fail('ARRAY_REQUIRED','balances');
  const rawBalances=body.balances as unknown[];
  if(rawBalances.length>10_000)fail('COLLECTION_LIMIT','balances');
  const seen=new Set<string>();
  const balances=rawBalances.map((value,index)=> {
    const path=`balances[${index}]`;
    if(!value||typeof value!=='object'||Array.isArray(value))fail('OBJECT_REQUIRED',path,'balance');
    const row=value as Record<string,unknown>;
    if(row.asset===undefined)fail('FIELD_MISSING',path+'.asset','balance');
    // 官方允许UTF8资产名；仅施加资源/不可见字符边界，不规范化、不改大小写或前缀。
    if(typeof row.asset!=='string'||!row.asset.length||row.asset.length>256||[...row.asset].length>128||new TextEncoder().encode(row.asset).byteLength>256||/[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(row.asset))fail('ASSET_ID_INVALID',path+'.asset','balance');
    const asset=row.asset as string;
    if(asset.startsWith('WRISKDEMO'))fail('FIXTURE_IDENTITY_FORBIDDEN',path+'.asset','balance');
    if(seen.has(asset))fail('DUPLICATE_ASSET',path+'.asset','balance');
    seen.add(asset);
    const decimal=(field:'free'|'locked')=>{
      const value=row[field],fieldPath=path+'.'+field;
      if(value===undefined)fail('FIELD_MISSING',fieldPath,'balance');
      if(typeof value!=='string')fail('DECIMAL_STRING_REQUIRED',fieldPath,'balance');
      if((value as string).length>80)fail('DECIMAL_LENGTH_LIMIT',fieldPath,'balance');
      try{return nonnegative(value as string).toFixed();}catch{ return fail('DECIMAL_INVALID',fieldPath,'balance'); }
    };
    return {asset,free:decimal('free'),locked:decimal('locked')};
  });
  return {uid:String(body.uid),balances};
}
export function spotSnapshot(data: unknown, mode: 'fixture'|'external', startedAt: string, endedAt: string): {account: Account; snapshot: Snapshot} {
  if (mode!=='fixture' && mode!=='external') throw new SpotValidationError({layer:'snapshot',path:'snapshot.dataMode',reason:'SNAPSHOT_SOURCE_INVALID'});
  if (!Number.isFinite(Date.parse(startedAt))) throw new SpotValidationError({layer:'snapshot',path:'snapshot.collectionStartedAt',reason:'SNAPSHOT_COLLECTION_INVALID'});
  if (!Number.isFinite(Date.parse(endedAt)) || Date.parse(startedAt)>Date.parse(endedAt)) throw new SpotValidationError({layer:'snapshot',path:'snapshot.collectionEndedAt',reason:'SNAPSHOT_COLLECTION_INVALID'});
  const body=validateSpotAccount(data), owner=mode==='fixture'?`fixture:${body.uid}`:body.uid;
  const account:Account={id:`${mode}:binance:${body.uid}:spot`,platform:'binance',sourceAccountId:owner,name:mode==='fixture'?'Binance 单账号（离线模拟 Spot）':'Binance Spot',kind:'spot',currency:'USDT'};
  const snapshot:Snapshot={accountId:account.id,batchId:`${mode}:spot:${endedAt}`,asOf:endedAt,collectionStartedAt:startedAt,collectionEndedAt:endedAt,dataMode:mode,
    positions:body.balances.map(row=>({asset:{venue:'BINANCE',code:row.asset,type:mode==='fixture' && ['BTC','ETH','BNB','SOL','USDT'].includes(row.asset)?'crypto' as const:'unknown' as const,quoteCurrency:'USDT'},quantity:nonnegative(row.free).add(row.locked).toFixed(),balanceComponents:{free:row.free,locked:row.locked}})).filter(p=>p.quantity!=='0')};
  try{validateSnapshot(snapshot);}catch(e){throw new SpotValidationError(e instanceof SnapshotValidationError?{layer:'snapshot',path:e.path,reason:e.reason}:{layer:'snapshot',path:'snapshot',reason:'SNAPSHOT_BUILD_FAILED'});} return {account,snapshot};
}
export const spotShock=(assetCode:string):string=>assetCode==='USDT'?'0':'-0.2';
export function spotRisk(state: PortfolioState, now: number, base='USDT') {
  const shocks: Record<string,string>={};
  for (const s of Object.values(state.snapshots)) for (const p of s.positions) shocks[assetKey(p.asset)]=spotShock(p.asset.code);
  return calculateRisk(state,base,[],shocks,{now:new Date(now).toISOString(),...DEFAULT_FRESHNESS,enforceFixtureFreshness:true});
}

// 单次、单账号、仅内存；不自动保存假凭据、不用旧报价补失败的新报价、不重试认证或限流。
export class SpotOfflineReader {
  private state:PortfolioState={schemaVersion:1,accounts:[],snapshots:{},statuses:{}};
  private busy=false;
  private epoch=0;
  private cooldownUntil=0;
  constructor(private readonly credentials: DummyCredentials, private readonly transport: MockTransport, private readonly now=Date.now, private readonly timeoutMs=5000) {
    if (!mocks.has(transport) || !Number.isFinite(timeoutMs) || timeoutMs<=0 || timeoutMs>5000) throw new SpotError('invalid');
  }
  getState():PortfolioState {return structuredClone(this.state);}
  disconnect():void {
    this.epoch++;
    for (const id of Object.keys(this.state.statuses)) this.state.statuses[id]={state:'failed',attemptedAt:new Date(this.now()).toISOString(),reason:MESSAGES.disconnected};
  }
  // 真实入口没有传输参数；始终使用 v0.1.3 的阻断门，不能把本模拟实例当真实连接。
  async requestReal():Promise<never> {return requestAuthenticated();}
  private async request(request:NetworkRequest, epoch:number):Promise<MockResponse> {
    if (epoch!==this.epoch) throw new SpotError('disconnected');
    const abort=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const response=await Promise.race([this.transport.request(request,abort.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new SpotError('timeout'));},this.timeoutMs);})]);
      if (epoch!==this.epoch) throw new SpotError('disconnected');
      classifyResponse(response); return response;
    } catch (e) {throw e instanceof SpotError?e:new SpotError('network');}
    finally {if(timer!==undefined)clearTimeout(timer);}
  }
  async sync():Promise<PortfolioState> {
    if(this.busy)throw new SpotError('busy');
    if(this.now()<this.cooldownUntil)throw new SpotError('rate-limit',Math.ceil((this.cooldownUntil-this.now())/1000));
    this.busy=true; const epoch=this.epoch;
    try {
      const credential=await this.credentials.read();
      if (epoch!==this.epoch || !credential)throw new SpotError('disconnected');
      // 即使调用方错误替换凭据读取器，也不允许真实密钥进入这个模拟链路。
      if (!Object.values(DUMMY).some(d=>d.apiKey===credential.apiKey && d.secret===credential.secret))throw new SpotError('disconnected');
      const timeStart=this.now(), time=await this.request(publicSpotRequest('time'),epoch), timeEnd=this.now();
      const offset=calibrateTime(time.data,timeStart,timeEnd);
      const started=this.now();
      if (started<timeEnd || started-timeEnd>30_000) throw new SpotError('clock');
      const response=await this.request(buildOfflineReadRequest('spot',credential.apiKey,credential.secret,Math.floor(started+offset)),epoch);
      const ended=this.now();
      const {account,snapshot}=spotSnapshot(response.data,'fixture',new Date(started).toISOString(),new Date(ended).toISOString());
      if (this.state.accounts.length && this.state.accounts[0].sourceAccountId!==account.sourceAccountId) throw new SpotError('invalid');
      for (const p of snapshot.positions) if(p.asset.code==='USDT') p.price={value:'1',currency:'USDT',asOf:snapshot.asOf,source:'fixture:同币种计价单位'};
      if(snapshot.positions.some(p=>p.asset.code!=='USDT')) {
        try {
          const info=await this.request(publicSpotRequest('exchangeInfo'),epoch), markets=parseUsdtMarkets(info.data);
          const symbols=snapshot.positions.flatMap(p=>markets.has(p.asset.code)?[markets.get(p.asset.code)!]:[]);
          // 最多 100 个 symbols 一批；较大组合不丢资产，也不降级为全市场请求。
          for(let i=0;i<symbols.length;i+=100) {
            const requested=symbols.slice(i,i+100);
            const quote=await this.request(publicTickerRequest(requested),epoch);
            const prices=parseTickerPrices(quote.data,requested,new Date(this.now()).toISOString(),'fixture');
            for(const p of snapshot.positions) {const symbol=markets.get(p.asset.code);if(symbol && prices.has(symbol))p.price=prices.get(symbol);}
          }
        } catch(e) {
          if (e instanceof SpotError && e.code==='rate-limit') {this.cooldownUntil=this.now()+(e.retryAfterSeconds??60)*1000;}
          if (e instanceof SpotError && e.code==='disconnected')throw e;
          // 行情失败保留数量，未取得的新报价不沿用旧值；先前成功批次明确只属部分覆盖。
        }
      }
      if(epoch!==this.epoch)throw new SpotError('disconnected');
      const prior:PortfolioState=this.state.accounts.length?this.state:{schemaVersion:1,accounts:[account],snapshots:{},statuses:{}};
      this.state=applyBatch(prior,[account.id],[{accountId:account.id,snapshot}],snapshot.asOf);
      return this.getState();
    } catch(e) {
      const error=e instanceof SpotError?e:new SpotError('invalid');
      if(error.code==='rate-limit')this.cooldownUntil=this.now()+(error.retryAfterSeconds??60)*1000;
      for(const a of this.state.accounts)this.state.statuses[a.id]={state:'failed',attemptedAt:new Date(this.now()).toISOString(),reason:error.message};
      throw error; // 固定分类，不透传 body、URL、header 或原异常 cause。
    } finally {this.busy=false;}
  }
}
