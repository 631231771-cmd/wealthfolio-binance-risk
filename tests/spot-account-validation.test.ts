import test from 'node:test';
import assert from 'node:assert/strict';
import type {NetworkAPI,NetworkResponse} from '@wealthfolio/addon-sdk';
import {spotSnapshot,validateSpotAccount,SpotValidationError,isSafeValidationPath} from '../src/spot';
import {validateSnapshot,SnapshotValidationError} from '../src/domain';
import {describeDiagnostic} from '../src/direct-panel';
import {DirectSpot} from '../src/direct-spot';
import {BinanceCredentials} from '../src/credentials';
import {PublicMarketReader} from '../src/public-market';

const TIME='2026-10-15T00:00:00.000Z',T=Date.parse(TIME);
const account=(rows:unknown[]=[])=>({uid:7,accountType:'SPOT',balances:rows});
const row=(asset='FAKE',free='1',locked='0')=>({asset,free,locked});
async function runBalance(body:unknown,transport?:Partial<NetworkResponse>,nativeError?:unknown){
 const store=new Map<string,string>();const credentials=new BinanceCredentials({get:async k=>store.get(k)??null,set:async(k,v)=>{store.set(k,v);},delete:async k=>{store.delete(k);}});
 await credentials.save('TEST_KEY_NOT_REAL','TEST_SECRET_NOT_REAL');
 const permissions={enableReading:true,ipRestrict:false,enableWithdrawals:false,enableInternalTransfer:false,enableMargin:false,enableFutures:false,permitsUniversalTransfer:false,enableVanillaOptions:false,enableFixApiTrade:false,enableSpotAndMarginTrading:false,enablePortfolioMarginTrading:false};
 let wall=T,mono=0;const calls:string[]=[];
 const network:Pick<NetworkAPI,'request'>={request:async req=>{const path=new URL(req.url).pathname;calls.push(path);wall+=100;mono+=100;if(path==='/api/v3/account'&&nativeError!==undefined)throw nativeError;let data:unknown=path.endsWith('/time')?{serverTime:wall-50}:path.endsWith('apiRestrictions')?permissions:body;return {status:200,headers:{},body:JSON.stringify(data),...(path==='/api/v3/account'?transport:{})} satisfies NetworkResponse;}};
 const reader=new DirectSpot(credentials,network,new PublicMarketReader(network,()=>wall),()=>wall,100,()=>mono);
 reader.setVisible(true);reader.authorize('7',{risk:true,smallAccount:true,readOnlyPage:true,aiIsolated:true});await reader.sync();return {reader,calls};
}
test('虚构UTF8资产的零余额不能误拒绝其他有效资产，非零数量原样保留',()=>{
 const result=spotSnapshot(account([row('虚构资产甲','0'),row('虚构资产乙','0.00000001','0.2'),row('FAKE','3')]),'external',TIME,TIME);
 assert.equal(result.snapshot.positions.length,2);assert.equal(result.snapshot.positions[0].asset.code,'虚构资产乙');assert.equal(result.snapshot.positions[0].quantity,'0.20000001');
});
test('官方结构数值UID/SPOT/余额数组符合契约；不回退到预期UID或空数组',()=>{
 assert.equal(validateSpotAccount(account()).uid,'7');
 const cases:[unknown,string,string][]=[
  [null,'$','OBJECT_REQUIRED'],[[],'$','OBJECT_REQUIRED'],['fake','$','OBJECT_REQUIRED'],
  [{...account(),uid:undefined},'uid','FIELD_MISSING'],[{...account(),uid:'7'},'uid','UID_NOT_SAFE_POSITIVE_INTEGER'],[{...account(),uid:Number.MAX_SAFE_INTEGER+1},'uid','UID_NOT_SAFE_POSITIVE_INTEGER'],[{...account(),uid:0},'uid','UID_NOT_SAFE_POSITIVE_INTEGER'],
  [{...account(),accountType:undefined},'accountType','FIELD_MISSING'],[{...account(),accountType:'MARGIN'},'accountType','ACCOUNT_TYPE_NOT_SPOT'],
  [{uid:7,accountType:'SPOT'},'balances','FIELD_MISSING'],[{...account(),balances:null},'balances','ARRAY_REQUIRED'],[{...account(),balances:{}},'balances','ARRAY_REQUIRED'],[account(Array(10001).fill(row())),'balances','COLLECTION_LIMIT']];
 for(const [value,path,reason] of cases)assert.throws(()=>validateSpotAccount(value),(e:unknown)=>e instanceof SpotValidationError&&e.validation.path===path&&e.validation.reason===reason);
});
test('零与极小非零正确处理；未知身份原样保留、不规范化或合并',()=>{
 const input=account([row('虚构零','0.000','0.000'),row('资产-é','0.'+'0'.repeat(60)+'1'),row('资产-e\u0301','2'),row('Unknown.Mixed_1','3.5','0.5')]);
 const {snapshot}=spotSnapshot(input,'external',TIME,TIME);assert.equal(snapshot.positions.length,3);assert.notEqual(snapshot.positions[0].quantity,'0');assert.equal(snapshot.positions[1].asset.code,'资产-e\u0301');assert.equal(snapshot.positions[2].quantity,'4');assert.ok(snapshot.positions.every(p=>p.asset.type==='unknown'&&!p.price));
 const zero=spotSnapshot(account([row('虚构零','0')]),'external',TIME,TIME);assert.deepEqual(zero.snapshot.positions,[]);
});
test('坏行/资产/数量/重复仍拒绝全账户，零余额也不掩盖无效结构',()=>{
 const cases:[unknown,string,string][]=[
  [null,'balances[0]','OBJECT_REQUIRED'],[[],'balances[0]','OBJECT_REQUIRED'],[{},'balances[0].asset','FIELD_MISSING'],[row(''),'balances[0].asset','ASSET_ID_INVALID'],[row('坏\n标识'),'balances[0].asset','ASSET_ID_INVALID'],[row('坏\u202e标识'),'balances[0].asset','ASSET_ID_INVALID'],[row('坏\ud800标识'),'balances[0].asset','ASSET_ID_INVALID'],[row('字'.repeat(100)),'balances[0].asset','ASSET_ID_INVALID'],[row('WRISKDEMO_X'),'balances[0].asset','FIXTURE_IDENTITY_FORBIDDEN'],
  [{asset:'FAKE',locked:'0'},'balances[0].free','FIELD_MISSING'],[{...row(),free:1},'balances[0].free','DECIMAL_STRING_REQUIRED'],[row('FAKE','1'.repeat(81)),'balances[0].free','DECIMAL_LENGTH_LIMIT'],[row('FAKE','-1'),'balances[0].free','DECIMAL_INVALID'],[row('FAKE','1e-8'),'balances[0].free','DECIMAL_INVALID'],[row('FAKE','NaN'),'balances[0].free','DECIMAL_INVALID'],[row('FAKE','1','-1'),'balances[0].locked','DECIMAL_INVALID']];
 for(const [value,path,reason] of cases)assert.throws(()=>validateSpotAccount(account([value])),(e:unknown)=>e instanceof SpotValidationError&&e.validation.path===path&&e.validation.reason===reason);
 assert.throws(()=>validateSpotAccount(account([row('重复'),row('重复','0')])),(e:unknown)=>e instanceof SpotValidationError&&e.validation.reason==='DUPLICATE_ASSET'&&e.validation.path==='balances[1].asset');
});
test('HTTP200非JSON/大响应/非文本明确层级，未知JSON根不伪装空账户',async()=>{
 for(const [body,reason,jsonValid] of [['SENSITIVE not JSON','JSON_INVALID',false],['X'.repeat(2*1024*1024+1),'RESPONSE_TOO_LARGE',undefined],[null,'RESPONSE_BODY_NOT_TEXT',undefined]] as const){
  const {reader}=await runBalance(account(),{body:body as any});const d=reader.getDiagnostic();assert.equal(d.code,'SPOT_INVALID');assert.equal(d.httpStatus,200);assert.equal(d.layer,'http-response');assert.equal(d.jsonValid,jsonValid);assert.equal(d.validation?.reason,reason);assert.equal(d.validation?.path,'$');assert.equal(reader.getStatus().success,false);assert.ok(!JSON.stringify(d).includes('SENSITIVE'));
 }
 const {reader}=await runBalance([]);assert.equal(reader.getDiagnostic().jsonValid,true);assert.equal(reader.getDiagnostic().validation?.reason,'OBJECT_REQUIRED');assert.equal(reader.valued().report.coveredSubtotal,null);
});
test('字段缺失不会被当成HTTP/JSON失败，原生拒绝不继承权限HTTP200',async()=>{
 const schema=await runBalance({...account(),uid:undefined});assert.equal(schema.reader.getDiagnostic().httpStatus,200);assert.equal(schema.reader.getDiagnostic().jsonValid,true);assert.equal(schema.reader.getDiagnostic().validation?.path,'uid');
 const native=await runBalance(account(),undefined,'SENSITIVE signature=RAW');const d=native.reader.getDiagnostic();assert.equal(d.stage,'balance');assert.equal(d.code,'HOST_REQUEST_FAILED');assert.equal(d.httpStatus,undefined);assert.equal(d.jsonValid,undefined);assert.equal(d.validation,undefined);
 const http=await runBalance({code:-9999,msg:'SENSITIVE'},{status:400});assert.equal(http.reader.getDiagnostic().httpStatus,400);assert.equal(http.reader.getDiagnostic().exchangeCode,-9999);assert.equal(http.reader.getDiagnostic().jsonValid,true);assert.equal(http.reader.getDiagnostic().validation?.reason,'HTTP_REJECTED');
});
test('快照各拒绝分支提供固定原因和真实结构路径，不携带字段值',()=>{
 const make=()=>spotSnapshot(account([row('PRIVATE_ASSET')]),'external',TIME,TIME).snapshot;
 const cases:[(s:ReturnType<typeof make>)=>void,string,string][]=[
  [s=>{s.batchId='';},'snapshot.batchId','SNAPSHOT_BATCH_INVALID'],[s=>{s.asOf='bad';},'snapshot.asOf','SNAPSHOT_TIME_INVALID'],[s=>{s.dataMode='bad' as any;},'snapshot.dataMode','SNAPSHOT_SOURCE_INVALID'],[s=>{s.collectionStartedAt='bad';},'snapshot.collectionStartedAt','SNAPSHOT_COLLECTION_INVALID'],[s=>{s.collectionEndedAt='bad';},'snapshot.collectionEndedAt','SNAPSHOT_COLLECTION_INVALID'],[s=>{s.positions[0].asset.code='';},'snapshot.positions[0].asset','ASSET_IDENTITY_INVALID'],[s=>{s.positions.push(structuredClone(s.positions[0]));},'snapshot.positions[1].asset','DUPLICATE_ASSET'],[s=>{s.positions[0].asset.code='WRISKDEMO_X';},'snapshot.positions[0].asset','FIXTURE_IDENTITY_FORBIDDEN'],[s=>{s.positions[0].quantity='-1';},'snapshot.positions[0].quantity','DECIMAL_INVALID'],[s=>{s.positions[0].price={value:'-1',currency:'USDT',asOf:TIME,source:'external:test'};},'snapshot.positions[0].price.value','DECIMAL_INVALID'],[s=>{s.positions[0].price={value:'1',currency:'USD',asOf:TIME,source:'external:test'};},'snapshot.positions[0].price','PRICE_METADATA_INVALID']];
 for(const [mutate,path,reason] of cases){const s=make();mutate(s);assert.throws(()=>validateSnapshot(s),(e:unknown)=>e instanceof SnapshotValidationError&&e.path===path&&e.reason===reason&&isSafeValidationPath(e.path)&&!JSON.stringify(e).includes('PRIVATE_ASSET'));}
 assert.throws(()=>spotSnapshot(account(),'external','bad',TIME),(e:unknown)=>e instanceof SpotValidationError&&e.validation.path==='snapshot.collectionStartedAt');
});
test('安全摘要白名单拒绝任意字段路径/原因/层级，未知回退不编造根因',()=>{
 for(const validation of [{layer:'balance',path:'balances[4].free',reason:'DECIMAL_INVALID'},{layer:'snapshot',path:'snapshot',reason:'SNAPSHOT_BUILD_FAILED'}] as const){const d=describeDiagnostic({stage:'balance',code:'SPOT_INVALID',httpStatus:200,jsonValid:true,validation});assert.ok(d.metadata.includes(validation.path));assert.ok(d.metadata.includes(validation.reason));assert.ok(d.metadata.includes('JSON有效'));}
 for(const validation of [{layer:'balance',path:'balances[PRIVATE].free',reason:'DECIMAL_INVALID'},{layer:'balance',path:'balances[0].free',reason:'SENSITIVE'},{layer:'SENSITIVE',path:'$',reason:'OBJECT_REQUIRED'}])assert.ok(!JSON.stringify(describeDiagnostic({stage:'balance',code:'SPOT_INVALID',validation:validation as any})).includes('SENSITIVE'));
 assert.ok(!isSafeValidationPath('balances[0].apiKey'));assert.ok(!isSafeValidationPath('uid=PRIVATE'));assert.ok(!isSafeValidationPath('balances[99999].asset'));
});
test('账户字段拒绝提供安全路径/原因，不带UID/资产名/数量',async()=>{
 const {reader}=await runBalance({...account(),balances:[row('PRIVATE_FAKE','1'),{asset:'PRIVATE_OTHER',free:2,locked:'0'}]});
 const d=reader.getDiagnostic() as any;assert.equal(d.httpStatus,200);assert.equal(d.jsonValid,true);assert.equal(d.layer,'account-validation');assert.equal(d.elapsedMs,100);
 assert.equal(d.validation?.path,'balances[1].free');assert.equal(d.validation?.reason,'DECIMAL_STRING_REQUIRED');assert.ok(!/PRIVATE_FAKE|PRIVATE_OTHER|TEST_KEY|TEST_SECRET/.test(JSON.stringify(d)));
});
