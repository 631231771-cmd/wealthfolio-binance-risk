import test from 'node:test';
import assert from 'node:assert/strict';
import {spotSnapshot,spotRisk} from '../src/spot';
import {costSummary,costHeadline} from '../src/cost-basis';
import type {PortfolioState} from '../src/domain';

const NOW=Date.parse('2026-10-19T10:00:00Z'),AT=new Date(NOW).toISOString();
function valuation(balances:{asset:string;free:string}[],prices:Record<string,string>){
 const {account,snapshot}=spotSnapshot({uid:1,accountType:'SPOT',balances:balances.map(b=>({...b,locked:'0'}))},'external',AT,AT);
 for(const p of snapshot.positions)if(prices[p.asset.code])p.price={value:prices[p.asset.code],currency:'USDT',asOf:AT,source:'external:test'};
 const state:PortfolioState={schemaVersion:1,accounts:[account],snapshots:{[account.id]:snapshot},statuses:{[account.id]:{state:'ready',attemptedAt:AT}}};
 return {state,report:spotRisk(state,NOW)};
}
const v=()=>valuation([{asset:'USDT',free:'100'},{asset:'BTC',free:'0.01'}],{USDT:'1',BTC:'65000'});

test('全部成本已知：盈亏分母是成本，不是市值',()=>{
 const s=costSummary(v().state,v().report,{BTC:{unitCost:'60000',source:'confirmed'},USDT:{unitCost:'1'}});
 assert.equal(s.state,'complete');
 assert.equal(s.totalValue,'750.00000000');
 assert.equal(s.knownValue,'750.00000000');
 assert.equal(s.cost,'700.00000000');
 assert.equal(s.gain,'50.00000000');
 assert.equal(s.gainPct,'0.071429');
 assert.equal(s.coverage,'1.000000');
 assert.deepEqual(costHeadline(s),{label:'持仓累计盈亏',value:'50.00000000',pct:'0.071429',scope:'complete',basis:'已确认成本'});
});
test('部分成本已知：只汇总已核实部分并明确标注，USDT现金按面值',()=>{
 const v3=valuation([{asset:'USDT',free:'100'},{asset:'BTC',free:'0.01'},{asset:'ETH',free:'1'}],{USDT:'1',BTC:'65000',ETH:'2500'});
 const s=costSummary(v3.state,v3.report,{BTC:{unitCost:'60000'}});
 assert.equal(s.state,'partial');
 assert.equal(s.knownValue,'750.00000000');   // USDT 100 + BTC 650
 assert.equal(s.cost,'700.00000000');         // USDT 100 + BTC 600
 assert.equal(s.gain,'50.00000000');
 assert.equal(s.coverage,'0.230769');         // 750 / 3250
 assert.equal(s.rows.find(r=>r.code==='USDT')?.costKnown,true);
 assert.equal(s.rows.find(r=>r.code==='ETH')?.costKnown,false);
 assert.equal(costHeadline(s).scope,'partial');
 assert.equal(costHeadline(s).label,'仅已填写成本部分');
});
test('只有现金时成本完整且盈亏为零；证券缺成本时为部分覆盖',()=>{
 const cash=valuation([{asset:'USDT',free:'100'}],{USDT:'1'});
 const onlyCash=costSummary(cash.state,cash.report,{});
 assert.equal(onlyCash.state,'complete');
 assert.equal(onlyCash.gain,'0.00000000');
 const mixed=costSummary(v().state,v().report,{});
 assert.equal(mixed.state,'none');            // 没有任何证券成本，不宣称部分已核实
 assert.equal(mixed.gain,null);
 assert.equal(costHeadline(mixed).value,null);
 assert.ok(mixed.issues.includes('MISSING_COST'));
});
test('缺价资产让覆盖不完整，成本为零或非法不进入账本',()=>{
 const missing=valuation([{asset:'USDT',free:'100'},{asset:'NOPAIR',free:'3'}],{USDT:'1'});
 const s=costSummary(missing.state,missing.report,{USDT:{unitCost:'1'},NOPAIR:{unitCost:'0'}});
 assert.equal(s.state,'partial');
 assert.ok(s.issues.includes('MISSING_PRICE'));
 assert.ok(s.issues.includes('MISSING_COST'));
 assert.equal(s.gain,'0.00000000'); // 只有 USDT，成本等于市值
 const bad=costSummary(v().state,v().report,{BTC:{unitCost:'-5'},USDT:{unitCost:'abc'}});
 assert.equal(bad.state,'none');
});
test('未定价资产不进入分母，也不会被成本补出一个市值',()=>{
 const mixed=valuation([{asset:'USDT',free:'100'},{asset:'BTC',free:'0.01'},{asset:'NOPAIR',free:'3'}],{USDT:'1',BTC:'65000'});
 const s=costSummary(mixed.state,mixed.report,{BTC:{unitCost:'60000'},USDT:{unitCost:'1'}});
 assert.equal(s.totalValue,'750.00000000'); // NOPAIR 不在已定价范围
 assert.equal(s.state,'partial');
 assert.equal(s.rows.find(r=>r.code==='NOPAIR')?.value,undefined);
});

test('成本来源区分待确认与已确认，未确认不称为已核实',()=>{
 const vv=valuation([{asset:'BTC',free:'1'},{asset:'USDT',free:'100'}],{BTC:'700',USDT:'1'});
 const entered=costSummary(vv.state,vv.report,{BTC:{unitCost:'500',source:'entered'},USDT:{unitCost:'1'}});
 assert.equal(entered.allConfirmed,false);
 assert.equal(costHeadline(entered).basis,'已填写成本（待确认）');
 const confirmed=costSummary(vv.state,vv.report,{BTC:{unitCost:'500',source:'confirmed'},USDT:{unitCost:'1'}});
 assert.equal(confirmed.allConfirmed,true);
 assert.equal(costHeadline(confirmed).basis,'已确认成本');
});

test('微额不参与成本覆盖与收益率，也不产生缺成本问题',()=>{
 const v9=valuation([
  {asset:'USDT',free:'100'},{asset:'BTC',free:'1'},{asset:'ETH',free:'1'},
  {asset:'D1',free:'1'},{asset:'D2',free:'1'},{asset:'D3',free:'1'},{asset:'D4',free:'1'},{asset:'D5',free:'1'},{asset:'D6',free:'1'}
 ],{USDT:'1',BTC:'650',ETH:'2500',D1:'0.05',D2:'0.04',D3:'0.03',D4:'0.02',D5:'0.01',D6:'0.001'});
 const s=costSummary(v9.state,v9.report,{BTC:{unitCost:'600',source:'confirmed'},ETH:{unitCost:'2400',source:'confirmed'}});
 assert.equal(s.state,'complete');
 assert.equal(s.issues.length,0);
 assert.equal(s.rows.filter(r=>r.dust).length,6);
 assert.equal(s.eligibleValue,'3250.00000000'); // BTC 650 + ETH 2500 + USDT 100
 assert.equal(s.coverage,'1.000000');
 assert.equal(s.knownValue,'3250.00000000');
});
