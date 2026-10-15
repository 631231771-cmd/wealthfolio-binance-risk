import { useState,useRef,useEffect,type ReactNode } from 'react';
import type { DirectSpot } from './direct-spot';
import type { BinanceCredentials } from './credentials';

export function DirectSpotPanel({reader,credentials,table}:{reader:DirectSpot;credentials:BinanceCredentials;table:(value:ReturnType<DirectSpot['valued']>)=>ReactNode}) {
  const [,render]=useState(0),[message,setMessage]=useState('密钥仅由本人本机输入；保存不发送请求'),[saved,setSaved]=useState(false),[saving,setSaving]=useState(false);
  const key=useRef<HTMLInputElement>(null),secret=useRef<HTMLInputElement>(null),uid=useRef<HTMLInputElement>(null);
  const risk=useRef<HTMLInputElement>(null),small=useRef<HTMLInputElement>(null),permissions=useRef<HTMLInputElement>(null),ai=useRef<HTMLInputElement>(null),reconciled=useRef<HTMLInputElement>(null);
  const value=reader.valued(),{report}=value,status=reader.getStatus(),amount=(v:string|null)=>v===null?'不可用':`${v} USDT`;
  useEffect(()=>{
    let active=true;void credentials.isSaved().then(v=>{if(active)setSaved(v);}).catch(()=>{if(active)setMessage('凭据状态未知，请本人重新保存或清理');});
    // 宿主detachRoute只把iframe缩为0并隐藏，不保证React卸载或visibilitychange。
    const visibility=()=>reader.setVisible(document.visibilityState==='visible'&&window.innerWidth>0&&window.innerHeight>0);
    visibility();document.addEventListener('visibilitychange',visibility);window.addEventListener('resize',visibility);
    const timer=setInterval(()=>{visibility();void reader.tick().finally(()=>{if(active)render(n=>n+1);});},1000);
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',visibility);reader.setVisible(false);};
  },[reader,credentials]);
  const work=async(action:()=>Promise<void>)=>{setSaving(true);try{await action();}catch{setMessage('操作未完成；请本人核对四项确认、UID、凭据或稍后重试。没有显示原始异常');}finally{setSaving(false);render(n=>n+1);}};
  return <section className="direct-panel"><h2>真实 Spot · 直接只读连接</h2>
    <p>仅独立小额账户，不与任何模拟持仓合计，不写主程序账本/导出/备份。默认不请求；首次成功并对账后才可开启5分钟自动刷新，余额和价格6分钟失效。只支持已审核的五个公开USDT市场，其他资产保留缺价。</p>
    <p>已知剩余风险：签名URL可能进入本机Wealthfolio底层错误日志，宿主漏洞未修复。不要上传日志；插件不记录Key/Secret/签名/认证响应，不关闭TLS验证。内置AI不受本插件控制。</p>
    <label>预期小额账户 UID<input ref={uid} autoComplete="off" /></label>
    <label>本机只读 API Key<input ref={key} type="password" autoComplete="off" /></label>
    <label>本机只读 Secret<input ref={secret} type="password" autoComplete="off" /></label>
    <button disabled={status.busy||saving} onClick={()=>void work(async()=>{reader.disconnect();try{await credentials.save(key.current?.value??'',secret.current?.value??'');setSaved(true);setMessage('已通过官方secrets保存并核验；没有发送认证请求');}finally{if(key.current)key.current.value='';if(secret.current)secret.current.value='';}})}>仅保存本机只读凭据</button>
    <p>本机凭据：{saved?'已保存（不显示内容）':'尚未确认保存'}。请本人在币安权限页核对仅读取、IP限制，无交易/提现/划转权限。</p>
    <label><input ref={risk} type="checkbox"/>我接受本机签名URL日志剩余风险，不授权泄露Key/Secret或上传日志</label>
    <label><input ref={small} type="checkbox"/>我已核对预期UID属于独立几千元测试账户，不是主账户</label>
    <label><input ref={permissions} type="checkbox"/>我已在币安权限页确认纯只读和IP限制</label>
    <label><input ref={ai} type="checkbox"/>我已核对本测试资料库禁用外部AI读取账户/持仓/现金，不使用旧聊天附件</label>
    <button disabled={!saved||status.busy||saving} onClick={()=>void work(async()=>{reader.authorize(uid.current?.value??'',{risk:!!risk.current?.checked,smallAccount:!!small.current?.checked,readOnlyPage:!!permissions.current?.checked,aiIsolated:!!ai.current?.checked});await reader.sync();setMessage('首次查询流程已结束，请核对下方状态');})}>本人确认风险并首次查询</button>
    <button disabled={!status.connected||status.busy||saving} onClick={()=>void work(()=>reader.sync())}>刷新真实 Spot</button>
    <label><input ref={reconciled} type="checkbox"/>我已与币安逐项核对本次数量和账户，允许5分钟自动刷新</label>
    <button disabled={!status.success||status.busy||saving} onClick={()=>void work(async()=>reader.setAuto(!status.auto,!!reconciled.current?.checked))}>{status.auto?'关闭自动刷新':'开启自动刷新（5分钟）'}</button>
    <button onClick={()=>{reader.disconnect();render(n=>n+1);}}>断开真实连接</button>
    <button disabled={status.busy||saving} onClick={()=>void work(async()=>{reader.disconnect();await credentials.disconnectAndDelete();setSaved(false);setMessage('本机凭据已删除并读回为空；仍需在币安端撤销不再使用的Key');})}>断开并删除真实连接凭据</button>
    <p role="status">{message}；{reader.message}</p>
    <p>自动刷新：{status.auto?'已开启':'关闭'}；仅页面可见时运行，切换页面/最小化暂停，返回后到期补查；禁用/重启后需要本人重新确认。下次允许刷新：{status.auto?new Date(status.nextDue).toISOString():'无'}。</p>
    <p>真实Spot可估值小计：{amount(report.coveredSubtotal)}；完整Spot估值：{amount(report.total)}；已定价范围非USDT -20%损失：{amount(report.stressLoss)}；覆盖 {report.coverage}；缺估值 {report.unpricedPositionCount} 条。USDT不是USD。</p>
    <p>余额采集时间：{report.lastKnownSnapshotTimes.join('、')||'尚无有效快照'}；历史可定价部分：{amount(report.lastKnownSubtotal)}（不是当前资产）。Funding/Stocks未覆盖，整个Binance总资产不可用。</p>
    {table(value)}<ul>{report.issues.map((v,i)=><li key={i}>{v}</li>)}</ul>
  </section>;
}
