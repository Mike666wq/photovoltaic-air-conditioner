import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { opaque, passwordHash, tokenHash } from './auth.mjs';

// 首次注册工具：密码仅从stdin读取，令牌只写入0600文件，不进入参数/控制台。
const { values } = parseArgs({ options: { dir: { type: 'string' }, device: { type: 'string' }, packs: { type: 'string', default: '1' }, addresses: { type: 'string', default: '1' }, user: { type: 'string' }, alias: { type: 'string', default: '实验室 BMS' }, admin: { type: 'boolean', default: false } } });
if (!values.dir || !values.device || !values.user || !/^[a-zA-Z0-9_-]{1,80}$/.test(values.device)) throw new Error('用法：node admin.mjs --dir <安全目录> --device <设备编号> --user <观看用户名> [--packs 1,2] [--addresses 1] [--admin]；密码从stdin输入');
const list = (input, max) => { const n = [...new Set(input.split(',').map(Number))]; if (!n.length || n.some((v) => !Number.isInteger(v) || v < 1 || v > max)) throw new Error('Pack/地址列表无效'); return n; };
let password = ''; for await (const chunk of process.stdin) { password += chunk; if (password.length > 258) throw new Error('密码过长'); }
password = password.replace(/\r?\n$/, ''); if (password.length < 12 || password.length > 256) throw new Error('观看密码需12–256个字符');
const dir = resolve(values.dir); mkdirSync(dir, { recursive: true, mode: 0o700 });
const token = opaque();
const device = { deviceId: values.device, alias: values.alias, allowedPacks: list(values.packs, 16), allowedAddresses: list(values.addresses, 255), deviceTokenHash: tokenHash(token), allowSimulation: false, displayTimeZone: 'Asia/Shanghai' };
const user = { username: values.user, passwordHash: await passwordHash(password), role: values.admin ? 'admin' : 'viewer', devices: [values.device] };
const outputs = [['devices.json', { devices: [device] }], ['viewers.json', { users: [user] }]];
for (const [name, content] of outputs) writeFileSync(join(dir, name), JSON.stringify(content, null, 2), { mode: 0o600, flag: 'wx' });
writeFileSync(join(dir, 'device-token.txt'), token + '\n', { mode: 0o600, flag: 'wx' });
console.log('已创建devices.json、viewers.json和device-token.txt（0600）。请通过安全方式将令牌交给本地客户端，勿提交这些文件。');
