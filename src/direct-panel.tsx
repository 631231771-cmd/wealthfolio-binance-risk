import { useState,useRef,useEffect } from 'react';
import type { DirectSpot,DirectDiagnostic } from './direct-spot';
import type { BinanceCredentials } from './credentials';
import {assetKey,positionKey,nonnegative} from './domain';

const stages:Record<DirectDiagnostic['stage'],string>={idle:'连接准备',credentials:'安全存储',clock:'时间校准',permissions:'只读权限检查',balance:'Spot余额读取',identity:'账户核对',quotes:'公开报价',complete:'同步完成',disconnected:'连接控制'};
const codes:Record<string,string>={NOT_CONNECTED:'连接币安后显示真实Spot持仓。',RUNNING:'正在处理，请稍候。',OK:'最近一次同步成功。',USER_DISCONNECTED:'你已断开连接，不会再发送新请求。',PAGE_PAUSED:'页面已暂停，返回后按刷新设置继续。',READ_ONLY_REJECTED:'只读权限或IP限制未通过，余额查询已停止。',UID_MISMATCH:'返回账户与预期UID不符，未接纳该账户资产。',QUOTES_UNAVAILABLE:'余额已读取，公开报价暂不可用；缺价资产不计为零。',SPOT_AUTH:'认证未通过，请在连接设置中核对本机凭据和只读权限。',SPOT_FORBIDDEN:'访问受限，连接已停止。',SPOT_SIGNATURE:'签名校验未通过，连接已停止。',SPOT_CLOCK:'时间校准未通过，连接已停止。',SPOT_TIMEOUT:'请求超时，按现有退避规则等待重试。',SPOT_NETWORK:'网络请求失败，历史数量仍保留。',SPOT_RATE_LIMIT:'已被限流，等待冷却后再刷新。',SPOT_INVALID:'响应不完整或格式无效，未作为成功同步。',SPOT_DISCONNECTED:'连接已停止或页面暂停，迟到结果不会发布。',SPOT_BUSY:'已有请求进行中，请稍候。',INVALID_RESPONSE:'未收到有效响应，当前数据不可用。'};
export function describeDiagnostic(d:DirectDiagnostic){const known=Object.hasOwn(codes,d.code);return {stage:stages[d.stage]??'连接状态',code:known?d.code:'UNKNOWN',text:known?codes[d.code]:'操作未完成，请在连接设置中核对。'};}
const money=(v:string|null|undefined)=>v==null?'—':nonnegative(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
const percent=(v:string|null|undefined)=>v==null?'—':nonnegative(v).mul(100).toFixed(2)+'%';
const time=(v:string|undefined)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false}):'尚未同步';

export function DirectSpotPanel({reader,credentials}:{reader:DirectSpot;credentials:BinanceCredentials}) {
  const [,render]=useState(0),[message,setMessage]=useState(''),[saved,setSaved]=useState(false),[saving,setSaving]=useState(false),[settings,setSettings]=useState(false);
  const key=useRef<HTMLInputElement>(null),secret=useRef<HTMLInputElement>(null),uid=useRef<HTMLInputElement>(null);
  const risk=useRef<HTMLInputElement>(null),small=useRef<HTMLInputElement>(null),permissions=useRef<HTMLInputElement>(null),ai=useRef<HTMLInputElement>(null),reconciled=useRef<HTMLInputElement>(null);
  const {state,report}=reader.valued(),status=reader.getStatus(),diagnostic=reader.getDiagnostic(),detail=describeDiagnostic(diagnostic);
  const snapshots=Object.values(state.snapshots),positions=snapshots.flatMap(s=>s.positions.map(p=>({s,p}))),hasSnapshot=snapshots.length>0;
  const label=status.busy?'同步中':!status.connected?(hasSnapshot?'已断开':'未连接'):report.currentAccountIds.length?'已连接':hasSnapshot?'数据失效':'待验证';
  const healthy=label==='已连接',hasError=!['NOT_CONNECTED','RUNNING','OK','USER_DISCONNECTED','PAGE_PAUSED'].includes(detail.code);
  useEffect(()=>{
    let active=true;void credentials.isSaved().then(v=>{if(active)setSaved(v);}).catch(()=>{if(active)setMessage('凭据状态未知，请本人在此重新保存或清理。');});
    const visibility=()=>reader.setVisible(document.visibilityState==='visible'&&window.innerWidth>0&&window.innerHeight>0);
    visibility();document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',visibility);
    const timer=setInterval(()=>{visibility();void reader.tick().finally(()=>{if(active)render(n=>n+1);});},1000);
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',visibility);reader.setVisible(false);};
  },[reader,credentials]);
  const work=async(action:()=>Promise<void>)=>{setSaving(true);try{await action();}catch{setMessage('操作未完成，请核对本页确认项、UID或凭据状态。');setSettings(true);}finally{setSaving(false);render(n=>n+1);}};
  return <section className="monitor" aria-label="真实Spot资产监控">
    <header className="monitor-header"><div><p className="eyebrow">BINANCE · SPOT</p><h1>币安资产监控</h1><p className="muted">独立账户 · USDT计价</p></div><span className={'status-badge '+(healthy?'is-good':hasError?'is-error':'is-neutral')}>{label}</span></header>
    {(!healthy||hasError)&&<div className={'connection-notice '+(hasError?'notice-error':'')} role="status"><div><strong>{hasError?detail.stage+'未完成':status.busy?detail.stage:hasSnapshot?'当前数据不可用':'连接你的币安账户'}</strong><p>{status.busy?'正在同步，请稍候。':detail.text}</p>{hasError&&<code>{detail.stage} · {detail.code}</code>}</div><button onClick={()=>setSettings(true)}>连接设置</button></div>}
    <div className="monitor-toolbar"><span className="muted">{hasSnapshot?(report.currentAccountIds.length?'真实Spot快照':'保留上次持仓 · 已失效'):'尚无真实余额数据'}</span><div className="button-row"><button disabled={!status.connected||status.busy||saving} onClick={()=>void work(()=>reader.sync())}>{status.busy?'刷新中…':'刷新持仓'}</button><button onClick={()=>setSettings(v=>!v)} aria-expanded={settings}>连接设置</button></div></div>
    <div className="metric-grid">
      <article className="metric-card"><span>Spot 已定价资产</span><strong aria-label={report.coveredSubtotal===null?'不可用':undefined}>{money(report.coveredSubtotal)} <small>USDT</small></strong><p>{report.coverage==='complete'?'Spot估值完整':report.coverage==='partial'?`部分覆盖 · ${report.unpricedPositionCount} 项缺价`:'当前估值不可用'}</p></article>
      <article className="metric-card"><span>压力情景损失</span><strong aria-label={report.stressLoss===null?'不可用':undefined}>{money(report.stressLoss)} <small>USDT</small></strong><p>已定价非USDT资产下跌20%</p></article>
      <article className="metric-card"><span>最大单资产占比</span><strong>{percent(report.maxAssetWeight)}</strong><p>仅按当前已定价范围计算</p></article>
      <article className="metric-card"><span>最近同步</span><strong className="time-value">{time(report.lastKnownSnapshotTimes[0])}</strong><p>{hasSnapshot?(report.currentAccountIds.length?'余额采集时间':'历史快照，不代表当前资产'):'尚无有效快照'}</p></article>
    </div>
    <section className="holdings-card"><div className="section-heading"><h2>我的持仓</h2><span className="muted">{positions.length?`${positions.length} 项资产`:'真实Spot'}</span></div>
      <div className="table-scroll"><table className="holdings-table"><thead><tr><th>币种</th><th>数量</th><th>价格 <small>USDT</small></th><th>市值 <small>USDT</small></th><th>占比</th><th>状态</th></tr></thead><tbody>
      {positions.map(({s,p})=>{const eligible=report.eligiblePositionKeys.includes(positionKey(s.accountId,p.asset)),k=assetKey(p.asset);return <tr key={positionKey(s.accountId,p.asset)}><td><strong>{p.asset.code}</strong></td><td className="number">{p.quantity}</td><td className="number" title={p.price?.asOf}>{eligible&&p.price?money(p.price.value):'—'}</td><td className="number">{eligible?money(report.assetValues[k]):'—'}</td><td className="number">{eligible?percent(report.assetWeights[k]):'—'}</td><td><span className={'row-state '+(eligible?'':'muted')}>{eligible?'已定价':!report.currentAccountIds.length?'历史失效':'缺少有效价格'}</span></td></tr>;})}
      </tbody></table></div>
      {!positions.length&&<div className="empty-holdings"><span aria-hidden="true">▤</span><strong>{hasSnapshot?(report.currentAccountIds.length?'当前Spot没有非零持仓':'历史快照暂无持仓'):'连接后显示真实Spot持仓'}</strong><p>{hasSnapshot&&report.currentAccountIds.length?'本次成功快照余额为零。':'模拟账户和测试数据不会计入这里。'}</p>{!status.connected&&<button className="button-primary" onClick={()=>setSettings(true)}>设置只读连接</button>}</div>}
      {hasSnapshot&&<p className="coverage-note">{report.coverage==='complete'?'Spot资产已覆盖。':'当前仅展示可定价范围；缺价或失效资产不作为零估值。'} 数量含free与locked；USDT不等于USD。</p>}
    </section>
    <footer className="monitor-footer"><span><i className={'status-dot '+(status.auto?'is-on':'')}/>自动刷新：{status.auto?'每5分钟':status.connected?'关闭':'连接后可开启'}</span><div className="button-row">{status.auto&&<button onClick={()=>void work(async()=>reader.setAuto(false))}>关闭自动刷新</button>}<button className="button-quiet" onClick={()=>setSettings(true)}>刷新设置</button></div></footer>
    <details className="connection-settings" open={settings} onToggle={e=>setSettings(e.currentTarget.open)}><summary>连接设置</summary><div className="settings-content">
      <div className="section-heading"><h2>只读账户连接</h2><button className="button-quiet" onClick={()=>setSettings(false)}>收起</button></div>
      <p className="muted">只连接独立小额账户。凭据仅保存在本机官方secrets；填写时请暂停助手桌面观察，不要把密钥发到聊天。</p>
      <div className="settings-diagnostic"><strong>{detail.stage}</strong><code>{detail.code}</code><p>{detail.text}</p></div>
      {!status.connected&&<><div className="credential-grid"><label>预期账户 UID<input ref={uid} autoComplete="off" placeholder="独立测试账户的UID"/></label><label>API Key<input ref={key} type="password" autoComplete="off" placeholder="仅本人在本机填写"/></label><label>Secret<input ref={secret} type="password" autoComplete="off" placeholder="仅本人在本机填写"/></label></div>
      <button disabled={status.busy||saving} onClick={()=>void work(async()=>{reader.disconnect();try{await credentials.save(key.current?.value??'',secret.current?.value??'');setSaved(true);setMessage('凭据已安全保存并核验，未发送认证请求。');}finally{if(key.current)key.current.value='';if(secret.current)secret.current.value='';}})}>仅保存本机凭据</button><p className="muted">{saved?'本机已有凭据，不显示内容。':'尚未确认本机凭据。'} 保存不会自动连接。</p>
      <fieldset className="confirmation-list"><legend>首次连接前，由本人确认</legend>
      <label><input ref={risk} type="checkbox"/>接受签名URL可能进入本机宿主错误日志的剩余风险；不授权泄露Key/Secret或上传日志。</label>
      <label><input ref={small} type="checkbox"/>UID已核对，属于独立几千元测试账户，绝非主账户。</label>
      <label><input ref={permissions} type="checkbox"/>币安权限页已确认纯只读和IP限制，无交易、提现或划转权限。</label>
      <label><input ref={ai} type="checkbox"/>本测试资料库已禁止外部AI读取账户、持仓和现金，不使用旧聊天附件。</label></fieldset>
      <button className="button-primary" disabled={!saved||status.busy||saving} onClick={()=>void work(async()=>{reader.authorize(uid.current?.value??'',{risk:!!risk.current?.checked,smallAccount:!!small.current?.checked,readOnlyPage:!!permissions.current?.checked,aiIsolated:!!ai.current?.checked});await reader.sync();setMessage('');})}>本人确认并首次查询</button></>}
      <div className="settings-refresh"><h3>刷新与连接管理</h3><label className="check-label"><input ref={reconciled} type="checkbox"/>我已逐项核对本次真实持仓，同意开启自动刷新。</label><div className="button-row"><button disabled={!status.success||status.busy||saving} onClick={()=>void work(async()=>reader.setAuto(!status.auto,!!reconciled.current?.checked))}>{status.auto?'关闭自动刷新':'开启自动刷新（5分钟）'}</button><button disabled={!status.connected} onClick={()=>{reader.disconnect();render(n=>n+1);}}>断开连接</button><button disabled={status.busy||saving} className="button-danger" onClick={()=>void work(async()=>{reader.disconnect();await credentials.disconnectAndDelete();setSaved(false);setMessage('本机凭据已删除并读回为空，币安端仍需自行撤销。');})}>断开并删除本机凭据</button></div><p className="muted">仅插件页面可见时刷新；切页或最小化暂停，返回后到期补查。余额与报价6分钟失效，禁用或重启后重新确认。</p></div>
      {message&&<p className="settings-message" role="status">{message}</p>}
      <details className="help-details"><summary>安全与覆盖说明</summary><p>宿主签名URL日志风险未修复；不要上传原始日志。只读检查、UID核对及首次本人确认保持不变，不关闭TLS验证，不使用交易/提现/划转接口。不能撤回SDK已发请求，断开只阻止新请求与迟到发布。</p><p>只覆盖Spot与已审核的公开USDT市场；Funding、Stocks未支持，不代表整个币安总资产。不推断成本或收益，不写主程序账本。历史快照仅供参考，缺价不等于零。</p></details>
    </div></details>
  </section>;
}
