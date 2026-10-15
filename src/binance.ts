import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { NetworkRequest } from '@wealthfolio/addon-sdk';
import { nonnegative, type Snapshot, type Account } from './domain';

export const READ_ENDPOINTS = {
  spot: { method: 'GET', path: '/api/v3/account' }
} as const;
export function signPayload(payload: string, secret: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(payload)));
}
// Request construction is fixture-only; the live authenticated send path stays hard-blocked.
export function buildOfflineReadRequest(kind: 'spot', apiKey: string, secret: string, timestamp: number): NetworkRequest {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || !apiKey || !secret) throw new Error('签名输入无效');
  const endpoint = READ_ENDPOINTS[kind];
  if (!endpoint) throw new Error('不允许的接口');
  const payload = 'timestamp=' + timestamp + '&recvWindow=5000';
  const signed = payload + '&signature=' + signPayload(payload, secret);
  return {
    method: 'GET',
    url: 'https://api.binance.com' + endpoint.path + '?' + signed,
    headers: { 'X-MBX-APIKEY': apiKey }
  };
}
export function normalizeFixtureBalances(kind: 'spot' | 'funding', response: unknown, accountId: string, batchId: string, asOf: string): Snapshot {
  const rows = kind === 'spot' ? (response as { balances?: unknown })?.balances : response;
  if (!Array.isArray(rows)) throw new Error('币安响应缺少余额数组，不能当作零资产');
  return { accountId, batchId, asOf, dataMode: 'fixture', positions: rows.map(row => {
    if (!row || typeof row !== 'object' || typeof row.asset !== 'string') throw new Error('币安资产记录无效');
    const fields = kind === 'spot' ? ['free','locked'] : ['free','locked','freeze','withdrawing'];
    const components: Record<string,string> = {};
    let quantity = nonnegative('0');
    for (const field of fields) {
      if (typeof row[field] !== 'string') throw new Error('余额字段缺失或格式无效');
      components[field] = row[field];
      quantity = quantity.add(nonnegative(row[field]));
    }
    // 只有固定样例资产已确认分类；不能仅凭现货接口或后缀猜测 bStocks。
    const type = ['BTC','USDT'].includes(row.asset) ? 'crypto' as const : 'unknown' as const;
    return { asset: { venue: 'BINANCE', code: row.asset, type, quoteCurrency: 'USD' }, quantity: quantity.toFixed(), balanceComponents: components };
  }).filter(p => p.quantity !== '0') };
}

export function parseExternalSpot(response: unknown, account: Account, batchId: string, startedAt: string, endedAt: string): Snapshot {
  if (account.platform !== 'binance' || account.kind !== 'spot' || !account.sourceAccountId || account.id.startsWith('demo-')) throw new Error('外部账户来源无效');
  if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(endedAt)) || Date.parse(startedAt) > Date.parse(endedAt)) throw new Error('采集时间无效');
  const rows = (response as {balances?:unknown})?.balances;
  if (!Array.isArray(rows)) throw new Error('外部现货响应不完整');
  return { accountId:account.id,batchId,asOf:endedAt,collectionStartedAt:startedAt,collectionEndedAt:endedAt,dataMode:'external',positions:rows.map(row=> {
    if (!row || typeof row.asset !== 'string' || !/^[A-Z0-9]+$/.test(row.asset) || row.asset.startsWith('WRISKDEMO')) throw new Error('外部资产身份无效');
    const free=nonnegative(row.free), locked=nonnegative(row.locked);
    return {asset:{venue:'BINANCE',code:row.asset,type:'unknown' as const,quoteCurrency:account.currency},quantity:free.add(locked).toFixed(),balanceComponents:{free:free.toFixed(),locked:locked.toFixed()}};
  })};
}

export function parseExternalFunding(response: unknown, accountId: string, collectedAt: string) {
  if (!accountId || accountId.startsWith('demo-') || !Number.isFinite(Date.parse(collectedAt)) || !Array.isArray(response)) throw new Error('资金账户响应不完整');
  return {platform:'binance' as const,accountId,wallet:'funding' as const,dataMode:'external' as const,collectedAt,status:'unverified' as const,assets:response.map(row=> {
    if (!row || typeof row.asset !== 'string' || !/^[A-Z0-9]+$/.test(row.asset)) throw new Error('资金资产身份无效');
    const components=Object.fromEntries(['free','locked','freeze','withdrawing'].map(key=>[key,nonnegative(row[key]).toFixed()]));
    return {code:row.asset,components};
  })}; // 故意不返回 quantity / total / Snapshot，口径未证实前不能进入估值。
}
