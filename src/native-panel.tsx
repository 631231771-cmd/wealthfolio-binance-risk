import {useMemo,useState} from 'react';
import {nonnegative} from './domain';
import {costSummary,costHeadline,type CostBook} from './cost-basis';
import {displayAmount as money,displayPercent as percent,displayQuantity} from './portfolio-view';
import {NativeSync,NativeSyncError,type NativeHostBridge,type NativePreview,type NativeProbe,type NativeResult} from './native-host';
import type {DirectSpot} from './direct-spot';

const errorText:Record<string,string>={
  NOT_CONFIRMED:'需要本人勾选确认后才能写入。',
  PREVIEW_STALE:'预览之后持仓或成本发生变化，请重新生成预览。',
  BLOCKED:'预览存在阻断项，未写入任何内容。',
  HOST_UNAVAILABLE:'无法读取 Wealthfolio 原生账户，未写入任何内容。',
  ACCOUNT_CREATE_FAILED:'原生账户创建失败，未写入快照。',
  SNAPSHOT_SAVE_FAILED:'快照写入失败；已写入的账户不会被删除，请检查后重试。',
  READBACK_FAILED:'快照可能已写入，但读回失败；请到原生账户核对，不要重复写入。',
  UID_INVALID:'尚未完成本人确认的账户查询。'
};
const blockedText:Record<string,string>={
  NO_USDT_RATE:'Wealthfolio 没有可用的 USDT → 基础货币汇率。为避免把错误总额写入账本，已停止写入；请先在原生设置中补齐汇率。',
  EMPTY_PORTFOLIO:'当前没有可导入的持仓或现金。',
  MISSING_COST:'需要先处理成本缺失，或显式允许仅导入数量。',
  ACCOUNT_MISMATCH:'绑定账户不是 CRYPTOCURRENCY · HOLDINGS，已停止写入。'
};

export function NativePanel({reader,host,onCosts}:{reader:DirectSpot;host?:NativeHostBridge;onCosts?:(book:CostBook)=>void}){
  const [probe,setProbe]=useState<NativeProbe|null>(null);
  const [preview,setPreview]=useState<NativePreview|null>(null);
  const [result,setResult]=useState<NativeResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [allowUnknownCost,setAllowUnknownCost]=useState(false);
  const [draft,setDraft]=useState<Record<string,string>>({});
  const sync=useMemo(()=>host?new NativeSync(host):null,[host]);
  const {state,report}=reader.valued();
  const book:CostBook=Object.fromEntries(Object.entries(draft).filter(([,v])=>v.trim()).map(([code,unitCost])=>[code,{unitCost:unitCost.trim()}]));
  const costs=costSummary(state,report,book);
  const headline=costHeadline(costs);
  const accountKey=reader.getAccountKey?.()??null;
  const rows=Object.values(state.snapshots).flatMap(s=>s.positions).sort((a,b)=>a.asset.code.localeCompare(b.asset.code));
  const signed=(value:string|null)=>{if(value===null)return '—';const n=Number(value);return `${n<0?'-':'+'}${money(Math.abs(n).toFixed(2))}`;};

  const run=async(action:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await action();}catch(error){setMessage(error instanceof NativeSyncError?(errorText[error.code]??error.code):'操作未完成，未写入任何内容。');}finally{setBusy(false);}};
  const setCost=(code:string,value:string)=>{const next={...draft,...(value.trim()?{[code]:value}:{})};if(!value.trim())delete next[code];setDraft(next);onCosts?.(Object.fromEntries(Object.entries(next).filter(([,v])=>v.trim()).map(([c,v])=>[c,{unitCost:v.trim()}])));setPreview(null);setConfirmed(false);};

  if(!host||!sync)return <section className="portfolio-card native-page"><div className="section-heading"><h2>Wealthfolio 原生账户</h2><span>不可用</span></div><p className="native-empty">当前环境没有宿主 API（浏览器预览或测试）。原生写入只在 Wealthfolio 客户端内可用。</p></section>;

  return <div className="native-page">
    <section className="portfolio-card">
      <div className="section-heading"><h2>Wealthfolio 原生账户</h2><span>{probe?(probe.bound?'已绑定':'尚未创建'):'未检测'}</span></div>
      <p className="native-lead">把当前 Binance Spot 持仓写入一个独立的 <strong>CRYPTOCURRENCY · HOLDINGS</strong> 原生账户。不会修改其他账户、历史模拟账户或已有资产的成本。</p>
      <div className="native-actions">
        <button disabled={busy||!accountKey} onClick={()=>void run(async()=>{const next=await sync.probe(accountKey!);setProbe(next);setMessage(next.available?'':'宿主不可用，未做任何写入。');})}>检测宿主能力</button>
        <button className="button-primary" disabled={busy||!accountKey} onClick={()=>void run(async()=>{const next=await sync.preview(reader.valued(),accountKey!,book,{allowUnknownCost});setPreview(next);setResult(null);setConfirmed(false);setProbe({available:true,baseCurrency:next.plan.baseCurrency,usdtRate:next.rate,accountCount:0,bound:next.bound,reasons:next.blocked});})}>生成导入预览</button>
      </div>
      {!accountKey&&<p className="native-warn">请先完成本人确认的余额查询；账户绑定使用不可逆短哈希，不保存原始 UID。</p>}
      {probe&&<dl className="native-meta">
        <div><dt>基础货币</dt><dd>{probe.baseCurrency||'—'}</dd></div>
        <div><dt>USDT → 基础货币</dt><dd>{probe.usdtRate===null?'不可用':probe.usdtRate===1?'同币种':probe.usdtRate.toFixed(6)}</dd></div>
        <div><dt>绑定账户</dt><dd>{probe.bound?`${probe.bound.name}（${probe.bound.id.slice(0,8)}）`:'将新建'}</dd></div>
      </dl>}
      {probe&&!probe.available&&<p className="native-warn">无法读取原生账户：未写入任何内容。</p>}
      {message&&<p className="native-warn" role="status">{message}</p>}
    </section>

    <section className="portfolio-card">
      <div className="section-heading"><h2>成本基础</h2><span>{headline.label}</span></div>
      <p className="native-lead">成本由本人按单位成本（USDT）录入，仅保存在本次会话，并随快照写入原生 <code>averageCost</code>。未知成本保持未知，不按零计算。</p>
      <div className="table-scroll"><table className="portfolio-table native-cost-table"><thead><tr><th>资产</th><th>数量</th><th>单位成本</th><th>市值</th><th>未实现盈亏</th></tr></thead><tbody>
        {rows.map(position=>{
          const row=costs.rows.find(r=>r.code===position.asset.code);
          const gain=row?.gain?nonnegative(row.gain):null;
          return <tr key={position.asset.code}>
            <td><strong>{position.asset.code}</strong></td>
            <td className="number quantity">{displayQuantity(position.quantity)}</td>
            <td className="number"><input className="cost-input" inputMode="decimal" aria-label={`${position.asset.code} 单位成本`} placeholder="未知" value={draft[position.asset.code]??''} onChange={e=>setCost(position.asset.code,e.target.value)}/></td>
            <td className="number value">{money(row?.value)}</td>
            <td className={'number value'+(gain?(gain.isNegative()?' is-down':' is-up'):'')}>{row?.gain?`${gain!.isNegative()?'':'+'}${money(row.gain)}${row.gainPct?` · ${percent(row.gainPct)}`:''}`:'—'}</td>
          </tr>;
        })}
      </tbody></table></div>
      <p className="native-summary">{costs.state==='none'?'尚未录入任何成本；未知成本不会按零计算。':<>已核实成本覆盖 <strong>{costs.coverage?percent(costs.coverage):'—'}</strong> · 已核实市值 {money(costs.knownValue)} USDT{costs.gain?` · 未实现 ${signed(costs.gain)} USDT`:''}{costs.state!=='complete'&&' · 仅代表已核实成本部分'}</>}</p>
    </section>

    {preview&&<section className="portfolio-card native-preview">
      <div className="section-heading"><h2>导入预览</h2><span>{preview.action==='create'?'将创建账户':'写入已绑定账户'}</span></div>
      <dl className="native-meta">
        <div><dt>账户</dt><dd>{preview.plan.label}</dd></div>
        <div><dt>快照日期</dt><dd>{preview.plan.date}{preview.existingDates.includes(preview.plan.date)?'（已存在，将覆盖当日）':''}</dd></div>
        <div><dt>持仓 / 现金</dt><dd>{preview.plan.summary.positions} 项 · USDT {money(preview.plan.summary.cash)}</dd></div>
        <div><dt>已定价小计</dt><dd>{money(preview.plan.summary.valued)} USDT</dd></div>
        {preview.rate!==null&&preview.plan.baseCurrency!=='USDT'&&preview.plan.summary.valued&&<div><dt>预计基础货币</dt><dd>≈ {money((Number(preview.plan.summary.valued)*preview.rate).toFixed(2))} {preview.plan.baseCurrency}</dd></div>}
      </dl>
      {preview.blocked.length>0&&<div className="native-blocked" role="alert">{preview.blocked.map(code=><p key={code}>{blockedText[code]??code}</p>)}</div>}
      {preview.costUnknownSymbols.length>0&&<div className="native-cost-warning">
        <p>成本未知：{preview.costUnknownSymbols.join('、')}。宿主会把缺失成本当作 0，这些资产的未实现盈亏将等于全部市值。</p>
        <label className="check-label"><input type="checkbox" checked={allowUnknownCost} onChange={e=>{setAllowUnknownCost(e.target.checked);setPreview(null);setConfirmed(false);}}/>允许这些资产仅导入数量；原生盈亏对它们不可用。</label>
      </div>}
      {preview.warnings.length>0&&<ul className="native-warnings">{preview.warnings.map((w,i)=><li key={i}>{w.symbol?`${w.symbol} · `:''}{w.detail}</li>)}</ul>}
      {preview.symbols.length>0&&<p className="native-summary">宿主预检：{preview.symbols.filter(s=>s.found).length} / {preview.symbols.length} 个符号已识别。</p>}
      <p className="native-summary">原生估值依赖报价与汇率：未写入报价的资产在原生页面按 0 计；报价按资产全局写入，可能影响其他账户中同一资产的估值；MANUAL 资产会跳过。USDT→基础货币由宿主换算，可能与插件显示不同。</p>
      <label className="check-label native-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对账户、资产、数量、成本与快照日期，确认写入这个原生账户。</label>
      <button className="button-primary" disabled={busy||!confirmed||preview.blocked.length>0} onClick={()=>void run(async()=>{const next=await sync.apply(reader.valued(),accountKey!,book,preview,'WRITE');setResult(next);setPreview(null);setConfirmed(false);setMessage('');})}>写入原生账户</button>
    </section>}

    {result&&<section className="portfolio-card">
      <div className="section-heading"><h2>写入结果</h2><span>{result.readback==='failed'?'已提交 · 未读回':result.reconcile?.ok?'读回一致':'需要核对'}</span></div>
      <dl className="native-meta">
        <div><dt>账户</dt><dd>{result.accountId.slice(0,8)} · {result.created?'本次创建':'已绑定'}</dd></div>
        <div><dt>快照</dt><dd>{result.snapshotDate} · {result.positionCount} 项持仓 · {result.cashCurrencyCount} 种现金</dd></div>
        <div><dt>读回对账</dt><dd>{result.readback==='failed'?'未完成':`${result.reconcile?.matched??0} 项一致${result.reconcile?.mismatched.length?` · ${result.reconcile.mismatched.length} 项不一致`:''}${result.reconcile?.missing.length?` · 缺失 ${result.reconcile.missing.join('、')}`:''}`}</dd></div>
        <div><dt>报价</dt><dd>已写 {result.quotesPushed} 项{result.quoteFailures?` · 失败 ${result.quoteFailures} 项`:''}</dd></div>
      </dl>
      {result.warnings.length>0&&<ul className="native-warnings">{result.warnings.map((w,i)=><li key={i}>{w}</li>)}</ul>}
      <p className="native-summary">请到 Wealthfolio 原生账户页核对持仓与总额。本插件不会自动重试或重复写入。</p>
    </section>}
  </div>;
}
