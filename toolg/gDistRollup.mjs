import rollupFiles from 'w-package-tools/src/rollupFiles.mjs'


let fdSrc = './src'
let fdTar = './dist'


//external與globals之盤點原則:
//1. 本套件以src深層路徑引用自有套件(w-data-csv、w-data-tdprovide、w-data-trade、w-dwdata-binance、w-trade-backtest、w-trade-solve)與wsemi之原始碼(皆ESM),
//   不列為external而讓rollup沿著引用打包其src: UMD之require路徑對ESM外部模組取得的是命名空間物件({ default })而非預設匯出, 列為external會使dist在執行時失敗
//   (實測: 自有套件列為external時, 以require載入dist後buildParams拋「dataConvert is not a function」, 且dist.readStrategies之typeof與ESM入口不同);
//   經它們再引用的第三方套件(axios、csv-parser、strip-bom-stream、decimal.js、jstat、w-optimization、w-statistic等)同樣打包, 不分別剔除
//   (strip-bom-stream等為ESM專用套件, 亦不可列為external; 自有套件各自dist之剔除清單不適用於此)
//2. 本套件src及上述打包範圍內之node內建模組一律以無前綴引用, 與自有套件同一寫法; rollup之external與globals以import字串逐字比對,
//   'fs'不涵蓋'node:fs', 打包範圍內之第三方套件(strip-bom-stream、first-chunk-stream、strip-bom-buf)以node:buffer、node:stream引用, 須另列
//3. dayjs(與plugin)由wsemi帶入, 為CJS單檔, 沿用wsemi之剔除, 列為external由使用端安裝(依賴wsemi帶入);
//   lodash-es一律以單函數路徑(lodash-es/<函數>.js)引用, 屬純函式之ESM小檔, 打包進dist(與自有套件對lodash-es/*之處理一致)
//4. globals右側為引入後的名稱, 不能包含小數點「.」
//5. runin須為nodejs: 本套件僅能於nodejs執行(fs、worker_threads), 未給時rollupFiles預設browser, 會以browser欄位解析被打包之相依並警告依賴node內建模組
//6. dist之限制(行為不改, 僅記錄): 以import.meta.url相對位置取用之worker entry(src/sweep/sweepSingle_worker.mjs、src/sweep/sweepPairs_worker.mjs、src/solve/solveWorker.mjs)
//   不在import圖內, 故不隨dist打包; 需用sweepSingle/sweepPairs或solve之workers>0者請以ESM深層路徑取用(w-trade-strategy/src/WTradeStrategy.mjs, 套件不設exports)
//盤點方式: 自src/WTradeStrategy.mjs靜態追蹤import圖(含沿node_modules內自有套件與第三方套件之引用, 含export … from與require), 取得全部裸import後逐一歸類;
//   新增依賴或自有套件升版後須重盤, 並以require載入dist實跑buildOhlc、buildParams、buildCache驗證(列為external者須為CJS且不依賴ESM專用套件)


rollupFiles({
    fns: 'WTradeStrategy.mjs',
    fdSrc,
    fdTar,
    nameDistType: 'kebabCase',
    runin: 'nodejs',
    globals: {

        //node內建模組
        'path': 'path',
        'fs': 'fs',
        'os': 'os',
        'worker_threads': 'worker_threads',
        'crypto': 'crypto',
        'url': 'url',
        'util': 'util',
        'events': 'events',
        'stream': 'stream',
        'stream/promises': 'streamPromises',
        'zlib': 'zlib',
        'http': 'http',
        'http2': 'http2',
        'https': 'https',
        'net': 'net',
        'tls': 'tls',
        'tty': 'tty',
        'assert': 'assert',
        'node:buffer': 'node_buffer',
        'node:stream': 'node_stream',

        //dayjs(由wsemi帶入)
        'dayjs': 'dayjs',
        'dayjs/plugin/utc.js': 'dayjs_plugin_utc',
        'dayjs/plugin/timezone.js': 'dayjs_plugin_timezone',

    },
    external: [

        //node內建模組
        'path',
        'fs',
        'os',
        'worker_threads',
        'crypto',
        'url',
        'util',
        'events',
        'stream',
        'stream/promises',
        'zlib',
        'http',
        'http2',
        'https',
        'net',
        'tls',
        'tty',
        'assert',
        'node:buffer',
        'node:stream',

        //dayjs(由wsemi帶入)
        'dayjs',
        'dayjs/plugin/utc.js',
        'dayjs/plugin/timezone.js',

    ],
})


//node toolg/gDistRollup.mjs
