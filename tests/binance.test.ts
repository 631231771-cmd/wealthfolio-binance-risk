import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildOfflineReadRequest as buildReadRequest, normalizeFixtureBalances as normalizeBalances, READ_ENDPOINTS, signPayload } from '../src/binance';

test('HMAC-SHA256 RFC4231 固定向量（纯离线，公开假密钥）', () => {
  assert.equal(signPayload('what do ya want for nothing?','Jefe'),'5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});
test('币安官方 signature-examples 固定向量（仅 timestamp，没有交易请求）', () => {
  const documentedDummySecret='NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  assert.equal(signPayload('timestamp=1578963600000',documentedDummySecret),'d84e6641b1e328e7b418fff030caed655c266299c9355e36ce801ed14631eed4');
});
test('签名与 Node 独立实现一致，签名的是实际序列化参数', () => {
  const query='timestamp=1770736694138&recvWindow=5000';
  assert.equal(signPayload(query,'fixture-only-secret'),createHmac('sha256','fixture-only-secret').update(query).digest('hex'));
  const spot=buildReadRequest('spot','fake-key','fixture-only-secret',1770736694138);
  const url=new URL(spot.url); const sig=url.searchParams.get('signature'); url.searchParams.delete('signature');
  assert.equal(sig,signPayload(url.search.slice(1),'fixture-only-secret'));
});
test('请求白名单只有现货与资金余额，无下单、提现、划转或股票持仓伪接口', () => {
  assert.deepEqual(Object.keys(READ_ENDPOINTS),['spot','funding']);
  const request=buildReadRequest('funding','fake-key','fake-secret',1770736694138);
  assert.equal(request.method,'POST'); assert.equal(request.url,'https://api.binance.com/sapi/v1/asset/get-funding-asset');
  assert.ok(request.body!.includes('signature='));
  assert.throws(()=>buildReadRequest('trade' as 'spot','fake','fake',1));
});
test('资金余额保存冻结及提现中分解，模拟数量按照四个桶计算', () => {
  const s=normalizeBalances('funding',[{asset:'BTC',free:'0.1',locked:'0.2',freeze:'0.3',withdrawing:'0.4'}],'funding','batch','2026-10-13T00:00:00Z');
  assert.equal(s.positions[0].quantity,'1'); assert.equal(s.positions[0].balanceComponents!.freeze,'0.3');
});
test('错误响应、缺字段和不合法数量抛错，绝不转为空余额', () => {
  assert.throws(()=>normalizeBalances('spot',{code:-2015},'a','b','2026-10-13'));
  assert.throws(()=>normalizeBalances('funding',[{asset:'BTC',free:'1',locked:'0'}],'a','b','2026-10-13'));
  assert.throws(()=>normalizeBalances('spot',{balances:[{asset:'BTC',free:'NaN',locked:'0'}]},'a','b','2026-10-13'));
});
test('未分类资产保留数量，不凭现货接口或后缀认定是普通币或真实股票', () => {
  const s=normalizeBalances('spot',{balances:[{asset:'AAPLB',free:'2',locked:'0'}]},'spot','batch','2026-10-13');
  assert.equal(s.positions[0].asset.type,'unknown');assert.equal(s.positions[0].quantity,'2');assert.equal(s.positions[0].price,undefined);
});
