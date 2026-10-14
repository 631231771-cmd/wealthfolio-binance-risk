import { createMockTransport, SpotError, type MockResponse } from './spot';

export const MULTI_PRICES={BTC:'50000',ETH:'2500',BNB:'500',SOL:'150',DOGE:'0.1'} as const;
export const multiExchangeInfo=()=>({symbols:Object.keys(MULTI_PRICES).map(baseAsset=>({symbol:baseAsset+'USDT',baseAsset,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true}))});
export type SpotScenario = 'normal'|'multi'|'multi-missing'|'zero'|'missing-price'|'401'|'403'|'429'|'signature'|'clock'|'timeout';
export function spotFixtureTransport(selected:SpotScenario|(()=>SpotScenario), now=Date.now) {
  return createMockTransport(async request=> {
    const scenario=typeof selected==='function'?selected():selected;
    const path=new URL(request.url).pathname;
    if(path==='/api/v3/time')return {status:200,data:{serverTime:now()+250}};
    if(path==='/api/v3/account') {
      const failures:Partial<Record<SpotScenario,MockResponse>>={
        '401':{status:401,data:{code:-2015,msg:'fixed fake auth error'}}, '403':{status:403,data:{}},
        '429':{status:429,data:{code:-1003},headers:{'Retry-After':'60'}},
        signature:{status:400,data:{code:-1022}},clock:{status:400,data:{code:-1021}}
      };
      if(scenario==='timeout')throw new SpotError('timeout');
      if(failures[scenario])return failures[scenario]!;
      const rows=[{asset:'BTC',free:'0.3',locked:'0.1'},{asset:'USDT',free:'4000',locked:'0'}];
      if(scenario.startsWith('multi'))rows.push(...Object.entries({ETH:'2',BNB:'10',SOL:'20',DOGE:'1000'}).map(([asset,free])=>({asset,free,locked:'0'})));
      if(scenario==='multi-missing')rows.push({asset:'NOPAIR',free:'7',locked:'0'});
      return {status:200,data:{uid:42,accountType:'SPOT',updateTime:0,balances:scenario==='zero'?[]:rows}};
    }
    if(path==='/api/v3/exchangeInfo')return{status:200,data:multiExchangeInfo()};
    if(path==='/api/v3/ticker/price') {
      if(scenario==='missing-price')return{status:503,data:{}};
      const params=new URL(request.url).searchParams, single=params.get('symbol');
      const symbols:string[]=single?[single]:JSON.parse(params.get('symbols')??'[]');
      const prices=symbols.filter(s=>!(scenario==='multi-missing' && s==='ETHUSDT')).map(symbol=>({symbol,price:MULTI_PRICES[symbol.slice(0,-4) as keyof typeof MULTI_PRICES]}));
      return{status:200,data:single?prices[0]:prices};
    }
    throw new SpotError('invalid');
  });
}
