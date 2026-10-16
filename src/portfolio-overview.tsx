import {useState,useRef,useEffect} from 'react';
import {nonnegative,type Price} from './domain';
import {portfolioView,displayAmount as money,displayPercent as percent,displayTime as time,type Valuation,type Reference} from './portfolio-view';

export function PortfolioOverview({value,reference=null,history=new Map()}: {value:Valuation;reference?:Reference|null;history?:ReadonlyMap<string,Price>}){
  const view=portfolioView(value,history),{report}=value;
  const previous=reference?portfolioView(reference).rows:[];
  const [tab,setTab]=useState<'overview'|'risk'>('overview'),[selected,setSelected]=useState<string|null>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const row=view.rows.find(r=>r.key===selected);
  useEffect(()=>{if(row&&!dialog.current?.open)dialog.current?.showModal();if(!row&&dialog.current?.open)dialog.current.close();},[row?.key]);
  const historical=report.coveredSubtotal===null&&reference!==null;
  const shown=historical?reference.report.coveredSubtotal:report.coveredSubtotal;
  const title=historical?'上次估值 · 历史参考':view.complete?'Spot 资产总值':'Spot 已估值资产';
  const list=(rows:typeof view.rows)=><div className="table-scroll"><table className="portfolio-table"><thead><tr><th>资产</th><th>持有数量</th><th>价格 <small>USDT</small></th><th>市值 <small>USDT</small></th></tr></thead><tbody>{rows.map(r=>{
    const price=r.price??r.previousPrice,isOld=!r.price&&!!r.previousPrice;
    const old=previous.find(p=>p.key===r.key),oldValue=r.value===undefined?old?.value:undefined;
    return <tr key={r.key}><td><button className="asset-button" onClick={()=>setSelected(r.key)} aria-label={'查看 '+r.code+' 详情'}><span className="asset-icon" aria-hidden="true">{r.code.slice(0,1)}</span><span><strong>{r.code}</strong><small>{!r.balanceCurrent?'历史数量':r.value===undefined?'待估值':'Spot'}</small></span></button></td><td className="number">{r.quantity}</td><td className="number">{price?nonnegative(price.value).toFixed():'—'}{isOld&&<small className="history-label">历史报价</small>}</td><td className="number">{money(r.value??oldValue)}{r.value===undefined&&<small>{oldValue!==undefined?'历史市值':r.balanceCurrent?'缺少有效价格':'余额已失效'}</small>}</td></tr>;
  })}</tbody></table></div>;
  return <>
    <nav className="portfolio-tabs" aria-label="资产视图"><button aria-pressed={tab==='overview'} onClick={()=>setTab('overview')}>资产总览</button><button aria-pressed={tab==='risk'} onClick={()=>setTab('risk')}>风险分析</button></nav>
    {tab==='overview'?<>
      <section className={'portfolio-hero'+(historical?' is-history':'')} aria-label="资产总览">
        <div className="portfolio-total"><p className="eyebrow">{title}</p><h2 aria-label={shown===null?'不可用':undefined}>{money(shown)} <small>USDT</small></h2>
          <p className="scope-label">{historical?`${time(reference.at)} · ${reference.report.coverage==='complete'?'当时完整估值':'当时仅部分覆盖'}，不代表当前资产`:view.complete?`完整估值 · ${view.rows.length} 项资产`:view.rows.length?`${view.priced} / ${view.rows.length} 项已估值 · 缺价不计为零`:'连接后显示你的 Spot 资产'}</p>
          {report.coverage==='partial'&&reference?.report.coverage==='complete'&&<p className="muted">上次完整估值 {money(reference.report.coveredSubtotal)} USDT · {time(reference.at)}（历史）</p>}
        </div>
        <div className="portfolio-return"><span>持仓累计盈亏</span><strong>— <small>%</small></strong><p>— <small>USDT</small></p><span className="cost-note">成本尚未核实，暂不计算盈亏</span></div>
        <div className="portfolio-meta"><span><i className={'status-dot '+(view.balanceCurrent?'is-on':'')}/>余额 {view.balanceCurrent?'有效':'待更新'} · {time(report.lastKnownSnapshotTimes[0])}</span><span>仅 Spot · 包含锁定数量 · 不等于币安全账户</span></div>
      </section>
      {!view.complete&&view.rows.length>0&&<p className="coverage-callout" role="status">{view.balanceCurrent?'部分资产尚无有效报价，下方金额与配置仅覆盖已估值部分。':'保留上次持仓；余额已失效。公开价格可以继续更新，当前总值须等待余额同步。'}</p>}
      <div className="portfolio-columns">
        <section className="portfolio-card holdings"><div className="section-heading"><h2>持仓</h2><span>{view.rows.length} 项资产</span></div>
          {view.visible.length>0&&list(view.visible)}
          {view.dust.length>0&&<details className="dust"><summary>微额资产 · {view.dust.length} 项 <span>单项低于 0.1 USDT，已计入总值</span></summary>{list(view.dust)}</details>}
          {!view.rows.length&&<div className="empty-holdings"><span aria-hidden="true">▤</span><strong>{view.balanceCurrent?'当前 Spot 没有非零持仓':'连接后显示真实Spot持仓'}</strong><p>{view.balanceCurrent?'本次成功快照余额为零。':'在连接设置中保存只读凭据并确认查询。'}</p></div>}
          <p className="card-footnote">点击资产查看详情。未知价格保留数量，不作为微额资产隐藏。</p>
        </section>
        <section className="portfolio-card allocation"><div className="section-heading"><h2>资产配置</h2><span>{view.complete?'全部资产':'已估值部分'}</span></div>
          <p className="muted">{view.complete?'按 Spot 市值排序，包含稳定币。':'占比仅在已估值部分内计算。'}</p>
          <div className="allocation-list">{view.allocation.map((r,index)=><button className="allocation-row" key={r.key} onClick={()=>setSelected(r.key)} aria-label={'查看 '+r.code+' 配置详情'}><span className="allocation-name"><i className={'allocation-dot tone-'+index%5}/><strong>{r.code}</strong><span>{money(r.value)} <small>USDT</small></span></span><span className="allocation-track"><i className={'tone-'+index%5} style={{width:(r.weight?nonnegative(r.weight).mul(100).toNumber():0)+'%'}}/></span><span className="allocation-percent">{percent(r.weight)}</span></button>)}</div>
          {!view.allocation.length&&<div className="allocation-empty">暂无有效配置比例<br/><small>有效余额与公开价格齐备后显示</small></div>}
          {view.allocation.length>0&&<p className="card-footnote">USDT 是计价单位；其他稳定币使用市场报价。</p>}
        </section>
      </div>
    </>:<section className="portfolio-card risk-page"><div className="section-heading"><h2>风险分析</h2><span>{view.complete?'完整估值范围':'仅已估值范围'}</span></div><p className="coverage-callout">{view.complete?'以下是静态压力情景，不是预测。':'当前覆盖不完整，以下指标不能代表整个账户的风险。'}</p><div className="risk-metrics"><article><span>压力情景损失</span><strong>{money(report.stressLoss)} <small>USDT</small></strong><p>非 USDT 资产统一下跌 20%，包含其他稳定币。</p></article><article><span>最大单资产占比</span><strong>{percent(report.maxAssetWeight)}</strong><p>以当前已估值资产为分母。</p></article></div></section>}
    <dialog className="asset-detail" aria-labelledby="asset-detail-title" ref={dialog} onClose={()=>setSelected(null)} onClick={e=>{if(e.target===e.currentTarget)dialog.current?.close();}}>{row&&<div><header className="section-heading"><div><p className="eyebrow">SPOT · 资产详情</p><h2 id="asset-detail-title">{row.code}</h2></div><button onClick={()=>dialog.current?.close()} aria-label="关闭资产详情">关闭</button></header><dl>
      <div><dt>持有数量{!row.balanceCurrent?'（历史）':''}</dt><dd>{row.quantity}</dd></div><div><dt>当前价格</dt><dd>{row.price?nonnegative(row.price.value).toFixed():'—'} USDT</dd></div><div><dt>当前市值</dt><dd>{money(row.value)} USDT</dd></div>{row.value===undefined&&previous.find(p=>p.key===row.key)?.value!==undefined&&<div><dt>上次市值（历史）</dt><dd>{money(previous.find(p=>p.key===row.key)!.value)} USDT<small>当时数量 {previous.find(p=>p.key===row.key)!.quantity} · {time(reference?.at)}</small></dd></div>}<div><dt>平均成本</dt><dd>未核实</dd></div><div><dt>持仓累计盈亏</dt><dd>— %<small>— USDT · 不将未知成本当作零</small></dd></div><div><dt>余额采集时间</dt><dd>{time(row.balanceAt)}</dd></div><div><dt>报价采集时间</dt><dd>{row.code==='USDT'?'同币种单位，无需市场采集':time((row.price??row.previousPrice)?.asOf)}</dd></div><div><dt>报价来源</dt><dd>{row.code==='USDT'?'USDT 同币种计价':row.price||row.previousPrice?'Binance 公开 Spot ticker · 采集时间，非成交时间':'尚无已验证报价'}</dd></div>{!row.price&&row.previousPrice&&<div><dt>历史报价（不计当前市值）</dt><dd>{row.previousPrice.value} USDT</dd></div>}
    </dl><p className="muted">成本需要完整成交、手续费及转入来源核对。本版本未读取历史成交，不展示未经证实的收益率。</p></div>}</dialog>
  </>;
}
