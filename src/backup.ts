import { validateSnapshot, nonnegative, type PortfolioState, type Snapshot } from './domain';
import { emptyState } from './fixtures';

// 本阶段只允许模拟业务备份。真实数据导出尚未获准，禁止隐式拓宽字段。
function object(value: unknown, keys: string[], strict: boolean): Record<string,any> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('备份字段格式无效');
  const v=value as Record<string,any>;
  if (strict && Object.keys(v).some(key=>!keys.includes(key))) throw new Error('备份包含未批准字段');
  return v;
}
function time(value: unknown): string {
  if (typeof value!=='string' || value.length>32 || !/^\d{4}-\d\d-\d\d(?:T[\d:.]+Z)?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('备份时间无效');
  return value;
}
function numeric(value: unknown): string {
  if (typeof value!=='string' || value.length>100) throw new Error('备份数量无效');
  nonnegative(value); return value;
}
function batch(value: unknown): string {
  if (!['fixture-base-v1','fixture-transfer-v1'].includes(value as string)) throw new Error('备份批次不是批准的模拟来源');
  return value as string;
}
export function sanitizeFixtureState(input: unknown, strict = false): PortfolioState {
  const v=object(input,['schemaVersion','accounts','statuses','snapshots'],strict), canonical=emptyState();
  if (v.schemaVersion!==1 || !Array.isArray(v.accounts) || v.accounts.length!==3) throw new Error('备份格式不支持');
  const ids=new Set<string>();
  for (const raw of v.accounts) {
    const a=object(raw,['id','platform','sourceAccountId','kind','name','currency'],strict);
    const expected=canonical.accounts.find(account=>account.id===a.id);
    if (!expected || ids.has(a.id) || a.platform!==expected.platform || a.sourceAccountId!==expected.sourceAccountId || a.kind!==expected.kind || a.currency!==expected.currency) throw new Error('拒绝恢复非模拟来源');
    ids.add(a.id); // 名称使用本地批准文案，不回显任意导入字符串。
  }
  const statuses=object(v.statuses,canonical.accounts.map(a=>a.id),strict);
  for (const a of canonical.accounts) {
    const s=object(statuses[a.id],['state','attemptedAt','reason'],strict);
    if (!['ready','failed','unsupported','uncovered'].includes(s.state) || a.id==='demo-stocks' && s.state!=='unsupported') throw new Error('股票或账户状态无效');
    canonical.statuses[a.id]={state:s.state,attemptedAt:time(s.attemptedAt),...(s.state==='failed'?{reason:'导入的模拟快照当前失效'}:s.state==='unsupported'?{reason:'真实股票接口未确认'}:{})};
  }
  const snapshots=object(v.snapshots,['demo-spot','demo-funding'],strict);
  for (const id of Object.keys(snapshots)) {
    if (!['demo-spot','demo-funding'].includes(id)) throw new Error('备份快照来源不支持');
    const s=object(snapshots[id],['accountId','batchId','asOf','dataMode','positions'],strict);
    if (s.accountId!==id || s.dataMode!=='fixture' || !Array.isArray(s.positions) || s.positions.length>2) throw new Error('备份快照来源不支持');
    const snapshot: Snapshot={accountId:id,batchId:batch(s.batchId),asOf:time(s.asOf),dataMode:'fixture',positions:s.positions.map((raw:unknown)=> {
      const p=object(raw,['asset','quantity','price','balanceComponents'],strict);
      const a=object(p.asset,['venue','code','type','quoteCurrency'],strict);
      if (a.venue!=='BINANCE' || !['BTC','USDT'].includes(a.code) || a.type!=='crypto' || a.quoteCurrency!=='USD') throw new Error('备份资产不在批准模拟清单');
      const result: Snapshot['positions'][number]={asset:{venue:'BINANCE',code:a.code,type:'crypto',quoteCurrency:'USD'},quantity:numeric(p.quantity)};
      if (p.price!==undefined) {
        const price=object(p.price,['value','currency','asOf','source'],strict);
        if (price.currency!=='USD') throw new Error('备份价格币种无效');
        result.price={value:numeric(price.value),currency:'USD',asOf:time(price.asOf),source:'固定测试报价，不是实时行情'};
      }
      if (p.balanceComponents!==undefined) {
        const c=object(p.balanceComponents,['free','locked','freeze','withdrawing'],strict);
        result.balanceComponents=Object.fromEntries(['free','locked','freeze','withdrawing'].filter(k=>c[k]!==undefined).map(k=>[k,numeric(c[k])]));
      }
      return result;
    })};
    validateSnapshot(snapshot); canonical.snapshots[id]=snapshot;
  }
  return canonical;
}
function hostSummary(raw: unknown, strict: boolean) {
  if (raw===null || raw===undefined) return null;
  let input=raw;
  if (typeof raw==='string') { try { input=JSON.parse(raw); } catch { throw new Error('导入状态格式无效'); } }
  const v=object(input,['state','batchId','snapshotDate','reason'],strict);
  if (!['pending','verified','failed'].includes(v.state)) throw new Error('导入状态无效');
  return {state:v.state,...(v.batchId?{batchId:batch(v.batchId)}:{}),...(v.snapshotDate?{snapshotDate:time(v.snapshotDate)}:{})};
}
export function exportState(state: PortfolioState, hostStatus: unknown): string {
  return JSON.stringify({schemaVersion:1,formatVersion:2,dataMode:'fixture',state:sanitizeFixtureState(state),hostStatus:hostSummary(hostStatus,false)},null,2);
}
export function restoreState(text: string): PortfolioState {
  if (text.length>200_000) throw new Error('备份超过大小上限');
  let raw: unknown; try { raw=JSON.parse(text); } catch { throw new Error('备份 JSON 无效'); }
  const value=object(raw,['schemaVersion','formatVersion','dataMode','state','hostStatus'],true);
  if (value.schemaVersion!==1 || value.dataMode!=='fixture' || value.formatVersion!==undefined && value.formatVersion!==2) throw new Error('备份格式不支持');
  hostSummary(value.hostStatus,true);
  return sanitizeFixtureState(value.state,true);
}
