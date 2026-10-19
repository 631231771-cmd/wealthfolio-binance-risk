import test from 'node:test';
import assert from 'node:assert/strict';
import {reconstructFifo,matchBalance,type MyTrade} from '../src/trade-cost';

let seq=0;
const trade=(over:Partial<MyTrade>):MyTrade=>({id:'t'+(++seq),orderId:'o'+seq,symbol:'BTCUSDT',price:'100',qty:'1',quoteQty:'100',commission:'0',commissionAsset:'USDT',time:seq,isBuyer:true,...over});
const reset=()=>{seq=0;};

test('FIFO：买1@100、买1@200、卖1.5后剩余成本100，均价200',()=>{
 reset();
 const r=reconstructFifo([
  trade({price:'100',qty:'1',quoteQty:'100',time:1}),
  trade({price:'200',qty:'1',quoteQty:'200',time:2}),
  trade({price:'300',qty:'1.5',quoteQty:'450',time:3,isBuyer:false})
 ],'BTCUSDT');
 assert.equal(r.coverage,'complete');
 assert.equal(r.remainingQty,'0.50000000');
 assert.equal(r.remainingCost,'100.00000000');
 assert.equal(r.averageCost,'200.00000000');
 assert.equal(r.realizedPnl,'250.00000000');
});
test('手续费：报价币手续费计入成本，基础币手续费减少到手数量',()=>{
 reset();
 const quoteFee=reconstructFifo([trade({price:'100',qty:'1',quoteQty:'100',commission:'1',commissionAsset:'USDT'})],'BTCUSDT');
 assert.equal(quoteFee.remainingCost,'101.00000000');
 assert.equal(quoteFee.averageCost,'101.00000000');
 reset();
 const baseFee=reconstructFifo([trade({price:'100',qty:'1',quoteQty:'100',commission:'0.01',commissionAsset:'BTC'})],'BTCUSDT');
 assert.equal(baseFee.remainingQty,'0.99000000');
 assert.equal(baseFee.remainingCost,'100.00000000');
});
test('第三币手续费与超卖都会让成本覆盖变为部分',()=>{
 reset();
 const third=reconstructFifo([trade({price:'100',qty:'1',quoteQty:'100',commission:'0.001',commissionAsset:'BNB'})],'BTCUSDT');
 assert.equal(third.coverage,'partial');
 assert.ok(third.issues.some(i=>i.code==='FEE_THIRD_ASSET'));
 reset();
 const over=reconstructFifo([trade({price:'100',qty:'1',quoteQty:'100',time:1}),trade({price:'120',qty:'2',quoteQty:'240',time:2,isBuyer:false})],'BTCUSDT');
 assert.equal(over.coverage,'partial');
 assert.equal(over.remainingQty,'0.00000000');
 assert.ok(over.issues.some(i=>i.code==='OVERSELL'));
});
test('空历史与非USDT市场不伪造成本',()=>{
 reset();
 const empty=reconstructFifo([],'BTCUSDT');
 assert.equal(empty.coverage,'partial');assert.equal(empty.averageCost,null);
 assert.ok(empty.issues.some(i=>i.code==='EMPTY'));
 const other=reconstructFifo([trade({symbol:'BTCFDUSD',quoteQty:'100'})],'BTCUSDT');
 assert.equal(other.coverage,'partial');
 assert.ok(other.issues.some(i=>i.code==='FEE_THIRD_ASSET'));
});
test('重建数量必须与当前余额对齐，否则不能当作账户成本',()=>{
 reset();
 const r=reconstructFifo([trade({price:'100',qty:'1',quoteQty:'100'})],'BTCUSDT');
 assert.equal(matchBalance(r,'1').ok,true);
 const bad=matchBalance(r,'1.5');
 assert.equal(bad.ok,false);
 assert.match(bad.detail??'',/重建/);
});
