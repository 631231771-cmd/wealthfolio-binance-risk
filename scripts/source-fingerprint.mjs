import {readFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
export function sourceFingerprint(){
  const files=['manifest.json','package.json','package-lock.json','vite.config.ts','scripts/source-fingerprint.mjs',...readdirSync(new URL('../src/',import.meta.url)).filter(f=>/\.(ts|tsx|css)$/.test(f)).map(f=>'src/'+f)].sort();
  const hash=createHash('sha256');
  for(const file of files)hash.update(file+'\0').update(readFileSync(new URL('../'+file,import.meta.url),'utf8').replaceAll('\r\n','\n')).update('\0');
  return hash.digest('hex');
}
