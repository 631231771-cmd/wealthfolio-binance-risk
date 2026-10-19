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
 const s=costSummary(v().state,v().report,{BTC:{unitCost:'60000'},USDT:{unitCost:'1'}});
 assert.equal(s.state,'complete');
 assert.equal(s.totalValue,'750.00000000');
 assert.equal(s.knownValue,'750.00000000');
 assert.equal(s.cost,'700.00000000');
 assert.equal(s.gain,'50.00000000');
 assert.equal(s.gainPct,'0.071429');
 assert.equal(s.coverage,'1.000000');
 assert.deepEqual(costHeadline(s),{label:'持仓累计盈亏',value:'50.00000000',pct:'0.071429',scope:'complete'});
});
test('部分成本已知：只汇总已核实部分并明确标注',()=>{
 const s=costSummary(v().state,v().report,{BTC:{unitCost:'60000'}});
 assert.equal(s.state,'partial');
 assert.equal(s.knownValue,'650.00000000');
 assert.equal(s.cost,'600.00000000');
 assert.equal(s.gain,'50.00000000');
 assert.equal(s.coverage,'0.866667');
 assert.equal(costHeadline(s).scope,'partial');
 assert.equal(costHeadline(s).label,'仅已核实成本部分');
});
test('没有成本：不产生任何收益率，也不把未知当零',()=>{
 const s=costSummary(v().state,v().report,{});
 assert.equal(s.state,'none');
 assert.equal(s.gain,null);assert.equal(s.gainPct,null);assert.equal(s.cost,null);
 assert.equal(costHeadline(s).value,null);
 assert.ok(s.issues.includes('MISSING_COST'));
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
