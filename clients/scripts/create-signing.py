#!/usr/bin/env python3
"""在仓库外创建长期 APK 签名材料；不打印密钥或密码，不覆盖已有材料。"""
import argparse, base64, json, os, pathlib, secrets, subprocess, tempfile
p = argparse.ArgumentParser()
p.add_argument('--directory', required=True)
p.add_argument('--github-repo', help='可选：使用已登录的 gh 将四个签名秘密配置到指定仓库')
a = p.parse_args()
root = pathlib.Path(a.directory).expanduser().resolve()
repo = pathlib.Path(__file__).resolve().parents[2]
if root == repo or repo in root.parents:
    raise SystemExit('签名备份必须在仓库之外')
root.mkdir(parents=True, exist_ok=True, mode=0o700)
os.chmod(root, 0o700)
metadata = root / 'signing.json'
keystore = root / 'pvac-release.p12'
if not metadata.exists():
    if keystore.exists():
        raise SystemExit('已存在 keystore，拒绝覆盖；请恢复对应密码备份')
    password = secrets.token_urlsafe(32)
    env = dict(os.environ, PVAC_SIGNING_PASSWORD=password)
    with tempfile.TemporaryDirectory(dir=root) as work:
        key, cert = pathlib.Path(work) / 'key.pem', pathlib.Path(work) / 'cert.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-nodes', '-days', '10000', '-subj', '/CN=PV AC Monitor/O=PV AC', '-keyout', str(key), '-out', str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['openssl', 'pkcs12', '-export', '-inkey', str(key), '-in', str(cert), '-name', 'pvac-monitor', '-out', str(keystore), '-passout', 'env:PVAC_SIGNING_PASSWORD'], check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    metadata.write_text(json.dumps({'alias': 'pvac-monitor', 'storePassword': password, 'keyPassword': password}), encoding='utf8')
    os.chmod(metadata, 0o600)
    os.chmod(keystore, 0o600)
values = json.loads(metadata.read_text())
if a.github_repo:
    payloads = {'PVAC_ANDROID_KEYSTORE_BASE64': base64.b64encode(keystore.read_bytes()).decode(), 'PVAC_ANDROID_STORE_PASSWORD': values['storePassword'], 'PVAC_ANDROID_KEY_PASSWORD': values['keyPassword'], 'PVAC_ANDROID_KEY_ALIAS': values['alias']}
    for name, value in payloads.items():
        subprocess.run(['gh', 'secret', 'set', name, '--repo', a.github_repo], input=value.encode(), check=True, stdout=subprocess.DEVNULL)
print('签名材料已私密保存；请将整个目录另做离线加密备份。' + (' GitHub签名Secrets已配置。' if a.github_repo else ''))
