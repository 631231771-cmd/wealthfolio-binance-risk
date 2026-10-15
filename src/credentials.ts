import type { HostAPI } from '@wealthfolio/addon-sdk';
// Fixed fake credentials below are separate from the local Binance credential manager.
export interface BinanceCredentialPair {
  version: 1;
  apiKey: string;
  secret: string;
}

const REAL_ACTIVE = 'risk-binance-spot-active-v1';
const REAL_SLOTS = { a: 'risk-binance-spot-slot-a-v1', b: 'risk-binance-spot-slot-b-v1' } as const;
type RealSlot = keyof typeof REAL_SLOTS;

function decodeReal(text: string | null): BinanceCredentialPair | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as Partial<BinanceCredentialPair>;
    if (value.version !== 1 || typeof value.apiKey !== 'string' || typeof value.secret !== 'string' ||
        !value.apiKey || !value.secret || value.apiKey.length > 512 || value.secret.length > 512 ||
        value.apiKey !== value.apiKey.trim() || value.secret !== value.secret.trim()) throw new Error();
    return { version: 1, apiKey: value.apiKey, secret: value.secret };
  } catch {
    throw new Error('本机 Spot 凭据格式无效；连接已断开');
  }
}

// Real credentials use only the host secrets capability. They never enter addon storage or UI state.
export class BinanceCredentials {
  private busy = false;
  constructor(private readonly secrets: Pick<HostAPI['secrets'], 'set' | 'get' | 'delete'>) {}

  async read(): Promise<BinanceCredentialPair | null> {
    try {
      const active = await this.secrets.get(REAL_ACTIVE);
      if (active === null || active === 'disconnected') return null;
      if (active !== 'a' && active !== 'b') throw new Error();
      const value = decodeReal(await this.secrets.get(REAL_SLOTS[active]));
      if (!value) throw new Error();
      return value;
    } catch {
      throw new Error('无法读取本机 Spot 凭据；连接已断开');
    }
  }

  async isSaved(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  async save(apiKey: string, secret: string): Promise<void> {
    if (this.busy) throw new Error('凭据操作正在进行');
    if (typeof apiKey !== 'string' || typeof secret !== 'string' || !apiKey || !secret ||
        apiKey.length > 512 || secret.length > 512 || apiKey !== apiKey.trim() || secret !== secret.trim()) {
      throw new Error('请填写有效的 API Key 和 Secret');
    }
    this.busy = true;
    let old: string | null = null, commitAttempted = false, candidate: RealSlot | null = null;
    try {
      old = await this.secrets.get(REAL_ACTIVE);
      if (old !== null && !['a', 'b', 'disconnected'].includes(old)) throw new Error();
      if (old === 'a' || old === 'b') decodeReal(await this.secrets.get(REAL_SLOTS[old]));
      candidate = old === 'a' ? 'b' : 'a';
      const encoded = JSON.stringify({ version: 1, apiKey, secret } satisfies BinanceCredentialPair);
      await this.secrets.set(REAL_SLOTS[candidate], encoded);
      if (await this.secrets.get(REAL_SLOTS[candidate]) !== encoded) throw new Error();
      commitAttempted = true;
      await this.secrets.set(REAL_ACTIVE, candidate);
      if (await this.secrets.get(REAL_ACTIVE) !== candidate) throw new Error();
    } catch {
      if (commitAttempted) {
        try {
          await this.secrets.set(REAL_ACTIVE, old ?? 'disconnected');
          if (await this.secrets.get(REAL_ACTIVE) !== (old ?? 'disconnected')) throw new Error();
        } catch {
          throw new Error('本机凭据切换状态无法确认；请断开后检查并重试');
        }
      }
      if (candidate) {
        try {
          await this.secrets.delete(REAL_SLOTS[candidate]);
          if (await this.secrets.get(REAL_SLOTS[candidate]) !== null) throw new Error();
        } catch {
          throw new Error('新凭据保存失败，临时凭据清理未确认；请断开后重试');
        }
      }
      throw new Error('新凭据保存失败；旧版本保持活动。没有发送认证请求');
    } finally {
      this.busy = false;
    }
  }

  async disconnectAndDelete(): Promise<void> {
    if (this.busy) throw new Error('凭据操作正在进行；请稍后重试');
    this.busy = true;
    let markedDisconnected = false;
    try {
      await this.secrets.set(REAL_ACTIVE, 'disconnected');
      if (await this.secrets.get(REAL_ACTIVE) !== 'disconnected') throw new Error();
      markedDisconnected = true;
      for (const key of Object.values(REAL_SLOTS)) await this.secrets.delete(key);
      for (const key of Object.values(REAL_SLOTS)) if (await this.secrets.get(key) !== null) throw new Error();
      await this.secrets.delete(REAL_ACTIVE);
      if (await this.secrets.get(REAL_ACTIVE) !== null) throw new Error();
    } catch {
      throw new Error(markedDisconnected
        ? '本机凭据未全部删除；断开标记已确认，请重试'
        : '本机凭据删除未完成；连接状态无法确认，请重试');
    } finally {
      this.busy = false;
    }
  }
}

// Fixed fake credentials are used only by the offline fixture reader.
export const DUMMY = {
  1: { version: 1, apiKey: 'WRISK_FAKE_KEY_V1', secret: 'WRISK_FAKE_SECRET_V1' },
  2: { version: 2, apiKey: 'WRISK_FAKE_KEY_V2', secret: 'WRISK_FAKE_SECRET_V2' }
} as const;
const ACTIVE = 'risk-dummy-active-v1';
const SLOTS = { a: 'risk-dummy-slot-a-v1', b: 'risk-dummy-slot-b-v1' } as const;
type Slot = keyof typeof SLOTS;
type Dummy = typeof DUMMY[1] | typeof DUMMY[2];
function decode(text: string | null): Dummy | null {
  if (text === null) return null;
  for (const value of Object.values(DUMMY)) if (text === JSON.stringify(value)) return value;
  throw new Error('安全存储内容无效，保持断开');
}
export class DummyCredentials {
  private busy = false;
  constructor(private readonly secrets: Pick<HostAPI['secrets'],'set'|'get'|'delete'>) {}
  async read(): Promise<Dummy | null> {
    try {
      const active = await this.secrets.get(ACTIVE);
      if (active === null || active === 'disconnected') return null;
      if (active !== 'a' && active !== 'b') throw new Error();
      const value = decode(await this.secrets.get(SLOTS[active]));
      if (!value) throw new Error();
      return value;
    } catch { throw new Error('无法读取假凭据，保持断开'); }
  }
  async save(version: 1 | 2): Promise<void> {
    if (this.busy) throw new Error('凭据操作进行中');
    if (version !== 1 && version !== 2) throw new Error('仅允许固定假凭据');
    this.busy = true;
    let old: string | null = null, commitAttempted = false;
    try {
      old = await this.secrets.get(ACTIVE);
      if (old !== null && !['a','b','disconnected'].includes(old)) throw new Error();
      if (old === 'a' || old === 'b') decode(await this.secrets.get(SLOTS[old]));
      const candidate: Slot = old === 'a' ? 'b' : 'a';
      const encoded = JSON.stringify(DUMMY[version]);
      // 完整密钥对在同一 secrets 值中；候选槽读回后才切换，不覆盖旧活动槽。
      await this.secrets.set(SLOTS[candidate],encoded);
      if (await this.secrets.get(SLOTS[candidate]) !== encoded) throw new Error();
      commitAttempted = true;
      await this.secrets.set(ACTIVE,candidate);
      if (await this.secrets.get(ACTIVE) !== candidate) throw new Error();
    } catch {
      if (commitAttempted) {
        try {
          await this.secrets.set(ACTIVE,old ?? 'disconnected');
          if (await this.secrets.get(ACTIVE) !== (old ?? 'disconnected')) throw new Error();
        } catch { throw new Error('凭据切换状态无法确认；旧安全槽仍保留，必须重试核对，认证继续阻断'); }
      }
      throw new Error('假凭据更新失败，旧活动版本未覆盖；认证继续阻断');
    } finally { this.busy = false; }
  }
  async disconnectAndDelete(): Promise<void> {
    if (this.busy) throw new Error('凭据操作进行中；认证已阻断');
    this.busy = true;
    try {
      // 先保留断开标记，部分删除失败或重启也不自动启用认证。
      await this.secrets.set(ACTIVE,'disconnected');
      for (const key of Object.values(SLOTS)) await this.secrets.delete(key);
      for (const key of Object.values(SLOTS)) if (await this.secrets.get(key) !== null) throw new Error();
      await this.secrets.delete(ACTIVE);
      if (await this.secrets.get(ACTIVE) !== null) throw new Error();
    } catch { throw new Error('删除尚未确认完成；保持断开，请重试删除'); }
    finally { this.busy = false; }
  }
}

// No caller can reach a host transport until the host logging gate is fixed and separately authorized.
// This remains a hard stop until Wealthfolio sanitizes signed-URL errors and the user separately authorizes a real request.
export async function requestAuthenticated(): Promise<never> {
  throw new Error('真实 Spot 请求已硬阻断：宿主错误日志可能包含签名 URL；需先修复并验证宿主日志脱敏');
}
