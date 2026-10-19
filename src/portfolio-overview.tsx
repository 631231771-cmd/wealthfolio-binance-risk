import {useState,useRef,useEffect,type ReactNode} from 'react';
import {nonnegative} from './domain';
import {portfolioPresentation,assetTone,heroLabel,displayAmount as money,displayPercent as percent,displayTime as time,displayQuantity,displayPrice,type Valuation,type Reference} from './portfolio-view';
import {costSummary,costHeadline,type CostBook} from './cost-basis';

// Local decorative marks only; identity always comes from the full asset code.
function AssetMark({code}:{code:string}){
  const mark=({BTC:'₿',ETH:'◆',USDC:'$',USDT:'₮',BNB:'◇',SOL:'≋',DOGE:'Ð'} as Record<string,string>)[code];
  return <span className={'asset-icon '+(mark?'coin-'+code.toLowerCase():'coin-other')} aria-hidden="true">{mark??<span className="asset-monogram">{code.slice(0,2).toUpperCase()}</span>}</span>;
}

export function PortfolioOverview({value,reference=null,costs,nativePanel}: {value:Valuation;reference?:Reference|null;costs?:CostBook;nativePanel?:ReactNode}){
  const {view,current,displayed,historical,sameBalances,state,at,balanceAt,priceFrom,priceTo}=portfolioPresentation(value,reference);
  const {report}=value;
  const [tab,setTab]=useState<'overview'|'native'|'risk'>('overview'),[selected,setSelected]=useState<string|null>(null),[showDust,setShowDust]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null);
  const row=view.rows.find(r=>r.key===selected);
  useEffect(()=>{if(row&&!dialog.current?.open)dialog.current?.showModal();if(!row&&dialog.current?.open)dialog.current.close();},[row?.key]);
  // 盈亏与当前展示的估值同口径：历史视图下也是那一份记录的成本与市值。
  const cost=costSummary(displayed.state,displayed.report,costs??{});
  const headline=costHeadline(cost);
  const gain= headline.value!==null?nonnegative(headline.value):null;
  const gainTone=gain?(gain.isZero()?'':gain.isNegative()?' is-down':' is-up'):'';
  const unavailable=state==='unavailable';
  const missing=view.rows.length-view.priced;
  // 部分覆盖时，主数值是"已定价小计"，不是完整总值；缺价项数必须紧邻显示。
  const partial=state==='live-partial';
  const coverage=`${view.priced} / ${view.rows.length} 项已估值${missing>0?` · 缺价 ${missing} 项`:''}`;
  const {title,tag}=heroLabel(state,view.rows.length>0);
  // 只有金额或覆盖范围确实不同才提示旧记录；单纯时间不同不制造第二条数字。
  const previousDiffers=reference!==null&&(money(reference.report.coveredSubtotal)!==money(displayed.report.coveredSubtotal)||reference.report.coverage!==displayed.report.coverage);
  const listed=view.allocation.filter(r=>!r.dust);
  const top3=listed.slice(0,3);
  const top3Share=top3.reduce((sum,r)=>sum.add(r.weight??'0'),nonnegative('0'));
  const dustValue=view.dust.reduce((sum,r)=>sum.add(r.value!),nonnegative('0'));
  const largest=view.allocation[0];
  const visibleRows=showDust?view.rows:view.visible;
  const list=(rows:typeof view.rows)=><div className="table-scroll"><table className="portfolio-table"><thead><tr><th>资产</th><th>数量</th><th>价格 <small>USDT</small></th><th>市值 <small>USDT</small></th></tr></thead><tbody>{rows.map(r=><tr key={r.key}>
    <td><button className="asset-button" onClick={()=>setSelected(r.key)} aria-label={'查看 '+r.code+' 详情'}><AssetMark code={r.code}/><span><strong>{r.code}</strong>{r.value===undefined&&<small>{view.balanceCurrent?'待估值':'上次数量'}</small>}</span></button></td>
    <td className="number quantity" title={r.quantity}>{displayQuantity(r.quantity)}</td><td className="number price" title={r.price?.value}>{displayPrice(r.price?.value)}</td><td className="number value">{money(r.value)}{r.value===undefined&&<small>{view.balanceCurrent?'缺少有效价格':'余额已失效'}</small>}</td>
  </tr>)}</tbody></table></div>;
  return <>
    <nav className="portfolio-tabs" aria-label="资产视图"><button aria-pressed={tab==='overview'} onClick={()=>setTab('overview')}>资产总览</button>{nativePanel&&<button aria-pressed={tab==='native'} onClick={()=>setTab('native')}>原生同步</button>}<button aria-pressed={tab==='risk'} onClick={()=>setTab('risk')}>风险分析</button></nav>
    {tab==='overview'?<>
      <section className={'portfolio-hero'+(historical?' is-history':'')} aria-label="资产总览" data-valuation={state}>
        <div className="portfolio-total"><p className={'eyebrow'+(partial?' is-partial':'')}>{title}<span className={'valuation-tag '+(state.startsWith('history')?'tag-history':state==='live'||state==='zero'?'tag-current':'')}>{tag}</span></p>
          <h2 aria-label={unavailable?'不可用':undefined}>{money(displayed.report.coveredSubtotal)} <small>USDT</small></h2>
          <p className="scope-label">{state==='history-complete'?`${time(balanceAt)} · 当时完整估值 · 不代表当前资产`:state==='history-partial'?`${time(balanceAt)} · 当时仅部分覆盖 · 不代表当前资产`:state==='zero'?'本次成功快照余额为零。':state==='unavailable'?(view.rows.length?'余额或报价已失效，暂无当前估值。':'连接后显示你的 Spot 资产'):coverage}</p>
          {!historical&&!sameBalances&&reference&&!view.complete&&previousDiffers&&<p className="previous-valuation">此前估值 {money(reference.report.coveredSubtotal)} USDT · {time(reference.at)} · {reference.report.coverage==='complete'?'当时完整':'当时部分覆盖'}<small>属于另一份余额快照，仅供历史参考，未与当前数量合并。</small></p>}
        </div>
        <div className="portfolio-summary" aria-label="估值摘要">
          <div><span>估值覆盖</span><strong>{view.rows.length?`${view.priced} / ${view.rows.length} 项`:'—'}</strong></div>
          <div><span>最大单资产</span><strong>{largest?`${largest.code} ${percent(largest.weight)}`:'—'}</strong></div>
          <div><span>{headline.label}</span><strong className={'cost-value'+gainTone}>{gain===null?'—':gain.isZero()?'0.00':`${gain.isNegative()?'-':'+'}${money(gain.abs().toFixed())}`}</strong></div>
          <p className="cost-status">{cost.state==='none'?'成本尚未核实 · 暂不显示盈亏':`${headline.pct===null?'—':(Number(headline.pct)*100).toFixed(2)+'%'} · ${cost.state==='partial'?'仅已核实成本部分':'已核实成本'}`}</p>
        </div>
        <div className="portfolio-meta"><span>余额采集 <strong>{time(balanceAt)}</strong></span><span>报价采集 <strong>{priceFrom?time(priceFrom)+(priceTo!==priceFrom?' — '+time(priceTo):''):'暂无市场报价'}</strong></span>{historical&&<span>历史记录 <strong>{time(at)}</strong></span>}</div>
      </section>
      {(historical||missing>0||(!current.balanceCurrent&&view.rows.length>0))&&<p className="coverage-callout" role="status">{historical?`${current.balanceCurrent?'报价待更新':'余额待更新'}。正在查看同一份历史估值记录，数量、金额与配置均保持当时口径。`:!current.balanceCurrent?'保留上次持仓，等待有效余额后恢复估值。':`${missing} 项资产待估值；以下小计与配置仅覆盖已定价部分，缺价不计为零。`}{historical&&missing>0&&` 当时还有 ${missing} 项缺价资产。`}</p>}
      <div className="portfolio-columns">
        <section className="portfolio-card holdings"><div className="section-heading"><h2>{historical?'历史持仓':'持仓'}</h2><span className="holdings-meta">{view.rows.length} 项资产{historical?' · 同一快照':''}{view.dust.length>0&&<button className="dust-toggle" aria-pressed={showDust} onClick={()=>setShowDust(v=>!v)}>微额 {view.dust.length} 项 · {showDust?'收起':'展开'}</button>}</span></div>
          {(showDust?view.rows.length:view.visible.length)>0&&list(visibleRows)}
          {!showDust&&view.dust.length>0&&<p className="dust-note">微额 {view.dust.length} 项 · {money(dustValue.toFixed())} USDT · 已计入{historical?'当时':'上述'}总值</p>}
          {!view.rows.length&&<div className="empty-holdings"><span aria-hidden="true">▤</span><strong>{view.balanceCurrent?'当前 Spot 没有非零持仓':'连接后显示真实Spot持仓'}</strong><p>{view.balanceCurrent?'本次成功快照余额为零。':'在连接设置中保存只读凭据并确认查询。'}</p></div>}
          <p className="card-footnote">点击资产查看详情{historical?' · 历史数量与估值':''}</p>
        </section>
        <section className="portfolio-card allocation"><div className="section-heading"><h2>{historical?'历史资产配置':'资产配置'}</h2><span>{view.complete?'全部资产':'已估值部分'}</span></div>
          {historical&&<p className="allocation-history">历史配置 · 余额 {time(balanceAt)} · 当时 {view.priced} / {view.rows.length} 项已估值{missing>0?` · 缺价 ${missing} 项`:''}</p>}
          <p className="allocation-scope">{historical?'当时':'当前'}已估值 <strong>{money(displayed.report.coveredSubtotal)} USDT</strong>{!view.complete&&<span>占比仅以这部分市值为分母{historical?null:' · '+coverage}</span>}</p>
          <div className="allocation-list">{listed.map(r=><button className="allocation-row" key={r.key} onClick={()=>setSelected(r.key)} aria-label={'查看 '+r.code+' 配置详情'}><span className="allocation-name"><i className={'allocation-dot tone-'+assetTone(r.code)}/><strong>{r.code}</strong><span>{money(r.value)}</span></span><span className="allocation-track"><i className={'tone-'+assetTone(r.code)} style={{width:(r.weight?nonnegative(r.weight).mul(100).toNumber():0)+'%'}}/></span><span className="allocation-percent">{percent(r.weight)}</span></button>)}</div>
          {listed.length>3&&<p className="allocation-concentration">前 3 项占 {percent(top3Share.toFixed())}</p>}
          {view.dust.length>0&&<div className="allocation-dust"><span>微额 · {view.dust.length} 项</span><span>{money(dustValue.toFixed())} USDT · {percent(view.dust.reduce((sum,r)=>sum.add(r.weight??'0'),nonnegative('0')).toFixed())}</span></div>}
          {!view.allocation.length&&<div className="allocation-empty">{view.balanceCurrent&&view.rows.length===0?'暂无资产配置':'等待可用估值'}<br/><small>{view.balanceCurrent&&view.rows.length===0?'零余额不计算占比':'缺价资产仍保留数量'}</small></div>}
          <p className="card-footnote">{historical?'历史配置不参与当前风险计算':'包含稳定币 · 按已估值市值排序'}</p>
        </section>
      </div>
    </>:tab==='native'?nativePanel:<section className="portfolio-card risk-page"><div className="section-heading"><h2>风险分析</h2><span>{current.complete?'当前完整估值':'当前已估值范围'}</span></div><p className="coverage-callout">{current.complete?'以下是静态压力情景，不是预测。':report.coveredSubtotal===null?'当前风险不可用。历史估值仅供查看，不参与当前风险计算。':'当前覆盖不完整，以下指标不能代表整个账户的风险。'}</p><div className="risk-metrics"><article><span>压力情景损失</span><strong>{money(report.stressLoss)} <small>USDT</small></strong><p>非 USDT 资产统一下跌 20%，包含其他稳定币。</p></article><article><span>最大单资产占比</span><strong>{percent(report.maxAssetWeight)}</strong><p>以当前已估值资产为分母。</p></article></div></section>}
    <dialog className="asset-detail" aria-labelledby="asset-detail-title" ref={dialog} onClose={()=>setSelected(null)} onClick={e=>{if(e.target===e.currentTarget)dialog.current?.close();}}>{row&&<div><header className="section-heading"><div><p className="eyebrow">{historical?'历史快照':'SPOT'} · 资产详情</p><h2 id="asset-detail-title">{row.code}</h2></div><button onClick={()=>dialog.current?.close()} aria-label="关闭资产详情">关闭</button></header><dl>
      <div><dt>{historical?'当时数量':'持有数量'}</dt><dd>{displayQuantity(row.quantity)}</dd></div>
      <div><dt>可用 / 锁定</dt><dd>{row.free===undefined?'—':displayQuantity(row.free)} / {row.locked===undefined?'—':displayQuantity(row.locked)}</dd></div>
      <div><dt>{historical?'当时价格':'当前价格'}</dt><dd>{displayPrice(row.price?.value)} USDT</dd></div><div><dt>{historical?'当时市值':'当前市值'}</dt><dd>{money(row.value)} USDT</dd></div><div><dt>持仓累计盈亏</dt><dd>— %<small>— USDT · 成本尚未核实</small></dd></div><div><dt>余额采集时间</dt><dd>{time(row.balanceAt)}</dd></div><div><dt>报价采集时间</dt><dd>{row.code==='USDT'?'同币种单位，无需市场采集':time(row.price?.asOf)}</dd></div><div><dt>报价来源</dt><dd>{row.code==='USDT'?'USDT 同币种计价':row.price?'Binance 公开 Spot ticker':'尚无已验证报价'}</dd></div>
    </dl><p className="muted">{historical?'这是一份历史记录，不代表当前资产。':'报价时间为采集时间，不是交易所成交时间。'} 未核实成本，不计算收益率。</p></div>}</dialog>
  </>;
}
