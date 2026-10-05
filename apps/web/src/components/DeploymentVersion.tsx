import { useState } from 'react';

const build = import.meta.env.VITE_BUILD_VERSION as string | undefined;
const sha = import.meta.env.VITE_BUILD_SHA as string | undefined;
const versionLabel = build && build !== 'development' ? build : `开发版 · ${sha && sha !== 'unknown' ? sha.slice(0, 7) : 'SHA 未知'}`;

export function DeploymentVersion() {
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const copySha = async () => {
    if (!sha || sha === 'unknown') return;
    try {
      await navigator.clipboard.writeText(sha.slice(0, 7));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch { setCopied(false); }
  };
  return <span className="deployment-version-wrap">
    <button type="button" className="deployment-version" onClick={() => setShowDetails((value) => !value)} title="查看部署版本和提交短 SHA" aria-expanded={showDetails}>
      {versionLabel}
    </button>
    {showDetails && <span className="deployment-version-popover" role="status">
      <span>版本：{versionLabel}</span>
      <span>提交：{sha && sha !== 'unknown' ? sha.slice(0, 7) : '未知'}</span>
      {sha && sha !== 'unknown' && <button type="button" onClick={() => void copySha()}>{copied ? '已复制' : '复制短 SHA'}</button>}
    </span>}
  </span>;
}
