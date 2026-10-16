import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root=new URL('../',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',root),'utf8'));
const zip=`${manifest.id}-${manifest.version}.zip`;
const hash=path=>createHash('sha256').update(readFileSync(new URL(path,root))).digest('hex');
const receipt={
  createdAt:new Date().toISOString(),
  project:manifest.id, version:manifest.version,
  wealthfolioTarget:'3.10.0', upstreamCommit:'f9643209e7cafcaf133d5a8fbe1ef2fa4fd7fc04', sdk:'3.9.0',
  node:process.version,
  zip,
  zipSha256:hash(`artifacts/${zip}`),
  lockSha256:hash('package-lock.json'),
  checks:['typecheck','offline-tests','build','zip-package','compiled-entry-static-render'],
  desktopInstallation:'未完成', privateBinanceApi:'未调用', stocksHoldingsApi:'未确认',
  note:'仅在 verify 前置检查通过后生成；替身测试与静态渲染不代表官方桌面运行。'
};
writeFileSync(new URL(`artifacts/BUILD-RECEIPT-${manifest.version}.json`,root),JSON.stringify(receipt,null,2)+'\n');
console.log('已保存构建记录和 ZIP/锁文件校验值。');
