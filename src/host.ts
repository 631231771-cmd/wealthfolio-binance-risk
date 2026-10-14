import Decimal from 'decimal.js';
import type { HostAPI, Quote, SnapshotHoldingInput } from '@wealthfolio/addon-sdk';
import { validateSnapshot, type PortfolioState } from './domain';
import { DEMO_IDS } from './fixtures';
export { exportState, restoreState } from './backup';

export interface Host {
  accounts: Pick<HostAPI['accounts'], 'getAll' | 'create'>;
  snapshots: Pick<HostAPI['snapshots'], 'save' | 'getByDate'>;
  portfolio: Pick<HostAPI['portfolio'], 'update'>;
  quotes: Pick<HostAPI['quotes'], 'update'>;
  storage: Pick<HostAPI['storage'], 'get' | 'set'>;
}
export const DEMO_ASSETS: Record<string,{id:string;symbol:string}> = {
  BTC: { id: 'cb3b1619-6b13-4fa3-a5c0-a00000000001', symbol: 'WRISKDEMO_BTC' },
  USDT: { id: 'cb3b1619-6b13-4fa3-a5c0-a00000000002', symbol: 'WRISKDEMO_USDT' }
};
const OWNER = 'wealthfolio-binance-risk:fixture:v1';

export async function importDemoToHost(api: Host, state: PortfolioState): Promise<string> {
  for (const id of DEMO_IDS) {
    const s = state.snapshots[id];
    if (state.statuses[id]?.state !== 'ready' || !s || s.dataMode !== 'fixture') throw new Error('仅允许完整的模拟批次导入');
    if (s.positions.some(p => !DEMO_ASSETS[p.asset.code] || p.asset.venue !== 'BINANCE' || p.asset.type !== 'crypto' || p.asset.quoteCurrency !== 'USD' || !p.price || p.price.currency !== 'USD')) throw new Error('模拟资产或价格不受支持');
    validateSnapshot(s);
  }
  if (new Set(DEMO_IDS.map(id => state.snapshots[id].batchId)).size !== 1 || new Set(DEMO_IDS.map(id => state.snapshots[id].asOf)).size !== 1) throw new Error('拒绝导入混合批次');
  const quoteByAsset = new Map<string,string>();
  for (const id of DEMO_IDS) for (const p of state.snapshots[id].positions) {
    const old=quoteByAsset.get(p.asset.code);
    if (old !== undefined && old !== p.price!.value) throw new Error('同一模拟资产的报价不一致');
    quoteByAsset.set(p.asset.code,p.price!.value);
  }
  const date = state.snapshots[DEMO_IDS[0]].asOf.slice(0,10);
  await api.storage.set('host-import-status', JSON.stringify({ state: 'pending', batchId: state.snapshots[DEMO_IDS[0]].batchId }));
  try {
    const existing = await api.accounts.getAll();
    const accountIds: Record<string,string> = {};
    for (const id of DEMO_IDS) {
      const source = state.accounts.find(a => a.id === id)!;
      // 官方 v3.9.1 始终生成新的账户 UUID；上游来源标记用于复用，宿主 ID 用返回值。
      const matches = existing.filter(a => a.providerAccountId === id);
      if (matches.length > 1) throw new Error('主程序存在重复来源账户，拒绝继续写入');
      const found = matches[0];
      if (found && (found.meta !== OWNER || found.trackingMode !== 'HOLDINGS' || found.currency !== 'USD')) throw new Error('主程序账户身份冲突，拒绝覆盖');
      let hostId = found?.id;
      if (!found) {
        const created = await api.accounts.create({
          name: `WRISK 模拟验证 / ${source.kind}`, accountType: 'CRYPTOCURRENCY',
          group: '风险插件模拟验证', currency: 'USD', isDefault: false, isActive: true, isArchived: false,
          trackingMode: 'HOLDINGS', meta: OWNER, provider: 'MANUAL', providerAccountId: id,
          platformId: null, accountNumber: null
        });
        hostId = created.id;
      }
      if (!hostId) throw new Error('主程序没有返回账户标识');
      accountIds[id] = hostId;
      await api.storage.set('host-account-map-v1', JSON.stringify(accountIds));
      const holdings: SnapshotHoldingInput[] = state.snapshots[id].positions.map(p => ({
        assetId: DEMO_ASSETS[p.asset.code].id, symbol: DEMO_ASSETS[p.asset.code].symbol,
        quantity: p.quantity, currency: 'USD', quoteCcy: 'USD', instrumentType: 'CRYPTO',
        name: `固定模拟资产 ${p.asset.code}（非真实持仓）`, dataSource: 'MANUAL', averageCost: '0'
      }));
      await api.snapshots.save(hostId, holdings, {}, date);
    }
    const prices = new Map<string,Quote>();
    for (const id of DEMO_IDS) for (const p of state.snapshots[id].positions) {
      const assetId = DEMO_ASSETS[p.asset.code].id, value = Number(p.price!.value);
      prices.set(assetId, {
        id: `${assetId}_${date}_MANUAL`, assetId, dataSource: 'MANUAL', currency: 'USD',
        timestamp: `${date}T00:00:00Z`, createdAt: `${date}T00:00:00Z`,
        open: value, high: value, low: value, close: value, adjclose: value, volume: 0,
        notes: '固定模拟报价，不是成本价或实时价格'
      });
    }
    for (const [id,quote] of prices) await api.quotes.update(id,quote);
    await api.portfolio.update();
    // 读回每个持仓；有额外或缺失资产时不能报告导入成功。
    for (const id of DEMO_IDS) {
      const rows = (await api.snapshots.getByDate(accountIds[id], date)).filter(h => h.instrument);
      const expected = state.snapshots[id].positions;
      if (rows.length !== expected.length) throw new Error('主程序读回持仓数量不一致');
      for (const p of expected) {
        const row = rows.find(h => h.instrument!.id === DEMO_ASSETS[p.asset.code].id);
        if (!row || !new Decimal(String(row.quantity)).eq(p.quantity)) throw new Error('主程序读回资产或数量不一致');
      }
    }
    const status = { state: 'verified', batchId: state.snapshots[DEMO_IDS[0]].batchId, snapshotDate: date };
    await api.storage.set('host-import-status', JSON.stringify(status));
    return '两个模拟账户的持仓已保存并读回核对；请在主程序检查估值。';
  } catch {
    await api.storage.set('host-import-status', JSON.stringify({ state: 'failed', reason: '主程序写入或核对失败，可能有部分写入；可重复执行恢复核对' }));
    throw new Error('主程序写入或核对失败；可能有部分写入，不能视为完整同步成功。');
  }
}

export async function readHostSummary(api: { accounts: Pick<HostAPI['accounts'],'getAll'>; portfolio: Pick<HostAPI['portfolio'],'getHoldings'> }): Promise<{accounts:number;holdings:number}> {
  const accounts = await api.accounts.getAll();
  let holdings = 0;
  for (const a of accounts) holdings += (await api.portfolio.getHoldings(a.id)).length;
  return { accounts: accounts.length, holdings };
}

