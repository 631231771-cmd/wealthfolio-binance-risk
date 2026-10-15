import { useState, useMemo, useRef, useEffect } from 'react';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { applyBatch, assetKey, positionKey, calculateRisk, nonnegative, type PortfolioState } from './domain';
import { emptyState, syncedFixture, fixtureBatch, fixtureShocks, DEMO_IDS, FIXTURE_TIME } from './fixtures';
import { exportState, restoreState, sanitizeFixtureState } from './backup';
import { DummyCredentials } from './credentials';
import { SpotOfflineReader, spotRisk, spotShock, SpotError } from './spot';
import { spotFixtureTransport, type SpotScenario } from './spot-fixture';
import { PublicMarketReader, PublicMarketError, publicMarketRisk } from './public-market';
import { SpotBridge } from './spot-bridge';
import './style.css';

export function SpotHoldingsTable({state,report,publicQuotes=false}:{state:PortfolioState;report:ReturnType<typeof spotRisk>;publicQuotes?:boolean}) {
  return <table><thead><tr><th>来源／钱包／币种</th><th>数量</th><th>报价 USDT／采集时间</th><th>当前估值 USDT</th><th>占比（已定价范围）</th><th>压力情景／损失 USDT</th><th>{publicQuotes?'报价请求起止／模拟数量估值状态':'余额采集起止／状态'}</th></tr></thead><tbody>
    {Object.values(state.snapshots).flatMap(s=>s.positions.map(p=> {
      const key=assetKey(p.asset), eligible=report.eligiblePositionKeys.includes(positionKey(s.accountId,p.asset));
      const value=eligible?report.assetValues[key]:undefined, weight=eligible?report.assetWeights[key]:undefined;
      const shock=spotShock(p.asset.code), loss=value===undefined?'不可用':nonnegative(value).mul(shock).neg().toFixed(8);
      return <tr key={positionKey(s.accountId,p.asset)}><td>{s.dataMode} / Binance / Spot / {p.asset.code} / {p.asset.type}</td><td>{p.quantity}</td><td>{p.price?`${p.price.value} / ${p.price.asOf} / ${p.price.source}`:'缺价格'}</td><td>{value??'不可用'}</td><td>{weight===undefined?'不可用':`${nonnegative(weight).mul(100).toFixed(2)}%`}</td><td>{p.asset.code==='USDT'?'同币种 0%':'回落 20%'} / {loss}</td><td>{s.collectionStartedAt} 至 {s.collectionEndedAt} / {eligible?'当前可估值':'缺估值或历史失效'}</td></tr>;
    }))}
  </tbody></table>;
}

function SpotPanel({reader,scenario}:{reader:SpotOfflineReader;scenario:{current:SpotScenario}}) {
  const [now,setNow]=useState(Date.now), [busy,setBusy]=useState(false), [message,setMessage]=useState('尚未采集模拟 Spot；先在下方保存固定假凭据。');
  const state=reader.getState();
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),10_000);return()=>{clearInterval(timer);reader.disconnect();};},[reader]);
  const report=spotRisk(state,now), amount=(value:string|null)=>value===null?'不可用':`${value} USDT`;
  const sync=async()=> {
    setBusy(true);
    try {await reader.sync();setMessage('仅固定模拟响应已处理；没有请求 Binance 或写入主程序。');}
    catch(e){setMessage(e instanceof SpotError?e.message:'离线读取失败');}
    finally {setNow(Date.now());setBusy(false);}
  };
  return <section>
    <h2>一个 Binance 账号 · Spot 离线读取链路</h2>
    <p>fixture 模拟数据，仅在本页面内存；重开页面需重做采集。Funding 未覆盖，Stocks unsupported，整个 Binance 总资产不可用。计价 USDT，不假定 USDT 等于 USD。</p>
    <label>固定响应情景 <select disabled={busy} onChange={e=>scenario.current=e.target.value as SpotScenario} defaultValue="normal">
      {(['normal','multi','multi-missing','zero','missing-price','401','403','429','signature','clock','timeout'] as const).map(value=><option key={value} value={value}>{value}</option>)}
    </select></label>
    <button disabled={busy} onClick={sync}>读取模拟 Spot／重复读取</button>
    <button onClick={()=>{reader.disconnect();setNow(Date.now());setMessage('离线读取已断开；保留历史快照。假凭据删除请使用下方专用流程。');}}>断开离线读取</button>
    <p role="status">{message}</p>
    <p>Spot 当前可估值小计：{amount(report.coveredSubtotal)}；Spot 已定价范围非 USDT 资产 -20% 情景损失：{amount(report.stressLoss)}。USDT 以自身单位计价；本情景不覆盖 USDT 兑美元脱锚。</p>
    <p>Spot 覆盖：{report.coverage}；缺估值 {report.unpricedPositionCount} 条；账户集中度 {report.accountHhi??'不可用'}；资产集中度 {report.assetHhi??'不可用'}。</p>
    <p>Spot 最近已知可估值部分：{amount(report.lastKnownSubtotal)}；{report.lastKnownSnapshotTimes.join('、')||'无快照'}。历史结果，不是当前实时资产。</p>
    <SpotHoldingsTable state={state} report={report}/>
    <ul>{report.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul>
  </section>;
}

function PublicMarketPanel({reader}:{reader:PublicMarketReader}) {
  const [now,setNow]=useState(Date.now),[busy,setBusy]=useState(false),[message,setMessage]=useState('未请求公开行情；无需任何凭据。');
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),10_000);return()=>{clearInterval(timer);reader.disconnect();};},[reader]);
  const state=reader.getState(), report=publicMarketRisk(state,now),amount=(value:string|null)=>value===null?'不可用':`${value} USDT`;
  const refresh=async()=>{setBusy(true);try{await reader.refresh();setMessage('真实公开行情已读取；仅模拟数量，未查询账户。');}catch(e){setMessage(e instanceof PublicMarketError?e.message:'公开行情失败');}finally{setNow(Date.now());setBusy(false);}};
  return <section><h2>真实市场报价 + 模拟持仓</h2>
    <p>仅 data-api.binance.vision 的公开 GET；不读取或发送 API Key、Secret、签名。数量固定为 BTC 0.4、ETH 2、BNB 10、SOL 20、DOGE 1000、USDT 4000，不是真实账户资产，也不与其他样例相加。行情仅本页面内存，不写入主程序或备份。</p>
    <button disabled={busy} onClick={refresh}>刷新真实公开行情</button>
    <button onClick={()=>{reader.disconnect();setNow(Date.now());setMessage('公开行情已断开；历史价格保留，当前不可用。');}}>断开公开行情</button>
    <button disabled={busy} onClick={()=>{reader.simulateNetworkFailure();setNow(Date.now());setMessage('已模拟网络失败（未发送请求、未改变系统网络）；当前不可用，旧报价仅供历史参考。');}}>模拟公开行情断网（不发送）</button>
    <p role="status">{message}</p>
    <p>模拟数量按当前报价估值：{amount(report.coveredSubtotal)}；非 USDT -20% 情景损失：{amount(report.stressLoss)}；覆盖 {report.coverage}；缺估值 {report.unpricedPositionCount} 条。</p>
    <p>采集时间（不是成交时间）：{report.lastKnownSnapshotTimes.join('、')||'未采集'}；最近一次服务器时间响应：{reader.getServerTime()??'未获取'}；报价有效期 120 秒，最多延迟 10 秒刷新过期显示。USDT 以自身单位计价，不假定 USD 平价。</p>
    <p>历史已知模拟估值：{amount(report.lastKnownSubtotal)}；历史价格不代表当前行情。{report.lastKnownPartial?'历史仅为可定价部分。':''}</p>
    {reader.getCooldownUntil()>now && <p>冷却至 {new Date(reader.getCooldownUntil()).toISOString()}；无自动重试。</p>}
    <SpotHoldingsTable state={state} report={report} publicQuotes/>
    <ul>{report.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul>
  </section>;
}

function BridgePanel({quotes}:{quotes:PublicMarketReader}) {
  const bridge=useMemo(()=>new SpotBridge(),[]),input=useRef<HTMLTextAreaElement>(null);
  const [now,setNow]=useState(Date.now),[message,setMessage]=useState('尚无余额快照；凭据只在独立本地读取器输入，插件不接收Key或Secret。'),[busy,setBusy]=useState(false);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),10_000);return()=>clearInterval(t);},[]);
  const {state,report}=bridge.valued(quotes.getState(),now),mode=Object.values(state.snapshots)[0]?.dataMode;
  const amount=(v:string|null)=>v===null?'不可用':`${v} USDT`;
  return <section><h2>本地读取器余额 · 独立 Spot</h2>
    <p>来源：{mode==='external'?'真实账户快照（用户本机导入）':mode==='fixture'?'辅助程序虚构验收数据':'未覆盖'}。本区不与任何旧模拟账户合计，不写主程序或备份。只支持一个来源账户；关闭页面清空会话。余额60秒、价格120秒有效；无自动余额同步。</p>
    <p>先在本地读取器生成快照，复制不含凭据的JSON到此处。读取失败也应导入失败快照；禁止粘贴API Key、Secret或完整认证响应。普通快照格式不是来源真实性的加密证明，请只导入自己刚生成的内容。</p>
    <label>本地余额快照<textarea ref={input} autoComplete="off" spellCheck={false}/></label>
    <button onClick={()=>{try{bridge.import(input.current?.value??'',Date.now());setMessage('快照已处理；请核对来源、数量、UID与时间。');}catch{setMessage('导入失败；历史数量保留，当前不可用。');}finally{if(input.current)input.current.value='';setNow(Date.now());}}}>导入本地余额快照</button>
    <button disabled={busy} onClick={async()=>{setBusy(true);try{await quotes.refresh();setMessage('真实公开报价已更新；余额数量仍来自本机导入，未发送认证请求。');}catch{setMessage('公开行情失败；保留数量及缺估值提示。');}finally{setNow(Date.now());setBusy(false);}}}>更新公开报价并估值</button>
    <p role="status">{message}</p><p>当前可估值部分：{amount(report.coveredSubtotal)}；完整Spot估值：{amount(report.total)}；情景损失：{amount(report.stressLoss)}；覆盖 {report.coverage}；缺估值 {report.unpricedPositionCount} 条。</p>
    <p>来源账户UID：{state.accounts[0]?.sourceAccountId??'未覆盖'}；余额采集时间：{report.lastKnownSnapshotTimes.join('、')||'无'}；历史可估值部分：{amount(report.lastKnownSubtotal)}（不是当前资产）。</p>
    <SpotHoldingsTable state={state} report={report}/><ul>{report.issues.map((v,i)=><li key={i}>{v}</li>)}</ul>
  </section>;
}

function RiskPage({ ctx, initial }: { ctx: AddonContext; initial: PortfolioState }) {
  const [state,setState] = useState(initial), [busy,setBusy] = useState(false), [message,setMessage] = useState('固定模拟基线；没有主程序读写权限');
  const [backup,setBackup] = useState('');
  const credentials=useMemo(()=>new DummyCredentials(ctx.api.secrets),[ctx]);
  const spotScenario=useRef<SpotScenario>('normal');
  const spotReader=useMemo(()=>new SpotOfflineReader(credentials,spotFixtureTransport(()=>spotScenario.current)),[credentials]);
  const publicReader=useMemo(()=>new PublicMarketReader({request:request=>ctx.api.network.request(request)}),[ctx]);
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
    <p className="notice">各区域来源独立：本地读取器快照与旧模拟数据不合计。旧离线报价时间：{FIXTURE_TIME}。Binance Stocks 未支持。请在独立测试资料库使用。</p>
    <p>v0.1.8 本地只读快照交接；插件真实认证请求阻断，无主程序资产读写权限。真实凭据仅在独立本地读取器输入。</p>
    <BridgePanel quotes={publicReader}/>
    <PublicMarketPanel reader={publicReader}/>
    <SpotPanel reader={spotReader} scenario={spotScenario}/>
    <h2>历史模拟基准（独立保存，不与 Spot 链路相加）</h2>
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
      <button disabled={busy} onClick={()=>run(async()=>{spotReader.disconnect();await credentials.disconnectAndDelete();return '假凭据所有槽位已删除，读回 null；保持断开。';})}>断开并删除假凭据</button>
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
