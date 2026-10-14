import { useState, useMemo } from 'react';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { applyBatch, assetKey, positionKey, calculateRisk, type PortfolioState } from './domain';
import { emptyState, syncedFixture, fixtureBatch, fixtureShocks, DEMO_IDS, FIXTURE_TIME } from './fixtures';
import { exportState, restoreState, sanitizeFixtureState } from './backup';
import { DummyCredentials } from './credentials';
import './style.css';

function RiskPage({ ctx, initial }: { ctx: AddonContext; initial: PortfolioState }) {
  const [state,setState] = useState(initial), [busy,setBusy] = useState(false), [message,setMessage] = useState('尚未执行主程序导入验收');
  const [backup,setBackup] = useState('');
  const credentials=useMemo(()=>new DummyCredentials(ctx.api.secrets),[ctx]);
  const report = calculateRisk(state,'USD',[],fixtureShocks());
  const amount = (value: string | null) => value === null ? '不可用' : `${value} USD`;
  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try { setMessage(await work()); } catch (e) { setMessage(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  const save = async (next: PortfolioState) => {
    const safe=sanitizeFixtureState(next);
    await ctx.api.storage.set('fixture-state-v1',JSON.stringify(safe));
    setState(safe);
    return '模拟状态已替换并持久化；没有查询真实账户。';
  };
  return <main>
    <h1>币安风险插件 · 最小验证</h1>
    <p className="notice">仅固定模拟数据。报价时间：{FIXTURE_TIME}。Binance Stocks 未支持。请在独立测试资料库使用。</p>
    <p>v0.1.3 安全整改：真实认证请求阻断；本版无网络及主程序资产读写权限。固定样例不代表实时余额。</p>
    <div className="actions">
      <button disabled={busy} onClick={() => run(() => save(syncedFixture()))}>模拟同步／重复同步</button>
      <button disabled={busy} onClick={() => run(() => save(applyBatch(state,DEMO_IDS,fixtureBatch(true).map(snapshot => ({accountId:snapshot.accountId,snapshot})),FIXTURE_TIME)))}>模拟划转 0.1 BTC</button>
      <button disabled={busy} onClick={() => run(() => save(applyBatch(state,DEMO_IDS,[{accountId:'demo-spot',error:'模拟网络故障'}],FIXTURE_TIME)))}>模拟同步失败</button>
      <button disabled={busy} onClick={() => run(async () => {
        const next = syncedFixture(); delete next.snapshots['demo-spot'].positions[0].price;
        return save(next);
      })}>模拟缺价格</button>
    </div>
    <p>当前有效且有价格的资产小计：<strong>{amount(report.coveredSubtotal)}</strong></p>
    <p>当前覆盖：{report.currentAccountIds.length}/{state.accounts.length} 个账户有成功快照；{report.coverage === 'complete' ? '完整覆盖' : report.coverage === 'partial' ? '部分覆盖，仅包含当前成功且可估值范围' : '无可用的当前估值'}；无法估值持仓：{report.unpricedPositionCount} 条。完整总资产：{amount(report.total)}。</p>
    <p>最近一次已知资产（保留快照{report.lastKnownPartial ? '可估值部分，不代表完整资产' : '估值'}）：{amount(report.lastKnownSubtotal)}；快照时间：{report.lastKnownSnapshotTimes.join('、') || '无'}。历史快照，可能已失效，不是当前实时资产。</p>
    <p>已覆盖范围最大账户占比：{report.maxAccountWeight ?? '不可用'}；最大资产占比：{report.maxAssetWeight ?? '不可用'}；账户 HHI：{report.accountHhi ?? '不可用'}；资产 HHI：{report.assetHhi ?? '不可用'}。</p>
    <p>测试情景 BTC -20%、USDT -10%，当前有效已覆盖范围损失：{amount(report.stressLoss)}。仅计算当前成功且有可靠估值的部分；固定假设，不是预测。</p>
    <table><thead><tr><th>账户来源</th><th>账户状态</th><th>当前可估值金额 USD</th><th>占比（已覆盖范围）</th></tr></thead>
      <tbody>{state.accounts.map(a => <tr key={a.id}><td>{a.name}</td><td>{state.statuses[a.id]?.state} {state.statuses[a.id]?.reason}</td><td>{report.accountValues[a.id] ?? '不可用'}</td><td>{report.accountWeights[a.id] ?? '不可用'}</td></tr>)}</tbody>
    </table>
    <table><thead><tr><th>账户／资产身份</th><th>数量</th><th>固定报价 USD</th><th>全局单资产占比（已覆盖范围）</th><th>同步时间／数据身份</th></tr></thead><tbody>
      {Object.values(state.snapshots).flatMap(s => s.positions.map(p => <tr key={positionKey(s.accountId,p.asset)}><td>{s.accountId} / {p.asset.venue} / {p.asset.code} / {p.asset.type} / {p.asset.quoteCurrency}</td><td>{p.quantity}</td><td>{p.price ? `${p.price.value} / ${p.price.asOf} / ${p.price.source}` : '缺价格'}</td><td>{report.eligiblePositionKeys.includes(positionKey(s.accountId,p.asset)) ? report.assetWeights[assetKey(p.asset)] ?? '不可用' : '不可用'}</td><td>{s.asOf} / {s.dataMode}{state.statuses[s.accountId]?.state !== 'ready' ? ' / 历史失效快照' : ''}</td></tr>))}
    </tbody></table>
    <ul>{report.issues.map((issue,i) => <li key={i}>{issue}</li>)}</ul>
    <h2>假凭据安全存储验收</h2>
    <p>仅固定假凭据，不接受真实 Key/Secret。不展示凭据内容。保存和重启均不启用连接。断开删除不等于撤销交易所密钥；将来停用真实密钥还须在币安端撤销。</p>
    <div className="actions">
      <button disabled={busy} onClick={()=>run(async()=>{await credentials.save(1);return '假凭据 v1 已保存并读回核对；保持断开。';})}>保存假凭据 v1</button>
      <button disabled={busy} onClick={()=>run(async()=>{const value=await credentials.read();return value?`安全存储读回假凭据 v${value.version}；未显示内容，保持断开。`:'安全存储读回 null；无活动凭据，保持断开。';})}>读取假凭据状态</button>
      <button disabled={busy} onClick={()=>run(async()=>{await credentials.save(2);return '假凭据 v2 已替换并读回核对；保持断开。';})}>替换假凭据 v2</button>
      <button disabled={busy} onClick={()=>run(async()=>{await credentials.disconnectAndDelete();return '假凭据所有槽位已删除，读回 null；保持断开。';})}>断开并删除假凭据</button>
      <button disabled={busy} onClick={() => run(async () => {
        await ctx.api.files.openSaveDialog(exportState(state,null),'wealthfolio-binance-risk-fixture.json');
        return '已调用保存对话框；是否完成保存请检查文件。';
      })}>导出模拟状态</button>
    </div>
    <p role="status">{message}</p>
    <label>粘贴已导出的模拟 JSON（不含凭据）<textarea value={backup} onChange={e=>setBackup(e.target.value)} /></label>
    <button disabled={busy} onClick={() => run(async () => {const restored=restoreState(backup); calculateRisk(restored,'USD',[],fixtureShocks()); return save(restored);})}>恢复插件模拟状态（不自动写主程序）</button>
  </main>;
}

const enable: AddonEnableFunction = async ctx => {
  let initial = emptyState();
  const saved = await ctx.api.storage.get('fixture-state-v1');
  if (saved) {
    try { initial = restoreState(JSON.stringify({schemaVersion:1,dataMode:'fixture',state:JSON.parse(saved)})); calculateRisk(initial,'USD',[]); }
    catch { ctx.api.toast.error('已有模拟状态格式无效，未将其认定为成功同步'); }
  }
  const Page = () => <RiskPage ctx={ctx} initial={initial} />;
  ctx.router.add({ id:'wealthfolio-binance-risk',path:'/addons/wealthfolio-binance-risk',component:Page });
};
export default enable;
