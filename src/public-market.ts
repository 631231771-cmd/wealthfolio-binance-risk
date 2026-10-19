import type { NetworkAPI, NetworkRequest, NetworkResponse } from '@wealthfolio/addon-sdk';
import { assetKey, calculateRisk, validateSnapshot, type Account, type PortfolioState, type Price, type Snapshot } from './domain';
import { candidateUsdtSymbol, parseTickerPrices, parseTickerPricesPartial, parseUsdtMarkets, publicExchangeInfoRequest, publicTickerRequest } from './spot-quotes';

export const PUBLIC_ORIGIN='https://data-api.binance.vision';
export const PUBLIC_TTL_MS=120_000;
export const SPOT_QUOTE_MAX_REQUESTS=32;
export const SPOT_QUOTE_MAX_FALLBACK_REQUESTS=20;
export const SPOT_QUOTE_MAX_CANDIDATES=100;
export const SPOT_QUOTE_BATCH_SIZE=20;
const PUBLIC_RESPONSE_MAX_BYTES=2*1024*1024;
const PUBLIC_ERROR_MAX_BYTES=64*1024;
const encoder=new TextEncoder();
const QUANTITIES={BTC:'0.4',ETH:'2',BNB:'10',SOL:'20',DOGE:'1000',USDT:'4000'} as const;
const ID='fixture:public-quotes:spot';
type Code='network'|'timeout'|'rate-limit'|'invalid'|'disconnected'|'busy';
const messages:Record<Code,string>={network:'公开行情网络请求失败；旧报价仅供历史参考',timeout:'公开行情读取超时；旧报价仅供历史参考','rate-limit':'公开行情限流；冷却后手动重试',invalid:'公开行情响应无效或不完整',disconnected:'公开行情已断开；当前报价不可用',busy:'已有公开请求尚未结束，请等待'};
export class PublicMarketError extends Error {constructor(readonly code:Code,readonly exchangeCode?:number){super(messages[code]);}}
export type SpotQuoteRefreshStatus='complete'|'partial'|'request-failed'|'no-market'|'no-candidates'|'budget-limited';
export type SpotQuoteBudgetReason='request-cap'|'fallback-cap'|'candidate-cap';
export interface SpotQuoteRefreshResult {
  status:SpotQuoteRefreshStatus;
  assetCount:number;
  candidateCount:number;
  marketCount:number;
  // 本轮真正取得的新报价
  pricedCount:number;
  // 没有新报价、但仍在使用 TTL 内既有报价的资产
  retainedCount:number;
  // 已验证市场本次没有返回 ticker（暂时缺价，不等于无市场）
  missingQuoteCount:number;
  // exchangeInfo 明确无 USDT 市场，或资产代码无法构成交易对
  noMarketCount:number;
  // 只有网络/HTTP/解析级失败进入这里，驱动退避
  failedRequestCount:number;
  unexaminedCount:number;
  requestCount:number;
  fallbackRequestCount:number;
  budgetReason?:SpotQuoteBudgetReason;
}
interface SpotQuoteRequestBudget {requestCount:number;fallbackRequestCount:number;budgetReason?:SpotQuoteBudgetReason}
const isTerminalQuoteError=(error:unknown):error is PublicMarketError=>error instanceof PublicMarketError&&['rate-limit','timeout','disconnected','busy'].includes(error.code);
const withinUtf8Limit=(value:string,maxBytes:number):boolean=>value.length<=maxBytes&&encoder.encode(value).byteLength<=maxBytes;

// 固定构造；调用者不能提供 URL/header/body/auth 或任意参数。
export function publicMarketRequest(endpoint:'time'|'exchangeInfo'|'price',symbols?:string[]):NetworkRequest {
  if(!['time','exchangeInfo','price'].includes(endpoint) || endpoint==='time' && symbols!==undefined)throw new PublicMarketError('invalid');
  if(endpoint==='price' || endpoint==='exchangeInfo') {
    const fixtureSymbols=Object.keys(QUANTITIES).flatMap(code=>{const symbol=candidateUsdtSymbol(code);return symbol?[symbol]:[]});
    const path=new URL(endpoint==='price'?publicTickerRequest(symbols??[]).url:publicExchangeInfoRequest(symbols??fixtureSymbols).url);
    return {method:'GET',url:`${PUBLIC_ORIGIN}${path.pathname}${path.search}`,timeoutSecs:10};
  }
  return {method:'GET',url:`${PUBLIC_ORIGIN}/api/v3/time`,timeoutSecs:10};
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

// 真实余额只把资产代码交给此只读服务；它不接收凭据、UID或余额数量，也不创建模拟快照。
export class SpotQuoteReader {
  private busy=false; private pending=false; private epoch=0; private cooldownUntil=0; private prices=new Map<string,Price>();
  private history=new Map<string,Price>();
  private markets=new Map<string,{symbol:string|null;at:number}>();
  constructor(private network:Pick<NetworkAPI,'request'>,private now=Date.now,private timeoutMs=15_000){}
  getSpotQuotes(){return structuredClone(this.prices);}
  getHistoricalQuotes(){return structuredClone(this.history);}
  getCooldownUntil(){return this.cooldownUntil;}
  isBusy(){return this.busy||this.pending;}
  // 页面隐藏只阻断迟到结果，不销毁仍然有效的报价；显式断开才清空。
  pause(){this.epoch++;}
  disconnect(){this.epoch++;this.prices.clear();}
  private async request(request:NetworkRequest,epoch:number):Promise<unknown>{
    if(epoch!==this.epoch)throw new PublicMarketError('disconnected');
    let timer:ReturnType<typeof setTimeout>|undefined;this.pending=true;
    const operation=Promise.resolve().then(()=>this.network.request(request)).then(response=>{
      if(response.status===429||response.status===418){const retry=Number(Object.entries(response.headers??{}).find(([key])=>key.toLowerCase()==='retry-after')?.[1]);const seconds=Number.isSafeInteger(retry)&&retry>0?Math.min(retry,Math.floor((Number.MAX_SAFE_INTEGER-this.now())/1000)):(response.status===418?1800:60);this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+seconds*1000);}
      return response;
    }).finally(()=>{this.pending=false;});
    let response:NetworkResponse;
    try{response=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new PublicMarketError('timeout')),this.timeoutMs);})]);}
    catch(error){throw error instanceof PublicMarketError?error:new PublicMarketError('network');}
    finally{clearTimeout(timer);}
    if(epoch!==this.epoch)throw new PublicMarketError('disconnected');
    if(response.status===429||response.status===418)throw new PublicMarketError('rate-limit');
    if(response.status!==200){let exchangeCode:number|undefined;if(typeof response.body==='string'&&withinUtf8Limit(response.body,PUBLIC_ERROR_MAX_BYTES))try{const parsed=JSON.parse(response.body) as {code?:unknown};if(Number.isSafeInteger(parsed?.code))exchangeCode=parsed.code as number;}catch{/* 不透传错误正文 */}throw new PublicMarketError(response.status===400&&(exchangeCode===-1121||exchangeCode===-1220)?'invalid':'network',exchangeCode);}
    if(typeof response.body!=='string'||!withinUtf8Limit(response.body,PUBLIC_RESPONSE_MAX_BYTES))throw new PublicMarketError('invalid');
    try{return JSON.parse(response.body);}catch{throw new PublicMarketError('invalid');}
  }
  private async requestWithinBudget(request:NetworkRequest,epoch:number,budget:SpotQuoteRequestBudget,fallback=false):Promise<unknown|undefined>{
    if(budget.requestCount>=SPOT_QUOTE_MAX_REQUESTS){budget.budgetReason='request-cap';return undefined;}
    if(fallback&&budget.fallbackRequestCount>=SPOT_QUOTE_MAX_FALLBACK_REQUESTS){budget.budgetReason='fallback-cap';return undefined;}
    budget.requestCount++;
    if(fallback)budget.fallbackRequestCount++;
    return this.request(request,epoch);
  }
  async refreshSpotAssets(assetCodes:string[]):Promise<SpotQuoteRefreshResult>{
    if(this.busy||this.pending)throw new PublicMarketError('busy');
    if(this.now()<this.cooldownUntil)throw new PublicMarketError('rate-limit');
    this.busy=true;const epoch=this.epoch,prices=new Map<string,Price>();
    try{
      if(assetCodes.length>10_000||assetCodes.some(code=>typeof code!=='string'||code.length===0||encoder.encode(code).length>256||/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(code)))throw new PublicMarketError('invalid');
      const unique=[...new Set(assetCodes)];
      for(const code of this.markets.keys())if(!unique.includes(code))this.markets.delete(code);
      const allCandidates=unique.flatMap(code=>{const symbol=candidateUsdtSymbol(code);return symbol?[[code,symbol] as const]:[]});
      const candidates=allCandidates.slice(0,SPOT_QUOTE_MAX_CANDIDATES);
      const budget:SpotQuoteRequestBudget={requestCount:0,fallbackRequestCount:0};
      let failedRequestCount=0,missingQuoteCount=0,unexaminedCount=allCandidates.length-candidates.length;
      if(unexaminedCount)budget.budgetReason='candidate-cap';
      const markets=new Map<string,string>();
      let stopForBudget=false;
      // exchangeInfo 明确无市场 ≠ 本次没拿到 ticker；两者分别计数，只有前者可缓存。
      const knownNoMarket=(code:string)=>this.markets.get(code)?.symbol===null;
      const validOld=(code:string)=>{
        const price=this.prices.get(code);if(!price)return false;
        const at=Date.parse(price.asOf),now=this.now();
        return Number.isFinite(at)&&at<=now&&now-at<=PUBLIC_TTL_MS;
      };
      const publish=(status:SpotQuoteRefreshStatus):SpotQuoteRefreshResult=>{
        if(epoch!==this.epoch)throw new PublicMarketError('disconnected');
        // 合并而不是替换：未检查、暂时缺 ticker 或本轮失败时，旧报价保留到自身 TTL 到期。
        // 旧价不会被改写 asOf，也不会在过期后继续进入估值（由 mergeDynamicPublicSpotPrices 过滤）。
        const merged=new Map<string,Price>();
        for(const code of unique){const old=this.prices.get(code);if(old)merged.set(code,old);}
        for(const [code,price] of prices)merged.set(code,price);
        this.prices=merged;
        for(const code of this.history.keys())if(!unique.includes(code))this.history.delete(code);
        for(const [code,price] of prices)this.history.set(code,price);
        const retained=unique.filter(code=>code!=='USDT'&&!prices.has(code)&&(()=>{const p=merged.get(code);if(!p)return false;const at=Date.parse(p.asOf),now=this.now();return Number.isFinite(at)&&at<=now&&now-at<=PUBLIC_TTL_MS;})()).length;
        const noMarketCount=unique.filter(code=>code!=='USDT'&&!merged.has(code)&&(knownNoMarket(code)||!candidateUsdtSymbol(code))).length;
        return {
        status,assetCount:unique.length,candidateCount:allCandidates.length,marketCount:markets.size,
        pricedCount:prices.size,retainedCount:retained,missingQuoteCount,noMarketCount,
        failedRequestCount,unexaminedCount,requestCount:budget.requestCount,fallbackRequestCount:budget.fallbackRequestCount,
        ...(budget.budgetReason?{budgetReason:budget.budgetReason}:{})
      };};
      if(!candidates.length)return publish('no-candidates');
      // 正映射15分钟、明确无市场3分钟；不缓存网络错误。定时刷新通常只请求ticker。
      const unresolved=candidates.filter(([code])=>{
        const cached=this.markets.get(code),age=cached?this.now()-cached.at:Infinity;
        if(!cached||age<0||age>(cached.symbol?900_000:180_000))return true;
        if(cached.symbol)markets.set(code,cached.symbol);
        return false;
      });
      const remember=(payload:unknown,assets:string[])=>{
        const found=parseUsdtMarkets(payload,assets);
        for(const code of assets){const symbol=found.get(code)??null;this.markets.set(code,{symbol,at:this.now()});if(symbol)markets.set(code,symbol);}
      };
      metadata: for(let offset=0;offset<unresolved.length;offset+=SPOT_QUOTE_BATCH_SIZE){
        const batch=unresolved.slice(offset,offset+SPOT_QUOTE_BATCH_SIZE);
        const symbols=batch.map(([,symbol])=>symbol),assets=batch.map(([code])=>code);
        try{
          const payload=await this.requestWithinBudget(publicMarketRequest('exchangeInfo',symbols),epoch,budget);
          if(payload===undefined){unexaminedCount+=unresolved.length-offset;stopForBudget=true;break metadata;}
          remember(payload,assets);
        }catch(error){
          if(isTerminalQuoteError(error))throw error;
          if(!(error instanceof PublicMarketError&&error.exchangeCode===-1121)){failedRequestCount++;continue;}
          for(let index=0;index<batch.length;index++){
            const [code,symbol]=batch[index];
            try{
              const payload=await this.requestWithinBudget(publicMarketRequest('exchangeInfo',[symbol]),epoch,budget,true);
              if(payload===undefined){
                unexaminedCount+=unresolved.length-offset-index;
                stopForBudget=true;break metadata;
              }
              remember(payload,[code]);
            }catch(singleError){
              if(isTerminalQuoteError(singleError))throw singleError;
              if(singleError instanceof PublicMarketError&&singleError.exchangeCode===-1121){this.markets.set(code,{symbol:null,at:this.now()});continue;}
              failedRequestCount++;
            }
          }
        }
      }
      // 元数据回退达到上限也必须报价已验证的市场；二者共享总请求预算。
      {
        const entries=[...markets.entries()];
        quotes: for(let offset=0;offset<entries.length;offset+=SPOT_QUOTE_BATCH_SIZE){
          const chunk=entries.slice(offset,offset+SPOT_QUOTE_BATCH_SIZE),symbols=chunk.map(([,symbol])=>symbol);
          try{
            const payload=await this.requestWithinBudget(publicMarketRequest('price',symbols),epoch,budget);
            if(payload===undefined){unexaminedCount+=entries.length-offset;stopForBudget=true;break quotes;}
            const tickers=parseTickerPricesPartial(payload,symbols,new Date(this.now()).toISOString());
            // HTTP 200 不代表结果完整：缺失行属于"本次暂时没有报价"，不是请求失败。
            if(tickers.size<chunk.length)missingQuoteCount+=chunk.length-tickers.size;
            for(const [code,symbol] of chunk){
              const price=tickers.get(symbol);
              if(price)prices.set(code,{...price,source:'external:'+PUBLIC_ORIGIN+'/api/v3/ticker/price（采集时间，非成交时间）'});
            }
          }catch(error){
            if(isTerminalQuoteError(error))throw error;
            // 单 symbol + symbolStatus=TRADING 时，停牌市场返回 -1220；这是暂时无报价，不是网络失败。
            if(error instanceof PublicMarketError&&error.exchangeCode===-1220){missingQuoteCount+=chunk.length;continue;}
            if(!(error instanceof PublicMarketError&&error.exchangeCode===-1121)){failedRequestCount++;continue;}
            for(let index=0;index<chunk.length;index++){
              const [code,symbol]=chunk[index];
              try{
                const payload=await this.requestWithinBudget(publicMarketRequest('price',[symbol]),epoch,budget,true);
                if(payload===undefined){
                  unexaminedCount+=chunk.length-index+entries.length-offset-chunk.length;
                  stopForBudget=true;break quotes;
                }
                const price=parseTickerPrices(payload,[symbol],new Date(this.now()).toISOString(),'external').get(symbol);
                if(price)prices.set(code,{...price,source:'external:'+PUBLIC_ORIGIN+'/api/v3/ticker/price（采集时间，非成交时间）'});
                else missingQuoteCount++;
              }catch(singleError){
                if(isTerminalQuoteError(singleError))throw singleError;
                if(singleError instanceof PublicMarketError&&singleError.exchangeCode===-1121){this.markets.delete(code);continue;}
                if(singleError instanceof PublicMarketError&&singleError.exchangeCode===-1220){missingQuoteCount++;continue;}
                failedRequestCount++;
              }
            }
          }
        }
      }
      if(epoch!==this.epoch)throw new PublicMarketError('disconnected');
      // 结构性无市场（exchangeInfo 判定或无法构成交易对）与"本次缺价"分开统计；
      // 二者都让覆盖不完整，但只有请求级失败驱动退避。
      const noMarketCodes=unique.filter(code=>code!=='USDT'&&!prices.has(code)&&!validOld(code)&&(knownNoMarket(code)||!candidateUsdtSymbol(code)));
      const uncovered=unique.filter(code=>code!=='USDT'&&!prices.has(code)&&!validOld(code)&&!noMarketCodes.includes(code)).length;
      const hasAnyValidPrice=unique.some(code=>code!=='USDT'&&validOld(code));
      if(prices.size===0&&failedRequestCount>0)return publish('request-failed');
      if(prices.size===0&&!hasAnyValidPrice&&missingQuoteCount>0)return publish('request-failed');
      if(stopForBudget||budget.budgetReason)return publish('budget-limited');
      if(markets.size===0)return publish(failedRequestCount?'request-failed':'no-market');
      const complete=uncovered===0&&noMarketCodes.length===0&&failedRequestCount===0&&unexaminedCount===0&&missingQuoteCount===0;
      return publish(complete?'complete':'partial');
    }catch(error){throw error instanceof PublicMarketError?error:new PublicMarketError('invalid');}
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

export function mergeDynamicPublicSpotPrices(account:Account,balance:Snapshot,quotes:ReadonlyMap<string,Price>,now:number,maxAgeMs=PUBLIC_TTL_MS):Snapshot {
  if(!Number.isFinite(now)||account.platform!=='binance'||account.kind!=='spot'||!account.sourceAccountId||account.id.startsWith('demo-')||balance.accountId!==account.id||balance.dataMode!=='external'||!balance.collectionStartedAt||!balance.collectionEndedAt)throw new Error('外部 Spot 余额来源无效');
  validateSnapshot(balance);
  const positions=balance.positions.map(position=>{
    const {price:_oldPrice,...unpriced}=position;
    if(position.asset.code==='USDT'&&position.asset.quoteCurrency==='USDT')return {...unpriced,price:{value:'1',currency:'USDT',asOf:new Date(now).toISOString(),source:'unit:USDT/USDT'}};
    if(position.asset.quoteCurrency!=='USDT')return unpriced;
    const price=quotes.get(position.asset.code),at=price?Date.parse(price.asOf):NaN;
    if(!price||price.currency!=='USDT'||!price.source.startsWith(`external:${PUBLIC_ORIGIN}/api/v3/ticker/price`)||!Number.isFinite(at)||at>now||now-at>maxAgeMs)return unpriced;
    return {...unpriced,price:{...price}};
  });
  const snapshot={...balance,positions};validateSnapshot(snapshot);return snapshot;
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
