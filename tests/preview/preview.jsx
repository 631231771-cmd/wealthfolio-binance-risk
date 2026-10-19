import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {DirectSpotPanel} from '../../src/direct-panel';
import {DirectSpot} from '../../src/direct-spot';
import {BinanceCredentials} from '../../src/credentials';
import {SpotQuoteReader} from '../../src/public-market';
import '../../src/style.css';

// All balances, credentials and prices below are synthetic. No SDK or network.
const baseTime=Date.parse('2026-10-19T08:00:00Z');
async function scenario(name){
 const store=new Map(),credentials=new BinanceCredentials({get:async k=>store.get(k)??null,set:async(k,v)=>{store.set(k,v);},delete:async k=>{store.delete(k);}});
 await credentials.save('PREVIEW_FAKE_KEY','PREVIEW_FAKE_SECRET');
 let clock=baseTime,fail=false,balanceFail=false;
 const holdings=[['USDC',name==='complete'?'2500':'18000'],['BTC','0.075'],['ETH','0.8'],['SOL','12'],['USDT','750'],['DOGE','0.02']];
 const prices={USDC:'0.9993',BTC:'65420',ETH:'2540.18',SOL:'148.32',DOGE:'0.12'};
 if(name==='dust')for(let i=0;i<12;i++){holdings.push(['DUST'+i,'0.02']);prices['DUST'+i]='0.15';}
 if(name==='dust')holdings.push(['UNPRICED','0.000000001']);
 const network={request:async request=>{
  const url=new URL(request.url);let body;
  if(url.pathname.endsWith('/time'))body={serverTime:clock};
  else if(url.pathname.endsWith('/apiRestrictions')){
   if(balanceFail)throw new Error('Fictional offline transport');
   body={enableReading:true,ipRestrict:false,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
  }else if(url.pathname.endsWith('/account'))body={uid:1,accountType:'SPOT',balances:(name==='zero'?[]:holdings).map(([asset,free])=>({asset,free,locked:'0'}))};
  else if(url.pathname.endsWith('/exchangeInfo'))body={symbols:Object.keys(prices).map(baseAsset=>({baseAsset,quoteAsset:'USDT',symbol:baseAsset+'USDT',status:'TRADING',isSpotTradingAllowed:true}))};
  else if(url.pathname.endsWith('/ticker/price')){
   if(fail)return {status:503,headers:{},body:'{}'};
   body=Object.entries(prices).filter(([code])=>name!=='partial'||code!=='USDC').map(([code,price])=>({symbol:code+'USDT',price}));
  }else throw new Error('Preview path not supported');
  return {status:200,headers:{},body:JSON.stringify(body)};
 }};
 const reader=new DirectSpot(credentials,network,new SpotQuoteReader(network,()=>clock),()=>clock);
 reader.setVisible(true);reader.authorize('1',{risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true});await reader.sync();await reader.refreshQuotes();
 if(name==='stale'||name==='dust')clock+=400_000;
 if(name==='price-stale')clock+=121_000;
 if(name==='failure'){clock+=60_000;fail=true;await reader.refreshQuotes();}
 if(name==='balance-failure'){clock+=60_000;balanceFail=true;await reader.sync();}
 // Freeze automatic sampling for reproducible visual fixtures. Production tick is tested separately.
 reader.tick=async()=>{};
 return {reader,credentials};
}

// 虚构宿主：只在预览里模拟原生账户，不连接 Wealthfolio、不写任何真实资料库。
const nativeAccounts=[],nativeSaves=[];
const mockNativeHost={
 listAccounts:async()=>nativeAccounts,
 createAccount:async input=>{const a={id:'native-preview-account',...input};nativeAccounts.push(a);return a;},
 checkImport:async()=>({existingDates:[],symbols:[],validationErrors:[]}),
 saveSnapshot:async(id,holdings,cash,date)=>{nativeSaves.push({id,holdings,cash,date});},
 listSnapshots:async()=>[{snapshotDate:nativeSaves.at(-1)?.date??'',positionCount:nativeSaves.at(-1)?.holdings.length??0,cashCurrencyCount:1}],
 getByDate:async()=>(nativeSaves.at(-1)?.holdings??[]).map(h=>({symbol:h.symbol,quantity:Number(h.quantity),assetId:'asset-'+h.symbol,quoteMode:'MARKET'})),
 updateQuote:async()=>{},
 baseCurrency:async()=>'USD',
 // 复现真实宿主 3.10.0：日期汇率接口拒绝 4 位 USDT，但手动最新汇率存在。
 rateForDate:async()=>({rate:null,error:'Invalid currency code: USDT'}),
 listRates:async()=>[{fromCurrency:'USDT',toCurrency:'USD',rate:1,source:'MANUAL',timestamp:'2026-10-19T00:00:00Z'}],
 today:()=>new Date().toISOString().slice(0,10),
 readBinding:async()=>null,writeBinding:async()=>{}
};

const initial=await scenario('usdc');
function Preview(){
 const [active,setActive]=useState('usdc'),[data,setData]=useState(initial),[width,setWidth]=useState('auto');
 const set=async next=>{data.reader.disconnect();setData(await scenario(next));setActive(next);};
 return <><div id="preview-label"><span>仅虚构数据 · 内存 transport · 不连接宿主或账户</span><div>{[['complete','完整估值'],['usdc','USDC主仓'],['stale','余额过期'],['price-stale','报价过期'],['partial','部分缺价'],['failure','报价失败'],['balance-failure','余额失败'],['dust','多微额过期'],['zero','成功零余额']].map(([key,label])=><button key={key} aria-pressed={active===key} onClick={()=>void set(key)}>{label}</button>)}<label>窗口宽度 <select value={width} onChange={e=>setWidth(e.target.value)}><option value="auto">自适应</option><option value="920">920px</option><option value="420">420px</option></select></label></div></div><div id="preview-frame" style={{width:width==='auto'?'100%':width+'px',maxWidth:'100%',margin:'auto',containerType:'inline-size'}}><main className="wrisk-app"><DirectSpotPanel key={active} reader={data.reader} credentials={data.credentials} host={mockNativeHost} nativeInitialCosts={location.hash.slice(1).startsWith('native-costs')||location.hash.slice(1)==='native-done'?{BTC:{unitCost:'60000'},ETH:{unitCost:'2500'},SOL:{unitCost:'140'},USDC:{unitCost:'1'},DOGE:{unitCost:'0.11'}}:undefined}/></main></div></>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
if(location.hash.slice(1).startsWith('native')){
 const click=(text,delay)=>setTimeout(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===text);b?.click();},delay);
 click('原生同步',200);click('检测宿主能力',700);click('生成导入预览',1200);
 const flow=location.hash.slice(1);
 if(flow==='native-done'){
  setTimeout(()=>{const c=document.querySelector('.native-confirm input[type=checkbox]');if(c&&!c.checked)c.click();},1700);
  click('写入原生账户',2100);
 }
}
