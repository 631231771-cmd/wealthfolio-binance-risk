import Decimal from 'decimal.js';

Decimal.set({ precision: 40 });

export interface Account {
  id: string;
  platform: string;
  sourceAccountId: string;
  name: string;
  kind: string;
  currency: string;
}
export interface AssetIdentity {
  venue: string;
  code: string;
  type: 'crypto' | 'equity' | 'cash' | 'tokenized-security' | 'unknown';
  quoteCurrency: string;
}
export interface Price { value: string; currency: string; asOf: string; source: string }
export interface Position {
  asset: AssetIdentity;
  quantity: string;
  price?: Price;
  // 保存来源的数量分解，不把某平台的字段提升为通用账户标准。
  balanceComponents?: Record<string, string>;
  liquidity?: Record<string, string | boolean>;
}
export interface Snapshot {
  accountId: string;
  batchId: string;
  asOf: string;
  dataMode: 'fixture' | 'external';
  collectionStartedAt?: string;
  collectionEndedAt?: string;
  positions: Position[];
}
export interface AccountStatus {
  state: 'ready' | 'failed' | 'unsupported' | 'uncovered';
  attemptedAt: string;
  reason?: string;
}
export interface FxRate { from: string; to: string; rate: string; asOf: string; source: string }
export interface PortfolioState {
  schemaVersion: 1;
  accounts: Account[];
  snapshots: Record<string, Snapshot>;
  statuses: Record<string, AccountStatus>;
}
export const assetKey = (a: AssetIdentity): string => JSON.stringify([a.venue, a.code, a.type, a.quoteCurrency]);
export const positionKey = (accountId: string, asset: AssetIdentity): string => JSON.stringify([accountId,assetKey(asset)]);
export const accountKey = (a: Account): string => JSON.stringify([a.platform, a.sourceAccountId, a.kind]);

export function nonnegative(value: string): Decimal {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('数量或价格格式无效');
  const result = new Decimal(value);
  if (!result.isFinite() || result.isNegative()) throw new Error('数量或价格无效');
  return result;
}
export function validateSnapshot(snapshot: Snapshot): void {
  if (!snapshot.batchId || !Number.isFinite(Date.parse(snapshot.asOf))) throw new Error('快照身份或时间无效');
  if (!['fixture','external'].includes(snapshot.dataMode)) throw new Error('数据来源无效');
  if (snapshot.dataMode === 'external') {
    const start=Date.parse(snapshot.collectionStartedAt ?? ''), end=Date.parse(snapshot.collectionEndedAt ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start>end || end!==Date.parse(snapshot.asOf)) throw new Error('外部余额必须提供真实采集起止时间');
  }
  const keys = new Set<string>();
  for (const p of snapshot.positions) {
    const key = assetKey(p.asset);
    if (!p.asset.venue || !p.asset.code || !p.asset.quoteCurrency || keys.has(key)) throw new Error('资产身份缺失或重复');
    keys.add(key);
    if (snapshot.dataMode === 'external' && (p.asset.code.startsWith('WRISKDEMO') || p.price && /fixture|固定|模拟/i.test(p.price.source))) throw new Error('外部资产不得沿用模拟身份或报价');
    nonnegative(p.quantity);
    if (p.price) {
      nonnegative(p.price.value);
      if (p.price.currency !== p.asset.quoteCurrency || !Number.isFinite(Date.parse(p.price.asOf))) throw new Error('价格币种或时间不匹配');
    }
  }
}

export type SyncResult = { accountId: string; snapshot: Snapshot } | { accountId: string; error: string };
// 一个完整批次替换快照，而不是累加余额。失败时保留旧快照，拒绝发布混合时间的总资产。
export function applyBatch(previous: PortfolioState, expected: string[], results: SyncResult[], at: string): PortfolioState {
  const next = structuredClone(previous);
  if (new Set(expected).size !== expected.length || expected.some(id => !previous.accounts.some(a => a.id === id))) throw new Error('预期账户无效');
  const valid = results.length === expected.length && new Set(results.map(r => r.accountId)).size === results.length
    && results.every(r => expected.includes(r.accountId) && 'snapshot' in r && r.snapshot.accountId === r.accountId);
  let failure = valid ? '' : '批次缺失、重复或账户查询失败';
  if (!failure) {
    try {
      const snapshots = results.map(r => (r as { snapshot: Snapshot }).snapshot);
      snapshots.forEach(validateSnapshot);
      if (new Set(snapshots.map(s => s.batchId)).size !== 1 || new Set(snapshots.map(s => s.asOf)).size !== 1) failure = '批次或快照时间不一致';
      if (new Set(snapshots.map(s=>s.dataMode)).size !== 1) failure='拒绝混合模拟与外部批次';
      if (snapshots.some(s=>s.dataMode==='external') && snapshots.length>1) failure='真实跨账户采集缺少内部划转核对依据';
    } catch { failure = '快照数据校验失败'; }
  }
  for (const id of expected) {
    next.statuses[id] = { state: failure ? 'failed' : 'ready', attemptedAt: at, ...(failure ? { reason: failure } : {}) };
    if (!failure) next.snapshots[id] = structuredClone((results.find(r => r.accountId === id) as { snapshot: Snapshot }).snapshot);
  }
  return next;
}

export interface RiskReport {
  baseCurrency: string;
  coveredSubtotal: string | null;
  total: string | null;
  lastKnownSubtotal: string | null;
  lastKnownSnapshotTimes: string[];
  lastKnownPartial: boolean;
  coverage: 'unavailable' | 'partial' | 'complete';
  currentAccountIds: string[];
  eligiblePositionKeys: string[];
  unpricedPositionCount: number;
  complete: boolean;
  accountValues: Record<string, string>;
  assetValues: Record<string, string>;
  accountWeights: Record<string, string>;
  assetWeights: Record<string, string>;
  maxAccountWeight: string | null;
  maxAssetWeight: string | null;
  accountHhi: string | null;
  assetHhi: string | null;
  stressLoss: string | null;
  issues: string[];
  fxUsed: FxRate[];
  weightsBasis: 'current-priced-covered-subset';
}
export interface FreshnessPolicy { now: string; balanceMaxAgeMs: number; priceMaxAgeMs: number; fxMaxAgeMs: number }
export const DEFAULT_FRESHNESS = {balanceMaxAgeMs:60_000,priceMaxAgeMs:120_000,fxMaxAgeMs:300_000};
export function calculateRisk(state: PortfolioState, base: string, rates: FxRate[], shocks: Record<string, string> = {}, policy: FreshnessPolicy = {now:new Date().toISOString(),...DEFAULT_FRESHNESS}): RiskReport {
  if (new Set(state.accounts.map(a => a.id)).size !== state.accounts.length || new Set(state.accounts.map(accountKey)).size !== state.accounts.length) throw new Error('重复账户身份，拒绝重复计入');
  const accounts = new Map<string, Decimal>(), assets = new Map<string, Decimal>();
  const issues: string[] = [], fxUsed: FxRate[] = [];
  const currentAccountIds: string[] = [], snapshotTimes = new Set<string>(), snapshotBatches = new Set<string>();
  const eligiblePositionKeys: string[] = [];
  let snapshotCount = 0, pricedCount = 0, unpricedPositionCount = 0, historicalPricedCount = 0, historicalUnpricedCount = 0;
  let lastKnown = new Decimal(0), loss = new Decimal(0);
  const now=Date.parse(policy.now);
  if (!Number.isFinite(now) || [policy.balanceMaxAgeMs,policy.priceMaxAgeMs,policy.fxMaxAgeMs].some(age=>!Number.isFinite(age)||age<0)) throw new Error('时效策略无效');
  const fresh=(at:string,limit:number)=>Number.isFinite(Date.parse(at)) && now>=Date.parse(at) && now-Date.parse(at)<=limit;
  const externalSnapshots=Object.values(state.snapshots).filter(s=>s.dataMode==='external');
  const unsafeAggregate=externalSnapshots.length>1 || externalSnapshots.length>0 && Object.values(state.snapshots).some(s=>s.dataMode==='fixture');
  if (unsafeAggregate) issues.push('跨账户/钱包采集尚未核对内部划转或来源混合：当前汇总与历史合计均不发布');
  if (!state.accounts.length) issues.push('尚未连接账户或没有有效快照');
  for (const account of state.accounts) {
    const snapshot = state.snapshots[account.id];
    let ready = state.statuses[account.id]?.state === 'ready';
    if (snapshot?.dataMode==='external') {
      if (account.id.startsWith('demo-') || account.sourceAccountId==='fixture-user') throw new Error('外部快照不得使用模拟账户');
      if (account.platform==='binance' && ['funding','securities'].includes(account.kind)) { issues.push(`${account.name}：资金口径或股票查询未确认，不计算总量`); continue; }
      if (!fresh(snapshot.collectionStartedAt ?? '',policy.balanceMaxAgeMs) || !fresh(snapshot.asOf,policy.balanceMaxAgeMs)) { ready=false; issues.push(`${account.name}：余额已过期或时间在未来`); }
    }
    if (!ready || !snapshot) {
      const status = state.statuses[account.id]?.state;
      const reason = status === 'unsupported' ? '尚未支持' : status === 'failed' ? '同步失败，当前数据失效' : '尚未连接或没有有效快照';
      issues.push(`${account.name}：${reason}`);
    }
    if (!snapshot) continue;
    if (snapshot.accountId !== account.id) throw new Error('快照账户身份不匹配');
    validateSnapshot(snapshot);
    snapshotCount++; snapshotTimes.add(snapshot.asOf); snapshotBatches.add(snapshot.batchId);
    if (ready) {
      currentAccountIds.push(account.id);
      // 查询成功的空持仓才是已确认的零；未查询/失败/全缺价不能据此返回零。
      if (!snapshot.positions.length) accounts.set(account.id, new Decimal(0));
    }
    for (const p of snapshot.positions) {
      if (!p.price) {
        historicalUnpricedCount++;
        if (ready) { unpricedPositionCount++; issues.push(`${account.name}/${p.asset.code}：缺少价格`); }
        continue;
      }
      const rate = p.price.currency === base ? undefined : rates.find(r => r.from === p.price!.currency && r.to === base);
      if (p.price.currency !== base && !rate) {
        historicalUnpricedCount++;
        if (ready) { unpricedPositionCount++; issues.push(`${account.name}/${p.asset.code}：${p.price.currency}/${base} 缺少汇率`); }
        continue;
      }
      const conversion = rate ? nonnegative(rate.rate) : new Decimal(1);
      if (conversion.isZero() || (rate && !Number.isFinite(Date.parse(rate.asOf)))) throw new Error('汇率无效');
      const value = nonnegative(p.quantity).mul(nonnegative(p.price.value)).mul(conversion);
      historicalPricedCount++;
      lastKnown = lastKnown.add(value);
      if (!ready) continue;
      if (snapshot.dataMode==='external' && (!fresh(p.price.asOf,policy.priceMaxAgeMs) || rate && (!fresh(rate.asOf,policy.fxMaxAgeMs) || /fixture|固定|模拟/i.test(rate.source)))) {
        unpricedPositionCount++; issues.push(`${account.name}/${p.asset.code}：价格或汇率已过期、未来或使用模拟汇率`); continue;
      }
      pricedCount++;
      eligiblePositionKeys.push(positionKey(account.id,p.asset));
      if (rate && !fxUsed.some(r => r.from === rate.from && r.to === rate.to)) fxUsed.push(rate);
      const key = assetKey(p.asset);
      accounts.set(account.id, (accounts.get(account.id) ?? new Decimal(0)).add(value));
      assets.set(key, (assets.get(key) ?? new Decimal(0)).add(value));
      const shock = new Decimal(shocks[key] ?? '0');
      if (!shock.isFinite() || shock.lt(-1) || shock.gt(1)) throw new Error('情景冲击超出允许范围');
      loss = loss.sub(value.mul(shock));
    }
  }
  const subtotal = [...accounts.values()].reduce((a,b) => a.add(b), new Decimal(0));
  const available = !unsafeAggregate && currentAccountIds.length > 0 && (pricedCount > 0 || unpricedPositionCount === 0);
  const complete = available && issues.length === 0;
  const historicalAvailable = !unsafeAggregate && snapshotCount > 0 && (historicalPricedCount > 0 || historicalUnpricedCount === 0);
  const hasWeights = available && !subtotal.isZero();
  const values = (map: Map<string, Decimal>) => Object.fromEntries([...map].map(([k,v]) => [k, v.toFixed(8)]));
  const weights = (map: Map<string, Decimal>) => hasWeights ? Object.fromEntries([...map].map(([k,v]) => [k, v.div(subtotal).toFixed(6)])) : {};
  const max = (map: Map<string, Decimal>) => hasWeights ? Decimal.max(0, ...map.values()).div(subtotal).toFixed(6) : null;
  const hhi = (map: Map<string, Decimal>) => hasWeights ? [...map.values()].reduce((sum,v) => sum.add(v.div(subtotal).pow(2)), new Decimal(0)).toFixed(6) : null;
  return {
    baseCurrency: base, coveredSubtotal: available ? subtotal.toFixed(8) : null, total: complete ? subtotal.toFixed(8) : null,
    lastKnownSubtotal: historicalAvailable ? lastKnown.toFixed(8) : null,
    lastKnownSnapshotTimes: [...snapshotTimes].sort(),
    lastKnownPartial: historicalUnpricedCount > 0 || snapshotCount < state.accounts.length || snapshotTimes.size > 1 || snapshotBatches.size > 1,
    coverage: available ? complete ? 'complete' : 'partial' : 'unavailable', currentAccountIds, eligiblePositionKeys, unpricedPositionCount,
    complete, accountValues: values(accounts), assetValues: unsafeAggregate ? {} : values(assets),
    accountWeights: weights(accounts), assetWeights: weights(assets), maxAccountWeight: max(accounts), maxAssetWeight: max(assets),
    accountHhi: hhi(accounts), assetHhi: hhi(assets), stressLoss: available ? loss.toFixed(8) : null, issues, fxUsed,
    weightsBasis: 'current-priced-covered-subset'
  };
}
