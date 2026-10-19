import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
if(!existsSync(resolve(root,manifest.main))) throw new Error('请先构建插件');
mkdirSync(resolve(root,'artifacts'),{recursive:true});
// Windows 原生 ZIP；只打包清单、编译入口、CSS 和说明，不包含源码依赖或本地数据。
const script=String.raw`$root=$args[0]; $dest=$args[1]; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open($dest,[IO.Compression.ZipArchiveMode]::Create); try { foreach($item in @('manifest.json','dist/addon.js','dist/wealthfolio-binance-risk.css','README.md')) { $entry=[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $root $item),$item,[IO.Compression.CompressionLevel]::Optimal); $entry.LastWriteTime=[DateTimeOffset]::new(1980,1,1,0,0,0,[TimeSpan]::Zero) } } finally { $zip.Dispose() }`;
const path=resolve(root,'artifacts',`${manifest.id}-${manifest.version}.zip`);
// 不覆盖旧产物：每次先构造临时文件，再用原生文件替换最终包。
const temp=path+'.tmp';
if(existsSync(temp)) throw new Error('发现上次残留临时包，请先检查');
const ps=resolve(root,'artifacts','package.ps1'); writeFileSync(ps,script);
execFileSync('powershell.exe',['-NoProfile','-File',ps,root,temp],{stdio:'inherit'});
const { renameSync, unlinkSync }=await import('node:fs');
if(existsSync(path)) unlinkSync(path);
renameSync(temp,path); unlinkSync(ps);
const bytes=readFileSync(path);
console.log(`${path}\nSHA256 ${createHash('sha256').update(bytes).digest('hex')}`);
