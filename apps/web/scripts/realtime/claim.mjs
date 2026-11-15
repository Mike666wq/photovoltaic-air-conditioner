// ============================================================
// 设备认领（claim）—— 与注册表分开存的原因
// ------------------------------------------------------------
// `registry.mjs` 每次写都是 structuredClone({devices,users,system}) 全量重写，
// 任何顶层新键会被静默丢弃；而且旧版云端 `validateConfig` 会逐条断言每个 device
// 必须具备 deviceTokenHash / alias / 授权数组 —— 半成品 pending 记录一旦进 devices[]
// 就会让整个实时模块 503。所以 pending 单独一份文件。
//
// 明文令牌只在一个响应里出现一次：批准时写 grants/<grantId>.json，取走即删。
// 明文永不进 registry.json（也避开它的 1 MiB 上限）。
// ============================================================
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { assert } from './contract.mjs';
import { ENROLLMENT } from './base-contract.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(24).toString('base64url');

/** 常量时间比较，避免通过响应时间猜 claimSecret。 */
function equalSecret(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function writeAtomic(path, content) {
  const temp = `${path}.${opaque()}.tmp`;
  let file;
  try {
    file = await open(temp, 'wx', 0o600);
    await file.writeFile(content);
    await file.sync();
    await file.close();
    file = null;
    await rename(temp, path);
  } finally {
    await file?.close();
    await unlink(temp).catch(() => {});
  }
}

export class ClaimStore {
  constructor(config, clocks = {}) {
    this.config = config;
    this.now = clocks.now ?? (() => Date.now());
    this.queue = Promise.resolve();
    this.pending = 0;
  }

  get writable() { return !!this.config.registryDir; }
  get pendingPath() { return join(this.config.registryDir, 'pending.json'); }
  get grantsDir() { return join(this.config.registryDir, 'grants'); }
  get maxPending() { return this.config.maxPending ?? ENROLLMENT.maxPending; }

  async _readAll() {
    if (!this.writable) return { version: 1, claims: [] };
    try {
      const text = await readFile(this.pendingPath, 'utf8');
      const parsed = JSON.parse(text);
      const claims = Array.isArray(parsed?.claims) ? parsed.claims : [];
      return { version: 1, claims };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: 1, claims: [] };
      // 损坏的 pending 不应阻断整个服务：当作空表，下一台设备重新认领即可。
      return { version: 1, claims: [] };
    }
  }

  _mutate(change) {
    assert(this.writable, 503, 'REGISTRY_READ_ONLY', '当前注册配置只读，请管理员配置持久化注册存储');
    assert(this.pending < 8, 429, 'REGISTRY_BUSY', '认领操作繁忙，请稍后再试');
    this.pending++;
    const result = this.queue.then(async () => {
      const state = await this._readAll();
      const value = change(state);
      await mkdir(this.config.registryDir, { recursive: true, mode: 0o700 });
      await writeAtomic(this.pendingPath, JSON.stringify({ version: 1, claims: state.claims }));
      return value;
    });
    this.queue = result.catch(() => {});
    return result.finally(() => { this.pending--; });
  }

  /** 过期清理。返回被清理的条数。 */
  async sweep() {
    if (!this.writable) return 0;
    const now = this.now();
    const state = await this._readAll();
    const alive = state.claims.filter((c) => c.expiresAtMs > now);
    if (alive.length === state.claims.length) return 0;
    await this._mutate((next) => {
      next.claims = next.claims.filter((c) => c.expiresAtMs > now);
    }).catch(() => {});
    return state.claims.length - alive.length;
  }

  async listPending() {
    const state = await this._readAll();
    const now = this.now();
    return state.claims.filter((c) => c.state === 'pending' && c.expiresAtMs > now);
  }

  async byClaimId(claimId) {
    const state = await this._readAll();
    return state.claims.find((c) => c.claimId === claimId) ?? null;
  }

  async byMachineKey(machineKey) {
    const state = await this._readAll();
    return state.claims.find((c) => c.machineKey === machineKey) ?? null;
  }

  /**
   * 首次认领（幂等）。同一个 (machineKey, secret) 重复调用返回同一条记录，
   * 不新建、不延长过期时间 —— 否则客户端重启就能把 TTL 无限续下去。
   */
  async create({ machineKey, module, claimSecret, desiredAlias, client }) {
    const existing = await this.byMachineKey(machineKey);
    if (existing) {
      // 只有「还在等批准」的记录才需要校验 secret —— 那是防别人抢占同一台机器的申请。
      // 已经 approved / rejected / expired 的记录属于上一轮，设备重新发起认领时必须能拿到
      // 一条新记录。这里如果还要求 secret 匹配，设备就永远卡在 401：它已经换了一把新 secret，
      // 而旧记录的哈希永远不会变，表现就是「点了重新申请，云端什么都没有」。
      if (existing.state === 'pending') {
        assert(equalSecret(existing.claimSecretHash, sha256(claimSecret)), 401, 'CLAIM_SECRET_MISMATCH', '认领凭据不匹配');
        if (existing.expiresAtMs > this.now()) {
          // 设备改了名字再点「重新申请」：同一条 pending 记录必须被更新，
          // 否则管理员看到的永远是第一次提交时的名字（本地改了等于白改）。
          return this._mutate((next) => {
            const rec = next.claims.find((c) => c.claimId === existing.claimId);
            if (!rec) return existing;
            const wanted = typeof desiredAlias === 'string' ? desiredAlias.trim() : '';
            if (wanted) rec.desiredAlias = wanted;
            if (client !== undefined) rec.client = client;
            rec.lastSeenAtUtc = new Date(this.now()).toISOString();
            return { ...rec };
          });
        }
      }
      // 上一轮的记录（或已过期的）清掉重来，claimId 换新。
      await this._mutate((next) => {
        next.claims = next.claims.filter((c) => c.claimId !== existing.claimId);
      });
    }
    return this._mutate((next) => {
      const live = next.claims.filter((c) => c.state === 'pending' && c.expiresAtMs > this.now());
      assert(live.length < this.maxPending, 409, 'CLAIM_LIMIT', '待批准设备已达上限，请先在网页处理');
      const now = this.now();
      const record = {
        claimId: `c_${opaque()}`,
        machineKey,
        module,
        claimSecretHash: sha256(claimSecret),
        desiredAlias: (desiredAlias ?? '').slice(0, 128),
        client: client ?? null,
        state: 'pending',
        createdAtMs: now,
        createdAtUtc: new Date(now).toISOString(),
        expiresAtMs: now + ENROLLMENT.claimTtlSeconds * 1000,
        expiresAtUtc: new Date(now + ENROLLMENT.claimTtlSeconds * 1000).toISOString(),
        grantId: null,
        deviceId: null,
        approvedAtUtc: null,
        rejectedReason: null,
      };
      next.claims.push(record);
      return record;
    });
  }

  /** 校验认领凭据：claimId 必须存在、未过期、secret 匹配。 */
  async auth(claimId, claimSecret) {
    const record = await this.byClaimId(claimId);
    assert(record, 404, 'CLAIM_NOT_FOUND', '认领不存在或已失效');
    assert(equalSecret(record.claimSecretHash, sha256(claimSecret)), 401, 'CLAIM_SECRET_MISMATCH', '认领凭据不匹配');
    assert(record.expiresAtMs > this.now(), 410, 'CLAIM_EXPIRED', '认领已过期，请重新发起');
    return record;
  }

  /** 管理员批准：写 grant（明文令牌一次性交付），记录 deviceId/configVersion。 */
  async approve(claimId, { deviceId, deviceToken, configVersion }) {
    const grantId = `g_${opaque()}`;
    await mkdir(this.grantsDir, { recursive: true, mode: 0o700 });
    const grantPath = join(this.grantsDir, `${grantId}.json`);
    await writeAtomic(grantPath, JSON.stringify({
      grantId, claimId, deviceId, deviceToken,
      expiresAtMs: this.now() + ENROLLMENT.grantTtlSeconds * 1000,
      delivered: false,
    }));
    const record = await this._mutate((next) => {
      const target = next.claims.find((c) => c.claimId === claimId);
      assert(target, 404, 'CLAIM_NOT_FOUND', '认领不存在');
      target.state = 'approved';
      target.deviceId = deviceId;
      target.grantId = grantId;
      target.configVersion = configVersion;
      target.approvedAtUtc = new Date(this.now()).toISOString();
      return { ...target };
    });
    return { record, grantId, grantPath };
  }

  /** 取走一次性令牌。返回 null 表示已交付过或已过期。 */
  async takeGrant(grantId) {
    if (!grantId) return null;
    const path = join(this.grantsDir, `${grantId}.json`);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
    if (!parsed || parsed.delivered || parsed.expiresAtMs <= this.now()) {
      await unlink(path).catch(() => {});
      return null;
    }
    await unlink(path).catch(() => {});
    return parsed;
  }

  async reject(claimId, reason) {
    return this._mutate((next) => {
      const target = next.claims.find((c) => c.claimId === claimId);
      assert(target, 404, 'CLAIM_NOT_FOUND', '认领不存在');
      target.state = 'rejected';
      target.rejectedReason = (reason ?? '').slice(0, 200);
      return { ...target };
    });
  }

  async remove(claimId) {
    return this._mutate((next) => {
      next.claims = next.claims.filter((c) => c.claimId !== claimId);
      return true;
    });
  }
}
