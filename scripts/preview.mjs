// Isolated, fictional browser preview. No Addon SDK, real secrets, or Binance transport.
import {build} from 'vite';
import {resolve} from 'node:path';
await build({configFile:false,root:resolve('tests/preview'),base:'./',build:{outDir:resolve('artifacts/product-preview'),emptyOutDir:true},esbuild:{jsx:'automatic'}});
