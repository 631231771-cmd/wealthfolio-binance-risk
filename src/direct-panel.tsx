import { useState,useRef,useEffect } from 'react';
import {READ_ONLY_FIELDS,type DirectSpot,type DirectDiagnostic,type DirectRetry,type TimeObservation} from './direct-spot';
import type { BinanceCredentials } from './credentials';
import {SPOT_VALIDATION_REASONS,isSafeValidationPath} from './spot';
import {PortfolioOverview} from './portfolio-overview';
import {NativePanel} from './native-panel';
import type {NativeHostBridge} from './native-host';
import type {CostBook} from './cost-basis';
import {version} from '../package.json';
declare const __WRISK_BUILD__:string;
const build=typeof __WRISK_BUILD__==='undefined'?'preview':__WRISK_BUILD__;

const stages:Record<DirectDiagnostic['stage'],string>={idle:'连接准备',credentials:'安全存储',clock:'时间校准',permissions:'只读权限检查',balance:'Spot余额读取',identity:'账户核对',quotes:'公开报价',complete:'同步完成',disconnected:'连接控制'};
const codes:Record<string,string>={NOT_CONNECTED:'连接币安后显示真实Spot持仓。',RUNNING:'正在处理，请稍候。',OK:'最近一次同步成功。',USER_DISCONNECTED:'你已断开连接，不会再发送新请求。',PAGE_PAUSED:'页面已暂停，返回后按刷新设置继续。',READ_ONLY_REJECTED:'只读权限检查未通过，余额查询已停止。',UID_MISMATCH:'返回账户与预期UID不符，未接纳该账户资产。',QUOTES_UNAVAILABLE:'余额已读取，公开报价暂不可用；缺价资产不计为零。',SPOT_AUTH:'认证未通过，请在连接设置中核对本机凭据和只读权限。',SPOT_FORBIDDEN:'访问受限，连接已停止。',SPOT_SIGNATURE:'签名校验未通过，连接已停止。',SPOT_CLOCK:'时间校准未通过，连接已停止。',SPOT_TIMEOUT:'请求超时，按现有退避规则等待重试。',SPOT_NETWORK:'网络请求失败，历史数量仍保留。',SPOT_RATE_LIMIT:'已被限流，等待冷却后再刷新。',SPOT_INVALID:'响应不完整或格式无效，未作为成功同步。',SPOT_DISCONNECTED:'连接已停止或页面暂停，迟到结果不会发布。',SPOT_BUSY:'已有请求进行中，请稍候。',INVALID_RESPONSE:'未收到有效响应，当前数据不可用。'};
Object.assign(codes,{
  QUOTE_COMPLETE:'公开报价更新完成；Spot余额数量未变。',
  QUOTE_PARTIAL:'公开报价部分可用；未覆盖资产仍保持缺价。',
  QUOTE_REQUEST_FAILED:'公开行情请求失败；本次没有可用的新报价。',
  QUOTE_NO_MARKET:'没有可用的USDT现货交易对；无市场报价的资产保留数量且不估值，USDT/USDT仍按1计价。',
  QUOTE_NO_CANDIDATES:'没有需要查询的USDT现货交易对；USDT/USDT仍按1计价，其他未覆盖资产不计为零。',
  QUOTE_BUDGET_LIMITED:'公开行情覆盖受请求预算限制；未检查资产保持缺价。',
  QUOTE_RATE_LIMIT:'公开行情已被限流，停止本轮请求并等待冷却。',
  QUOTE_TIMEOUT:'公开行情等待超时；在途请求结束前不会重叠重试。',
  QUOTE_DISCONNECTED:'公开行情读取已断开；迟到报价不会发布。',
  QUOTE_BUSY:'公开行情已有请求进行中，请稍候。',
  QUOTE_INVALID:'公开行情响应无效；本轮结果未被视为成功。',
});
const permissionText={READING_DISABLED:'未启用读取。',EXTRA_PERMISSION:'检测到额外权限，拒绝继续。',PERMISSION_FIELDS_INCOMPLETE:'权限字段不完整或不是布尔值，无法确认只读。'};
codes.HOST_REQUEST_FAILED='宿主调用失败；宿主只返回字符串，无法确定TLS、DNS或原生超时。';
codes.SPOT_TIMEOUT='插件等待计时器超时；宿主在途请求可能尚未结束，暂不重叠重试。';
const clockText={SERVER_TIME_INVALID:'服务器时间字段无效',LOCAL_CLOCK_CHANGED:'本地时刻倒退/跳变或计时无效',CLOCK_SAMPLE_SLOW:'校时样本过慢',CLOCK_OFFSET_EXCESSIVE:'估计偏移过大'};
const layerText={'plugin-timer':'插件计时器超时','host-call':'宿主调用失败','http-response':'已收到HTTP响应','clock-validation':'本地校时校验','account-validation':'账户字段校验','snapshot-validation':'快照校验'};
const validationLayerText={response:'响应状态',json:'JSON解析',account:'账户结构',balance:'余额记录',snapshot:'快照结构'};
export function describeTimeObservation(row:TimeObservation){
  const d:DirectDiagnostic={stage:'clock',code:row.code,layer:row.layer,elapsedMs:row.elapsedMs,httpStatus:row.httpStatus,exchangeCode:row.exchangeCode,...(row.reason?{clock:{reason:row.reason,serverTimeValid:row.serverTimeValid===true,elapsedMs:row.elapsedMs,offsetMs:row.offsetMs}}:{})};
  const detail=describeDiagnostic(d);
  const host=row.host==='MARKET'?'MARKET':row.host==='SPOT'?'SPOT':'UNKNOWN';
  const attempt=Number.isInteger(row.attempt)&&row.attempt>=1&&row.attempt<=3?row.attempt:'?';
  return `${host} #${attempt} · ${detail.code}${detail.metadata?' · '+detail.metadata:''}${!row.reason&&typeof row.serverTimeValid==='boolean'?' · 时间字段'+(row.serverTimeValid?'有效':'无效'):''}${!row.reason&&Number.isFinite(row.offsetMs)?' · 偏移'+row.offsetMs+'ms':''}`;
}
export function describeDiagnostic(d:DirectDiagnostic){
  const known=Object.hasOwn(codes,d.code),parts:string[]=[];
  if(Number.isInteger(d.httpStatus)&&d.httpStatus!>=100&&d.httpStatus!<=599)parts.push(`HTTP ${d.httpStatus}`);
  if(Number.isSafeInteger(d.exchangeCode))parts.push(`Binance ${d.exchangeCode}`);
  if(d.layer&&Object.hasOwn(layerText,d.layer))parts.push(layerText[d.layer]);
  if(typeof d.elapsedMs==='number'&&Number.isFinite(d.elapsedMs)&&d.elapsedMs>=0)parts.push(`耗时${d.elapsedMs}ms`);
  if(typeof d.jsonValid==='boolean')parts.push(d.jsonValid?'JSON有效':'JSON无效');
  if(d.validation&&Object.hasOwn(validationLayerText,d.validation.layer)&&SPOT_VALIDATION_REASONS.includes(d.validation.reason)&&isSafeValidationPath(d.validation.path))parts.push(validationLayerText[d.validation.layer],d.validation.path,d.validation.reason);
  if(d.clock&&Object.hasOwn(clockText,d.clock.reason)){
    parts.push(d.clock.reason,clockText[d.clock.reason]);
    if(typeof d.clock.serverTimeValid==='boolean')parts.push('时间字段'+(d.clock.serverTimeValid?'有效':'无效'));
    if(typeof d.clock.offsetMs==='number'&&Number.isFinite(d.clock.offsetMs))parts.push(`偏移${d.clock.offsetMs}ms`);
  }
  if(d.code==='READ_ONLY_REJECTED')for(const item of d.permissionFields??[])if(READ_ONLY_FIELDS.includes(item.field)&&(typeof item.value==='boolean'||item.value===null))parts.push(`${item.field}=${item.value===null?'缺失/非布尔':item.value}`);
  const q=d.quote;
  if(q&&['complete','partial','request-failed','no-market','no-candidates','budget-limited'].includes(q.status)){
    const count=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=10_000?Number(value):undefined;
    const values=[
      ['候选',q.candidateCount],['已验证市场',q.marketCount],['新报价',q.pricedCount],
      ['请求失败',q.failedRequestCount],['未检查候选',q.unexaminedCount],['请求数',q.requestCount],['单项回退',q.fallbackRequestCount]
    ] as const;
    for(const [label,value] of values){const n=count(value);if(n!==undefined)parts.push(label+n);}
    if(q.budgetReason&&['request-cap','fallback-cap','candidate-cap'].includes(q.budgetReason))parts.push('覆盖限制'+q.budgetReason);
  }
  const reason=d.permissionReason&&Object.hasOwn(permissionText,d.permissionReason)?permissionText[d.permissionReason]:undefined;
  return {stage:stages[d.stage]??'连接状态',code:known?d.code:'UNKNOWN',text:known?(d.code==='SPOT_AUTH'&&d.exchangeCode===-2008?'连接资料未通过平台验证，尚未读取持仓。请本人在币安官网核对连接资料；已保存不代表有效。':d.code==='READ_ONLY_REJECTED'&&reason?reason:codes[d.code]):'操作未完成，请在连接设置中核对。',metadata:parts.join(' · ')};
}
export function describeRetry(retry:DirectRetry){
  const seconds=Number.isSafeInteger(retry.waitSeconds)&&retry.waitSeconds>0?retry.waitSeconds:0;
  switch(retry.reason){
    case 'exchange-limit':return `交易所限流冷却，${seconds}秒后可重试；断开或更换凭据不会清除`;
    case 'backoff':return `普通失败退避，${seconds}秒后可重试；修正配置后可在连接设置重新确认`;
    case 'in-flight':return '请求尚未结束，暂不可重试';
    case 'page-hidden':return '页面暂停，返回后可重试';
    case 'confirmation-required':return '等待本人在连接设置确认查询';
    default:return '可手动刷新';
  }
}
export function DirectSpotPanel({reader,credentials,onOpenDeveloper,host,nativeInitialCosts}:{reader:DirectSpot;credentials:BinanceCredentials;onOpenDeveloper?:()=>void;host?:NativeHostBridge;nativeInitialCosts?:CostBook}) {
  const [,render]=useState(0),[costs,setCosts]=useState<CostBook>({}),[message,setMessage]=useState(''),[saved,setSaved]=useState(false),[saving,setSaving]=useState(false),[settings,setSettings]=useState(false),[autoConsent,setAutoConsent]=useState(false);
  const key=useRef<HTMLInputElement>(null),secret=useRef<HTMLInputElement>(null),uid=useRef<HTMLInputElement>(null);
  const risk=useRef<HTMLInputElement>(null),small=useRef<HTMLInputElement>(null),permissions=useRef<HTMLInputElement>(null),ai=useRef<HTMLInputElement>(null),reconciled=useRef<HTMLInputElement>(null);
  const {state,report}=reader.valued(),status=reader.getStatus(),diagnostic=reader.getDiagnostic(),detail=describeDiagnostic(diagnostic);
  const snapshots=Object.values(state.snapshots),hasSnapshot=snapshots.length>0;
  const quoteDiagnostic=diagnostic.stage==='quotes',quoteCode=quoteDiagnostic?detail.code:'';
  const quoteTitle:Record<string,string>={
    QUOTE_COMPLETE:'公开行情已更新',QUOTE_NO_MARKET:'无 USDT 市场的资产',QUOTE_NO_CANDIDATES:'无需要报价的资产',
    QUOTE_PARTIAL:'公开行情部分可用',QUOTE_BUDGET_LIMITED:'公开行情覆盖受限',
    QUOTE_REQUEST_FAILED:'公开行情更新失败',QUOTE_TIMEOUT:'公开行情等待超时',QUOTE_RATE_LIMIT:'公开行情受到限流',
    QUOTE_INVALID:'公开行情响应无效',QUOTE_DISCONNECTED:'公开行情已暂停',QUOTE_BUSY:'公开行情请求进行中',RUNNING:'正在更新公开行情'
  };
  // 一个状态行同时回答"行情是否新鲜 / 多久后重试"；不再与独立提示条重复。
  const quoteCounts=diagnostic.quote;
  const quoteSeverity:'success'|'info'|'warning'|'error'=quoteCode==='QUOTE_COMPLETE'?'success'
    :['QUOTE_REQUEST_FAILED','QUOTE_TIMEOUT','QUOTE_RATE_LIMIT','QUOTE_INVALID','QUOTES_UNAVAILABLE'].includes(quoteCode)?'error'
    :['QUOTE_PARTIAL','QUOTE_BUDGET_LIMITED'].includes(quoteCode)?(quoteCode==='QUOTE_BUDGET_LIMITED'||(quoteCounts&&(quoteCounts.missingQuoteCount>0||quoteCounts.unexaminedCount>0||quoteCounts.failedRequestCount>0))?'warning':'info')
    :'info';
  const label=status.busy&&!quoteDiagnostic?'同步中':!status.connected?(hasSnapshot?'已断开':'未连接'):status.success?'已连接':'待验证';
  const quoteRetry=status.quoteRetry??status.retry;
  const quoteWait=quoteRetry.reason==='exchange-limit'?`限流冷却 ${quoteRetry.waitSeconds} 秒`
    :quoteRetry.reason==='backoff'?`${quoteRetry.waitSeconds} 秒后重试`:'';
  const quoteDetail=quoteCounts?[
    quoteCounts.missingQuoteCount>0?`${quoteCounts.missingQuoteCount} 项暂缺报价`:'',
    quoteCounts.retainedCount>0?`${quoteCounts.retainedCount} 项沿用有效期报价`:'',
    quoteCounts.noMarketCount>0?`${quoteCounts.noMarketCount} 项无 USDT 市场`:''
  ].filter(Boolean).join(' · '):'';
  const steady=['QUOTE_COMPLETE','QUOTE_PARTIAL','QUOTE_BUDGET_LIMITED'].includes(quoteCode);
  const quoteLine=quoteDiagnostic
    ? [quoteTitle[quoteCode]??'公开行情状态',quoteDetail,steady?'每分钟':quoteWait].filter(Boolean).join(' · ')
    : status.success?'行情每分钟更新 · 页面可见时':'只读连接 · 凭据保存在本机';
  const healthy=label==='已连接',hasError=!['NOT_CONNECTED','RUNNING','OK','USER_DISCONNECTED','PAGE_PAUSED'].includes(detail.code)&&!quoteDiagnostic;
  const mainMessage=detail.code==='HOST_REQUEST_FAILED'?'连接请求未完成，上次资产记录仍保留。请查看原因与重试时间。':detail.code==='SPOT_TIMEOUT'?'本次请求等待超时，上次资产记录仍保留。请等待重试提示。':detail.text;
  useEffect(()=>{if(!status.connected||!status.success)setAutoConsent(false);},[status.connected,status.success]);
  useEffect(()=>{
    let active=true;void credentials.isSaved().then(v=>{if(active)setSaved(v);}).catch(()=>{if(active)setMessage('凭据状态未知，请本人在此重新保存或清理。');});
    const visibility=()=>reader.setVisible(document.visibilityState==='visible'&&window.innerWidth>0&&window.innerHeight>0);
    visibility();document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',visibility);
    const timer=setInterval(()=>{visibility();void reader.tick().finally(()=>{if(active)render(n=>n+1);});},1000);
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',visibility);reader.setVisible(false);};
  },[reader,credentials]);
  const work=async(action:()=>Promise<void>)=>{setSaving(true);try{await action();}catch{setMessage('操作未完成，请核对本页确认项、UID或凭据状态。');setSettings(true);}finally{setSaving(false);render(n=>n+1);}};
  return <section className="monitor" aria-label="真实Spot资产监控">
    <header className="monitor-header"><div className="workspace-title"><span className="exchange-mark" aria-hidden="true">◇</span><div><p className="eyebrow">BINANCE / SPOT</p><h1>我的资产</h1></div><span className={'status-badge '+(hasError?'is-error':healthy?'is-good':'is-neutral')}>{hasError&&status.connected?'更新未完成':label}</span></div><div className="button-row"><button disabled={!status.retry.canRetry||saving} title={describeRetry(status.retry)} onClick={()=>void work(()=>reader.sync())}>{status.busy&&!quoteDiagnostic?'同步中…':'同步余额'}</button><button disabled={!status.success||!quoteRetry.canRetry||saving} title={describeRetry(quoteRetry)} onClick={()=>void work(()=>reader.refreshQuotes())}>{status.busy&&quoteDiagnostic?'更新中…':'刷新行情'}</button><button className="button-quiet" onClick={()=>setSettings(v=>!v)} aria-expanded={settings}>连接设置</button></div></header>
    {(!hasSnapshot||hasError||!status.connected)&&<div className={'connection-notice '+(hasError?'notice-error':'')} role="status"><div><strong>{hasError?detail.stage+'未完成':status.busy?detail.stage:hasSnapshot?'已断开 · 保留上次持仓':'连接你的币安账户'}</strong><p>{mainMessage}</p>{hasError&&<code>{detail.stage} · {detail.code}{detail.code==='SPOT_INVALID'&&detail.metadata?' · '+detail.metadata:''}</code>}</div><button onClick={()=>setSettings(true)}>查看连接设置</button></div>}
    <div className="monitor-toolbar" data-quote-state={quoteDiagnostic?quoteSeverity:undefined}>
      <span className={'quote-line'+(quoteSeverity==='error'?' notice-error':quoteSeverity==='warning'?' notice-warning':'')} role="status"><i className={'status-dot '+(status.connected?'is-on':'')}/>{quoteLine}{quoteDiagnostic&&quoteSeverity==='error'&&<button className="button-quiet" onClick={()=>setSettings(true)}>查看原因</button>}</span>
      {status.success&&<details className="auto-options"><summary>余额：{status.auto?'自动 · 每5分钟':'手动'} <span>⌄</span></summary><div><strong>本次会话自动同步</strong><p>每5分钟同步余额。切页或最小化暂停。</p><label className="check-label"><input ref={reconciled} type="checkbox" checked={autoConsent} onChange={e=>setAutoConsent(e.target.checked)}/>我已逐项核对本次持仓，同意自动同步余额。</label><button disabled={status.busy||saving||(!status.auto&&!autoConsent)} onClick={()=>void work(async()=>reader.setAuto(!status.auto,!!reconciled.current?.checked))}>{status.auto?'关闭余额自动同步':'确认开启 · 每5分钟'}</button></div></details>}
    </div>
    <PortfolioOverview value={{state,report}} reference={reader.getReference?.()} costs={costs} nativePanel={host?<NativePanel reader={reader} host={host} onCosts={setCosts} initialCosts={nativeInitialCosts}/>:undefined}/>
    <footer className="monitor-footer"><span>仅 Spot · USDT 计价 · 只读</span><span className="build-label">Binance Risk {version} · {build}</span></footer>
    <details className="connection-settings" open={settings} onToggle={e=>setSettings(e.currentTarget.open)}><summary>连接设置</summary><div className="settings-content">
      <div className="section-heading"><h2>只读账户连接</h2><button className="button-quiet" onClick={()=>setSettings(false)}>收起</button></div>
      <p className="muted">只连接独立小额账户。凭据仅保存在本机官方secrets；填写时请暂停助手桌面观察，不要把密钥发到聊天。</p>
      <div className="settings-diagnostic"><strong>{detail.stage}</strong><code>{detail.code}{detail.metadata?' · '+detail.metadata:''}</code><p>{detail.text}</p><p>{describeRetry(status.retry)}</p>
      {reader.getTimeObservations().map(row=><p key={'clock-'+row.attempt}>{describeTimeObservation(row)}</p>)}
      <button disabled={status.connected||status.busy||saving||status.retry.reason==='exchange-limit'} onClick={()=>void work(()=>reader.testPublicTime())}>公开时间对照（不读凭据）</button>
      <p className="muted">MARKET为公开行情主机，SPOT为币安主机；仅GET公开time，每个主机最多3次串行采样，不查询账户。结果只在本次页面内保留。</p>
      {reader.getPublicObservations().map(row=><p key={row.host+'-'+row.attempt}>{describeTimeObservation(row)}</p>)}
      </div>
      {!status.success&&<><div className="credential-grid"><label>预期账户 UID<input ref={uid} autoComplete="off" placeholder="独立测试账户的UID"/></label><label>API Key<input ref={key} type="password" autoComplete="off" placeholder="仅本人在本机填写"/></label><label>Secret<input ref={secret} type="password" autoComplete="off" placeholder="仅本人在本机填写"/></label></div>
      <button disabled={status.busy||saving} onClick={()=>void work(async()=>{reader.disconnect();try{await credentials.save(key.current?.value??'',secret.current?.value??'');setSaved(true);setMessage('凭据已安全保存并核验，未发送认证请求。');}finally{if(key.current)key.current.value='';if(secret.current)secret.current.value='';}})}>仅保存本机凭据</button><p className="muted">{saved?'本机存有连接资料，但尚未验证可用。':'尚未发现已保存的连接资料。'} 保存不会自动连接。</p>
      <fieldset className="confirmation-list"><legend>首次连接前，由本人确认</legend>
      <label><input ref={risk} type="checkbox"/>接受签名URL可能进入本机宿主错误日志的剩余风险；不授权泄露Key/Secret或上传日志。</label>
      <label><input ref={small} type="checkbox"/>UID已核对，属于独立几千元测试账户，绝非主账户。</label>
      <label><input ref={permissions} type="checkbox"/>币安权限页已确认纯只读，无交易、提现或划转权限；仅连接独立小额账户，接受未设IP白名单时连接资料泄露后资产信息可能被他人读取的风险。</label>
      <label><input ref={ai} type="checkbox"/>本测试资料库已禁止外部AI读取账户、持仓和现金，不使用旧聊天附件。</label></fieldset>
      <button className="button-primary" disabled={!saved||status.busy||saving||status.retry.reason==='exchange-limit'} onClick={()=>void work(async()=>{reader.authorize(uid.current?.value??'',{risk:!!risk.current?.checked,smallAccount:!!small.current?.checked,readOnlyPage:!!permissions.current?.checked,aiIsolated:!!ai.current?.checked});await reader.sync();setMessage('');})}>本人确认并首次查询</button></>}
      <div className="settings-refresh"><h3>连接管理</h3><div className="button-row"><button disabled={!status.connected} onClick={()=>{reader.disconnect();render(n=>n+1);}}>断开连接</button><button disabled={status.busy||saving} className="button-danger" onClick={()=>void work(async()=>{reader.disconnect();await credentials.disconnectAndDelete();setSaved(false);setMessage('本机凭据已删除并读回为空，币安端仍需自行撤销。');})}>断开并删除本机凭据</button></div><p className="muted">余额6分钟、报价2分钟失效；历史估值保留在本次会话，不参与当前风险计算。禁用或重启后需重新确认连接。余额自动同步在首页“余额：手动”中由本人开启。</p></div>
      {onOpenDeveloper&&<button className="button-quiet" onClick={onOpenDeveloper}>进入开发工作台（模拟数据）</button>}
      {message&&<p className="settings-message" role="status">{message}</p>}
      <details className="help-details"><summary>安全与覆盖说明</summary><p>宿主签名URL日志风险未修复；不要上传原始日志。只读检查、UID核对及首次本人确认保持不变，不关闭TLS验证，不使用交易/提现/划转接口。不能撤回SDK已发请求，断开只阻止新请求与迟到发布。</p><p>只覆盖Spot与已审核的公开USDT市场；Funding、Stocks未支持，不代表整个币安总资产。不推断成本或收益，不写主程序账本。历史快照仅供参考，缺价不等于零。</p></details>
    </div></details>
  </section>;
}
