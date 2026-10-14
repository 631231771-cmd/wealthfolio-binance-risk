import { createMockTransport, SpotError, type MockResponse } from './spot';

export type SpotScenario = 'normal'|'zero'|'missing-price'|'401'|'403'|'429'|'signature'|'clock'|'timeout';
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
      return {status:200,data:{uid:42,accountType:'SPOT',updateTime:0,balances:scenario==='zero'?[]:[{asset:'BTC',free:'0.3',locked:'0.1'},{asset:'USDT',free:'4000',locked:'0'}]}};
    }
    if(path==='/api/v3/ticker/price')return scenario==='missing-price'?{status:503,data:{}}:{status:200,data:{symbol:'BTCUSDT',price:'50000'}};
    throw new SpotError('invalid');
  });
}
