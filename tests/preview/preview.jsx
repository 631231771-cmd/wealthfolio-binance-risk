import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DirectSpotPanel} from '../../src/direct-panel';
import {DirectSpot} from '../../src/direct-spot';
import {BinanceCredentials} from '../../src/credentials';
import {SpotQuoteReader} from '../../src/public-market';
import '../../src/style.css';

const store=new Map(),credentials=new BinanceCredentials({get:async k=>store.get(k)??null,set:async(k,v)=>{store.set(k,v);},delete:async k=>{store.delete(k);}});
await credentials.save('PREVIEW_FAKE_KEY','PREVIEW_FAKE_SECRET');
let clock=Date.parse('2026-10-16T08:00:00Z'),mode='complete';
const holdings=[['USDC','18000'],['BTC','0.075'],['ETH','0.8'],['SOL','12'],['USDT','750'],['DOGE','0.02']];
const prices={USDC:'0.9993',BTC:'65420',ETH:'2540.18',SOL:'148.32',DOGE:'0.12'};
const network={request:async request=>{
  const url=new URL(request.url);let body;
  if(url.pathname.endsWith('/time'))body={serverTime:clock};
  else if(url.pathname.endsWith('/apiRestrictions'))body={enableReading:true,ipRestrict:false,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
  else if(url.pathname.endsWith('/account'))body={uid:1,accountType:'SPOT',balances:(mode==='zero'?[]:holdings).map(([asset,free])=>({asset,free,locked:'0'}))};
  else if(url.pathname.endsWith('/exchangeInfo'))body={symbols:Object.keys(prices).map(baseAsset=>({baseAsset,quoteAsset:'USDT',symbol:baseAsset+'USDT',status:'TRADING',isSpotTradingAllowed:true}))};
  else if(url.pathname.endsWith('/ticker/price')){
    if(mode==='failure')return {status:503,headers:{},body:'{}'};
    body=Object.entries(prices).filter(([code])=>mode!=='partial'||code!=='USDC').map(([code,price])=>({symbol:code+'USDT',price}));
  }else throw new Error('Preview path not supported');
  return {status:200,headers:{},body:JSON.stringify(body)};
}};
const reader=new DirectSpot(credentials,network,new SpotQuoteReader(network,()=>clock),()=>clock);
reader.setVisible(true);reader.authorize('1',{risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true});await reader.sync();await reader.refreshQuotes();
function Preview(){
  const [,render]=useState(0);
  const set=async next=>{mode=next;clock=Date.parse('2026-10-16T08:00:00Z');if(next==='stale')clock+=400_000;else {await reader.sync();await reader.refreshQuotes();}render(n=>n+1);};
  return <><div id="preview-label">仅虚构数据 · 无外部网络、无宿主存储 · 浏览器预览<br/>{[['complete','完整估值'],['partial','USDC缺价'],['failure','报价失败'],['stale','余额过期'],['zero','成功零余额']].map(([key,label])=><button key={key} onClick={()=>void set(key)}>{label}</button>)}</div><main className="wrisk-app"><DirectSpotPanel reader={reader} credentials={credentials}/></main></>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
