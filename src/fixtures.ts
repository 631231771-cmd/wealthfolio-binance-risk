import { normalizeFixtureBalances } from './binance';
import { applyBatch, assetKey, type PortfolioState, type Snapshot } from './domain';

export const FIXTURE_TIME = '2026-10-13T00:00:00.000Z';
export const DEMO_IDS = ['demo-spot','demo-funding'];
export const emptyState = (): PortfolioState => ({
  schemaVersion: 1,
  accounts: [
    { id: 'demo-spot', platform: 'binance', sourceAccountId: 'fixture-user', name: 'Binance Spot（模拟）', kind: 'spot', currency: 'USD' },
    { id: 'demo-funding', platform: 'binance', sourceAccountId: 'fixture-user', name: 'Binance Funding（模拟）', kind: 'funding', currency: 'USD' },
    { id: 'demo-stocks', platform: 'binance', sourceAccountId: 'fixture-user', name: 'Binance Stocks', kind: 'securities', currency: 'USD' }
  ],
  snapshots: {},
  statuses: {
    'demo-spot': { state: 'uncovered', attemptedAt: FIXTURE_TIME },
    'demo-funding': { state: 'uncovered', attemptedAt: FIXTURE_TIME },
    'demo-stocks': { state: 'unsupported', attemptedAt: FIXTURE_TIME, reason: '真实证券持仓与现金只读接口未确认；不创建虚假持仓' }
  }
});
export function fixtureBatch(transfer = false): Snapshot[] {
  const batchId = transfer ? 'fixture-transfer-v1' : 'fixture-base-v1';
  const spot = normalizeFixtureBalances('spot', { balances: [
    { asset: 'BTC', free: transfer ? '0.2' : '0.3', locked: '0.1' },
    { asset: 'USDT', free: '4000', locked: '0' }
  ] }, 'demo-spot', batchId, FIXTURE_TIME);
  const funding = normalizeFixtureBalances('funding', [
    { asset: 'BTC', free: transfer ? '0.19' : '0.09', locked: '0', freeze: '0.01', withdrawing: '0' },
    { asset: 'USDT', free: '1000', locked: '0', freeze: '0', withdrawing: '0' }
  ], 'demo-funding', batchId, FIXTURE_TIME);
  for (const s of [spot,funding]) for (const p of s.positions) p.price = { value: p.asset.code === 'BTC' ? '50000' : '1', currency: 'USD', asOf: FIXTURE_TIME, source: '固定测试报价，不是实时行情' };
  return [spot,funding];
}
export function syncedFixture(transfer = false): PortfolioState {
  return applyBatch(emptyState(), DEMO_IDS, fixtureBatch(transfer).map(snapshot => ({ accountId: snapshot.accountId, snapshot })), FIXTURE_TIME);
}
export const fixtureShocks = () => Object.fromEntries(fixtureBatch().flatMap(s => s.positions.map(p => [assetKey(p.asset), p.asset.code === 'BTC' ? '-0.2' : '-0.1'])));
