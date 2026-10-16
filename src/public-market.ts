import type { NetworkAPI, NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';
import { assetKey, calculateRisk, validateSnapshot, type Account, type PortfolioState, type Snapshot } from './domain';
import { parseTickerPrices, parseUsdtMarkets, publicTickerRequest } from './spot-quotes';

export const PUBLIC_ORIGIN='https://data-api.binance.vision';
export const PUBLIC_TTL_MS=120_000;
const QUANTITIES={BTC:'0.4',ETH:'2',BNB:'10',SOL:'20',DOGE:'1000',USDT:'4000'} as const;
const ID='fixture:public-quotes:spot';
type Code='network'|'timeout'|'rate-limit'|'invalid'|'disconnected'|'busy';
const messages:Record<Code,string>={network:'公开行情网络请求失败；旧报价仅供历史参考',timeout:'公开行情读取超时；旧报价仅供历史参考','rate-limit':'公开行情限流；冷却后手动重试',invalid:'公开行情响应无效或不完整',disconnected:'公开行情已断开；当前报价不可用',busy:'已有公开请求尚未结束，请等待'};
export class PublicMarketError extends Error {constructor(readonly code:Code){super(messages[code]);}}

// 固定构造；调用者不能提供 URL/header/body/auth 或任意参数。
export function publicMarketRequest(endpoint:'time'|'exchangeInfo'|'price',symbols?:string[]):NetworkRequest {
  if(!['time','exchangeInfo','price'].includes(endpoint) || endpoint!=='price' && symbols!==undefined)throw new PublicMarketError('invalid');
  if(endpoint==='price') {
    const path=new URL(publicTickerRequest(symbols??[]).url);
    return {method:'GET',url:`${PUBLIC_ORIGIN}${path.pathname}${path.search}`,timeoutSecs:10};
  }
  // 五个固定市场避免 exchangeInfo 全市场超过宿主2MiB响应上限。
  const query=endpoint==='exchangeInfo'?`?${new URLSearchParams({symbols:JSON.stringify(['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','DOGEUSDT'])})}`:'';
  return {method:'GET',url:`${PUBLIC_ORIGIN}/api/v3/${endpoint}${query}`,timeoutSecs:10};
}

const empty=():PortfolioState=>({schemaVersion:1,accounts:[{id:ID,platform:'binance',sourceAccountId:'public-quotes-fixture',name:'模拟持仓 × 真实市场报价',kind:'spot',currency:'USDT'}],snapshots:{},statuses:{[ID]:{state:'uncovered',attemptedAt:new Date(0).toISOString()}}});
export class PublicMarketReader {
  private state=empty(); private busy=false; private pending=false; private epoch=0;
  private cooldownUntil=0; private serverTime:string|null=null;
  constructor(private network:Pick<NetworkAPI,'request'>,private now=Date.now,private timeoutMs=15_000) {}
  getState(){return structuredClone(this.state);}
  getServerTime(){return this.serverTime;}
  getCooldownUntil(){return this.cooldownUntil;}
  isBusy(){return this.busy||this.pending;}
  disconnect(){this.epoch++;this.state.statuses[ID]={state:'failed',attemptedAt:new Date(this.now()).toISOString(),reason:messages.disconnected};}
  simulateNetworkFailure(){this.disconnect();this.state.statuses[ID].reason=messages.network;}
  private async request(request:NetworkRequest,epoch:number):Promise<unknown> {
    if(epoch!==this.epoch)throw new PublicMarketError('disconnected');
    let timer:ReturnType<typeof setTimeout>|undefined;
    this.pending=true;
    const operation=Promise.resolve().then(()=>this.network.request(request)).then(response=>{
      // 限流是传输层事实：超时/隐藏/断开后才收到也必须保留，不能重连绕过。
      if(response.status===429||response.status===418){
        const retry=Number(Object.entries(response.headers??{}).find(([key])=>key.toLowerCase()==='retry-after')?.[1]);
        const seconds=Number.isSafeInteger(retry)&&retry>0?Math.min(retry,Math.floor((Number.MAX_SAFE_INTEGER-this.now())/1000)):(response.status===418?1800:60);
        this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+seconds*1000);
      }
      return response;
    }).finally(()=>{this.pending=false;});
    let response:NetworkResponse;
    try {response=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PublicMarketError('timeout')),this.timeoutMs);})]);}
    catch(e){throw e instanceof PublicMarketError?e:new PublicMarketError('network');}
    finally{clearTimeout(timer);}
    if(epoch!==this.epoch)throw new PublicMarketError('disconnected');
    if(response.status===429 || response.status===418) {
      throw new PublicMarketError('rate-limit');
    }
    if(response.status!==200)throw new PublicMarketError('network');
    if(typeof response.body!=='string' || response.body.length>2*1024*1024)throw new PublicMarketError('invalid');
    try{return JSON.parse(response.body);}catch{throw new PublicMarketError('invalid');}
  }
  async refresh():Promise<PortfolioState> {
    if(this.busy || this.pending)throw new PublicMarketError('busy');
    if(this.now()<this.cooldownUntil)throw new PublicMarketError('rate-limit');
    this.busy=true; const epoch=this.epoch, started=this.now();
    try {
      const clock=await this.request(publicMarketRequest('time'),epoch) as {serverTime?:unknown};
      if(!clock || !Number.isSafeInteger(clock.serverTime) || (clock.serverTime as number)<=0 || !Number.isFinite(new Date(clock.serverTime as number).getTime()))throw new PublicMarketError('invalid');
      const serverTime=new Date(clock.serverTime as number).toISOString();
      const markets=parseUsdtMarkets(await this.request(publicMarketRequest('exchangeInfo'),epoch));
      const symbols=Object.keys(QUANTITIES).flatMap(code=>markets.has(code)?[markets.get(code)!]:[]);
      if(!symbols.length)throw new PublicMarketError('invalid');
      const payload=await this.request(publicMarketRequest('price',symbols),epoch), ended=this.now();
      if(ended<started || ended-started>PUBLIC_TTL_MS)throw new PublicMarketError('invalid');
      const at=new Date(ended).toISOString(), prices=parseTickerPrices(payload,symbols,at,'external');
      if(epoch!==this.epoch)throw new PublicMarketError('disconnected');
      const positions=Object.entries(QUANTITIES).map(([code,quantity])=> {
        const price=code==='USDT'?{value:'1',currency:'USDT',asOf:at,source:'fixture:USDT同币种计价单位'}:prices.get(markets.get(code)??'');
        return {asset:{venue:'BINANCE',code,type:'crypto' as const,quoteCurrency:'USDT'},quantity,...(price?{price:{...price,source:code==='USDT'?price.source:`external:${PUBLIC_ORIGIN}/api/v3/ticker/price（采集时间，非成交时间）`}}:{})};
      });
      // 不读账户或凭据；数量是固定样例，本对象不保存/导出/写宿主。
      this.state={...empty(),snapshots:{[ID]:{accountId:ID,batchId:`fixture:public:${at}`,dataMode:'fixture',asOf:at,collectionStartedAt:new Date(started).toISOString(),collectionEndedAt:at,positions}},statuses:{[ID]:{state:'ready',attemptedAt:at}}};
      this.serverTime=serverTime; return this.getState();
    }catch(e){const error=e instanceof PublicMarketError?e:new PublicMarketError('invalid');this.state.statuses[ID]={state:'failed',attemptedAt:new Date(this.now()).toISOString(),reason:error.message};throw error;}
    finally{this.busy=false;}
  }
}
export function publicMarketRisk(state:PortfolioState,now:number) {
  const shocks=Object.fromEntries(Object.values(state.snapshots).flatMap(s=>s.positions.map(p=>[assetKey(p.asset),p.asset.code==='USDT'?'0':'-0.2'])));
  return calculateRisk(state,'USDT',[],shocks,{now:new Date(now).toISOString(),balanceMaxAgeMs:PUBLIC_TTL_MS,priceMaxAgeMs:PUBLIC_TTL_MS,fxMaxAgeMs:300_000,enforceFixtureFreshness:true});
}

// Merge only fresh public prices; simulated quote quantities never enter the external balance.
export function mergePublicSpotPrices(account: Account, balance: Snapshot, quoteState: PortfolioState, now: number, maxAgeMs=PUBLIC_TTL_MS): Snapshot {
  if (!Number.isFinite(now) || account.platform !== 'binance' || account.kind !== 'spot' ||
      !account.sourceAccountId || account.id.startsWith('demo-') || balance.accountId !== account.id ||
      balance.dataMode !== 'external' || !balance.collectionStartedAt || !balance.collectionEndedAt) {
    throw new Error('外部 Spot 余额来源无效');
  }
  return mergePublicSnapshotPrices(balance,quoteState,now,maxAgeMs);
}

// 共用报价赋值；来源标记保持原样，不把辅助程序测试数量变成真实余额。
export function mergePublicSnapshotPrices(balance: Snapshot, quoteState: PortfolioState, now: number, maxAgeMs=PUBLIC_TTL_MS): Snapshot {
  if(!Number.isFinite(now)||!Number.isFinite(maxAgeMs)||maxAgeMs<0||maxAgeMs>360_000)throw new Error('估值时间无效');
  validateSnapshot(balance);
  const quoteStatus = quoteState.statuses[ID];
  const quoteSnapshot = quoteState.snapshots[ID];
  const prices = new Map<string, NonNullable<Snapshot['positions'][number]['price']>>();
  if (quoteStatus?.state === 'ready' && quoteSnapshot?.dataMode === 'fixture') {
    for (const position of quoteSnapshot.positions) {
      const price = position.price;
      if (position.asset.venue !== 'BINANCE' || position.asset.type !== 'crypto' ||
          position.asset.quoteCurrency !== 'USDT' || !price || price.currency !== 'USDT' ||
          !price.source.startsWith('external:' + PUBLIC_ORIGIN + '/api/v3/ticker/price')) continue;
      const at = Date.parse(price.asOf);
      if (!Number.isFinite(at) || at > now || now - at > maxAgeMs) continue;
      prices.set(position.asset.code, price);
    }
  }
  const snapshot: Snapshot = {
    ...balance,
    positions: balance.positions.map(position => {
      const { price: _oldPrice, ...unpriced } = position;
      if (position.asset.code === 'USDT' && position.asset.quoteCurrency === 'USDT') {
        return { ...unpriced, price: { value: '1', currency: 'USDT', asOf: balance.collectionEndedAt!, source: 'unit:USDT/USDT' } };
      }
      if (position.asset.quoteCurrency !== 'USDT') return unpriced;
      const quote = prices.get(position.asset.code);
      return quote ? { ...unpriced, price: { ...quote } } : unpriced;
    })
  };
  validateSnapshot(snapshot);
  return snapshot;
}
