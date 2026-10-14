import type { HostAPI } from '@wealthfolio/addon-sdk';

// 仅用于安全生命周期验收；没有真实凭据输入或认证发送能力。
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

// 永久关闭本阶段认证发送，既不读取凭据也不进入宿主网络/日志链路。
export async function requestAuthenticated(_broker?: unknown): Promise<never> {
  throw new Error('认证请求已阻断：签名日志保护、余额口径及隐私验收未完成');
}
