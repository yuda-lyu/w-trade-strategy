# w-trade-strategy
A strategy-library builder for quantitative trading: fetch K-lines (price and premium index) from Binance or take external bars, compute normalized factor series, sweep single/dual-factor strategies, and run accelerated meta-heuristic optimization that keeps growing a strategy library with progress events and stop conditions.

![language](https://img.shields.io/badge/language-JavaScript-orange.svg)
[![npm version](http://img.shields.io/npm/v/w-trade-strategy.svg?style=flat)](https://npmjs.org/package/w-trade-strategy)
[![license](https://img.shields.io/npm/l/w-trade-strategy.svg?style=flat)](https://npmjs.org/package/w-trade-strategy)
[![npm download](https://img.shields.io/npm/dt/w-trade-strategy.svg)](https://npmjs.org/package/w-trade-strategy)
[![npm download](https://img.shields.io/npm/dm/w-trade-strategy.svg)](https://npmjs.org/package/w-trade-strategy)
[![jsdelivr download](https://img.shields.io/jsdelivr/npm/hm/w-trade-strategy.svg)](https://www.jsdelivr.com/package/npm/w-trade-strategy)

## Documentation
To view documentation or get support, visit [docs](https://yuda-lyu.github.io/w-trade-strategy/global.html).

## Installation

### Using npm(ES6 module):
```alias
npm i w-trade-strategy
```
依賴:`wsemi`、`w-data-csv`、`w-data-tdprovide`、`w-data-trade`、`w-dwdata-binance`、`w-trade-backtest`、`w-trade-solve`(`wsemi` 之依賴帶入原始碼所用之 `lodash-es` 與 `dayjs`,故 `package.json` 不另宣告).原始碼為 ESM、不設 `exports`,以深層路徑取用:`w-trade-strategy/src/WTradeStrategy.mjs`(聚合入口)或各模組(`w-trade-strategy/src/createPipeline.mjs` 等);`main` 指向 `dist/w-trade-strategy.umd.js`(`require('w-trade-strategy')`;dist 已將上述自有套件與 `wsemi` 之 `src/` 打包在內〔僅 `dayjs` 與 node 內建模組為外部引用〕,但不含 worker entry,需 `sweepSingle`／`sweepPairs`、`solve` 之 `workers > 0` 或 `recomputeStrategies` 者請用 ESM 深層路徑).

#### Example:
> **Link:** [[dev source code](https://github.com/yuda-lyu/w-trade-strategy/blob/master/g.mjs)]
```alias
import fs from 'fs'
import WTradeStrategy from './src/WTradeStrategy.mjs'


let { createPipeline } = WTradeStrategy


let test = async () => {
    let ms = []

    //root, 工作根(唯一之路徑錨點): raw/ ohlc/ param/ cache/ strategies/ strategiesP1/ strategiesP2/ meta/ 皆由此展開
    let root = './_test_strategy'
    fs.rmSync(root, { recursive: true, force: true })

    //bars, 合成 4hr K 線(本範例離線可跑; 實務上 source 預設 'binance', 由幣安抓現貨 K 線(price)與溢價指數 K 線(index), 股價等外部數據則如本例以陣列或 async 函數給入)
    let n = 600
    let t0 = Date.UTC(2023, 0, 1)
    let timeOf = (i) => new Date(t0 + i * 4 * 3600 * 1000).toISOString().slice(0, 19)
    let arrPrice = []
    let arrIndex = []
    let c = 100
    for (let i = 0; i < n; i++) {
        let o = c
        c = Math.max(1, c + Math.sin(i * 0.31) * 2 + Math.cos(i * 0.11) * 1.5 + Math.sin(i * 0.017) * 0.8)
        let vol = 1000 + Math.abs(Math.sin(i * 0.23)) * 500
        let buy = vol * (0.4 + 0.2 * Math.abs(Math.cos(i * 0.19)))
        arrPrice.push({ time: timeOf(i), Open: o, High: Math.max(o, c) + 1, Low: Math.min(o, c) - 1, Close: c, Volumn: vol, QuoteAssetVolume: vol * c, NumberOfTrades: 50, TakerBuyBaseAssetVolume: buy, TakerBuyQuoteAssetVolume: buy * c })
        let ic = Math.sin(i * 0.27) * 0.0006 + Math.cos(i * 0.09) * 0.0004
        arrIndex.push({ time: timeOf(i), Open: ic, High: ic + 0.0001, Low: ic - 0.0001, Close: ic })
    }

    //pl, 以設定建立管線: 標的、K 線週期、數據來源、訓練期(最佳化求解與普測之評估區間)
    let pl = createPipeline({
        root,
        name: 'DEMO',
        symbol: 'DEMOUSDT',
        interval: '4hr', //'1m' | '5m' | '15m' | '30m' | '1hr' | '4hr'; 其他週期另給 intervalSec
        timeZone: 'UTC', //時間字串之固定時區(預設 Asia/Taipei)
        timeBegin: arrPrice[0].time,
        source: { price: arrPrice, index: arrIndex }, //外部數據; 未給 index 時自動 useIndex=false 並剔除基於溢價指數之參數
        train: { timeStart: arrPrice[0].time, timeEnd: arrPrice[n - 1].time },
    })

    //1. 數據 → 參數 → 先觸快取(source 為 'binance' 時先 await pl.fetchData(); 亦可一次 await pl.prepare())
    let ro = await pl.buildOhlc({ dropIncompleteLastBar: false })
    ms.push(`buildOhlc: ${ro.nPrice} 根 ${ro.timeFirst} ~ ${ro.timeLast}`)
    let rp = await pl.buildParams({ only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd', 'index_ohlc_close'] }) //未給 only 即內建 34 個定義全算
    ms.push(`buildParams: ${rp.nKeys} 個因子序列(nm 由訓練期自算並凍結於 meta), 剔除 ${rp.dropped.length} 個定義`)
    let rc = await pl.buildCache({ tps: [5, 7] })
    ms.push(`buildCache: ${rc.meta.nBars} 根 × ${rc.want.modes.length} 方向 × ${rc.want.tps.length} 組止盈止損`)

    //2. 因子普測: 單因子全掃描 → 雙因子配對(raw 策略分別落在 strategiesP1/ 與 strategiesP2/)
    let r1 = await pl.sweepSingle({ numTradeFinMin: 5, limit: 8, takeLimit: 2 })
    ms.push(`sweepSingle: ${r1.nFactors} 個因子 → ${r1.nOut} 隻單因子策略`)
    let r2 = await pl.sweepPairs({ numTradeFinMin: 5, eqYrMin: 0, takeLimit: 2 })
    ms.push(`sweepPairs: ${r2.nJobs} 個配對工作 → ${r2.nOut} 隻雙因子策略`)

    //3. 最佳化求解擴建策略庫: 每輪一次 w-trade-solve 之 estimFinder(隨機方向與指標組成, 於訓練期率定門檻與止盈止損), 達門檻者寫入 strategies/
    //   預設 engine 'fast'(加速評估核心, 存檔前官方重跑); 事件回傳進度; 達停止條件(maxStrategies / maxRounds / maxTimeMs / shouldStop / stop())即停
    let st = await pl.solve({
        mode: 'long', //固定方向(未給即每輪隨機)
        comps: '2,0,0', //指標組成: 2 個一般類、0 個指數類、0 個成交量類(未給即 18 種依可用類別自動過濾後隨機取)
        maxRounds: 2, //實務上以 maxStrategies 控制策略庫規模, 並以 workers 開多個 worker 平行
        thNumTrade: 1,
        thRWin: 0,
        thEqYr: -1e9, //示範用: 放寬存檔門檻(預設 1 / 0.5 / 0.15)
        thsTp: [5],
        thsSl: [5], //止盈止損百分比候選(預設 1~10)
        oml: { Np: 6, NContiguous: 3, Ng: 10 }, //最佳化演算法設定(原樣傳遞至 w-optimization)
        onRound: (ev) => {
            ms.push(`  round ${ev.nRounds}: ${ev.mode} comps=${ev.comps} 候選>0=${ev.candidates > 0}`)
        },
    })
    ms.push(`solve: ${st.stopReason}, 共 ${st.nRounds} 輪, 策略庫有檔=${st.nStrategies > 0}`)

    //4. 讀取策略庫(w-trade-solve readStrategies 之格式; 檔內為 estimKeys 落地之策略: tid / tkid / conds / settings / summary / solve)
    let ss = pl.readStrategies(null, { readContent: true })
    ms.push(`readStrategies: 皆為 long 且訓練期一致=${ss.every((s) => s.data.mode === 'long' && s.data.solve.timeEnd === arrPrice[n - 1].time)}`)
    let sts = pl.status().strategies
    ms.push(`status: solve>0=${sts.solve > 0} p1>0=${sts.p1 > 0} p2>0=${sts.p2 > 0}`)

    fs.rmSync(root, { recursive: true, force: true })
    console.log(ms.join('\n'))
}
test()
    .catch((err) => {
        console.log(err)
    })
// => buildOhlc: 600 根 2023-01-01T00:00:00 ~ 2023-04-10T20:00:00
// => buildParams: 100 個因子序列(nm 由訓練期自算並凍結於 meta), 剔除 30 個定義
// => buildCache: 600 根 × 2 方向 × 2 組止盈止損
// => sweepSingle: 8 個因子 → 16 隻單因子策略
// => sweepPairs: 16 個配對工作 → 47 隻雙因子策略
// =>   round 1: long comps=2,0,0 候選>0=true
// =>   round 2: long comps=2,0,0 候選>0=true
// => solve: maxRounds, 共 2 輪, 策略庫有檔=true
// => readStrategies: 皆為 long 且訓練期一致=true
// => status: solve>0=true p1>0=true p2>0=true
```

## 1. 定位

本套件把量化交易策略庫之建置流程「抓數據 → 整理 K 線 → 算參數(因子)→ 因子普測 → 最佳化求策略」抽為可重用之管線,**只負責建立並持續擴建策略庫**,不做回測、不做挑選、不做下單;策略庫供後續調研(自適應挑選、遞迴探索等)取用.產出之策略檔格式與 `w-trade-solve` 之 `estimKeys`／`readStrategies` 相同,既有讀取工具可直接用.

| 階段 | 函數 | 產物(工作根下) |
|---|---|---|
| 抓數據 | `fetchData` | `raw/{name}/{price,index}/{interval}/*.csv` |
| 整理 K 線 | `buildOhlc` | `ohlc/{name}_price_{interval}.json`、`ohlc/{name}_index_{interval}.json` |
| 算參數(因子) | `buildParams` | `param/*.json`(每因子一檔;內建 34 個定義、136 個輸出) |
| 先觸快取 | `buildCache` | `cache/cacheKLinesTpSl.json` |
| 單因子普測 | `sweepSingle` | `strategiesP1/*.json` |
| 雙因子普測(對已求出之單因子策略配對) | `sweepPairs` | `strategiesP2/*.json` |
| 最佳化求解 | `solve`／`createSolver` | `strategies/*.json`(策略庫) |
| 策略庫重算(既有策略改以基礎單位呈現,不重新求解) | `recomputeStrategies` | 寫至另一夾(不提供原地寫回);紀錄與統計於 `meta/recompute/` |

各階段之狀態與凍結值記於 `meta/`(`ohlc.json`、`params.json`、`cache.json`);`createPipeline(cfg).status()` 彙整.

## 2. 設定(createPipeline／normalizeCfg)

```js
{
    root: './data',                      //必填: 工作根(各子夾可由 fds 逐一覆寫)
    name: 'ETH', symbol: 'ETHUSDT',      //必填: 標的名稱(組序列 key 與策略識別)與交易對
    interval: '4hr',                     //必填: K 線週期 '1m' | '5m' | '15m' | '30m' | '1hr' | '4hr'(其他週期須給 intervalSec)
    timeZone: 'Asia/Taipei',             //時間字串之固定時區(與數據一致, 變更時須換新工作根)
    dayStart: '2020-01-01',              //抓取起始日
    timeBegin: '2022-07-01T00:00:00',    //數據保留起點(早於此之 K 線不寫入 ohlc), 預設 `${dayStart}T00:00:00`
    source: 'binance',                   //'binance'(預設) 或 { price: arr | async (cfg) => arr, index?: arr | async (cfg) => arr }
    useIndex: true,                      //是否使用溢價指數; 外部數據未給 index 時預設 false; 為 false 時基於 index 之參數被剔除
    train: {                             //訓練期: 最佳化求解與普測之評估區間(只做數據與參數階段時可省)
        timeStart: '2022-07-01T00:00:00',
        timeEnd: '2025-10-06T00:00:00',
        timeEndByMode: { long: '2025-04-08T00:00:00' }, //可選: 依方向另給終點
    },
    settings: { uIni: 1000, uTrade: 1, rFee: 0.0005 }, //策略之初始資金、每單金額、手續費; 可另給 unit(基礎單位, 見下)
    fds: { strategies: './lib/eth' },    //可選: 覆寫任一子夾 raw/ohlc/param/cache/strategies/strategiesP1/strategiesP2/meta
}
```

**基礎單位(`settings.unit`;選用)**:下單之基礎單位 = 交易所之最小可下單數量,每單名義依進場價與交易規則而定(`w-trade-backtest` ≥ 1.1.40 之 `settings.unit`;`calcBaseUnitQuantity`／`buildBaseUnitNotional`):

```js
settings: {
    uIni: 10000,                         //研究用本金(績效以等效年化計, 與本金無關); 單一策略之最大持倉名義以之為統計基準(只列不判)
    unit: {
        rule: { stepSize: 0.001, minQty: 0.001, minNotional: 20, asOf: '2026-01-01T00:00:00', source: 'exchangeInfo' }, //交易規則(數值為例); asOf 與 source 必填(記錄查得之時刻與來源)
        buffer: 0.1,                     //名義門檻之緩衝: 基礎單位名義 ≥ minNotional × (1 + buffer); 預設 0.1
        units: 1,                        //每單之單位數; 預設 1
    },
}
```

給 `unit` 時:`normalizeCfg` 以 `normalizeUnit` 檢核並補齊 `buffer`／`units`(`null` 或未給皆補預設,不寫入 `null`;`rule` 三欄與 `buffer` 之數字字串於檢測通過後轉為數值、`units` 轉為整數,落地皆為數值〔`asOf`、`source` 與其他欄原樣;轉換前後 `buildBaseUnitNotional` 之 `key` 相同〕;有效性由回測套件之 `buildBaseUnitNotional` 判定 —— 與回測各路徑檢測 `settings.unit` 者同一函數:須為一般物件、數值為有效數字或數字字串、以價格 1 試算一次;錯誤訊息以 `invalid cfg.settings.unit` 起頭、不含輸入值),`uIni` 須為有效正數(數字或數字字串,通過即轉為數值;無效即 `invalid cfg.settings.uIni: must be a positive number`);普測、求解與策略庫重算之每單名義依基礎單位,策略檔之 `settings` 記錄 `uIni` 與 `unit`(交易規則與緩衝隨策略檔落地);**單一策略不設持倉門檻**:最大持倉名義(`summary.uTradeAllMax`;完整摘要另有同時持倉筆數 `numTradeAllMax`)是否超過 `uIni` 不檢、不剔除、不中止,只隨摘要落地(策略庫重算另列超過者之隻數與最大者);持倉組合是否超過本金由挑選端判定。未給 `unit`(或為 `null`)時行為與輸出不變。交易規則屬口徑:規則或緩衝改變即須重算策略庫(〈策略庫重算〉)。

cfg 之鍵只認 `CFG_KEYS`,打錯即拋錯並列可用鍵;已正規化之 cfg 可再傳入(衍生鍵 `keyOhlc`、`keyIndex`、`barsPerDay` 略過).

**外部數據(股價等)**:`source.price` 為 K 線陣列 `[{ time: 'YYYY-MM-DDTHH:mm:ss', Open, High, Low, Close, Volumn?, ... }]`(或回傳該陣列之 async 函數),欄位名與幣安現貨一致(`Volumn`、`QuoteAssetVolume`、`NumberOfTrades`、`TakerBuyBaseAssetVolume`、`TakerBuyQuoteAssetVolume`);缺少之欄位會使依賴該欄位之參數定義被整個剔除(`buildParams` 回傳之 `dropped` 列出原因),只有 OHLC 時仍有 ma／ema／vec／rsi／macd／bbpb／adx／atr／kdj／donchian／keltner／supertrend／ichimoku／vortex／klr／candle 等可用.

## 3. 數據

- `fetchData(opt)`:`w-dwdata-binance` 之 `saveData`,現貨 K 線端點 `https://api.binance.com/api/v3/klines`、溢價指數 `https://www.binance.com/fapi/v1/premiumIndexKlines`(可由 `opt.endpointPrice`／`opt.endpointIndex` 改);既有且完整之分段不重抓,最新分段每次必抓;`opt.proxy`、`opt.timeBudget`、`opt.timeGrace`、`opt.useShowLog` 透傳.
- `buildOhlc(opt)`:合併分段 csv(或接外部陣列)為序列 json;只留 `time >= timeBegin`;預設剔除尚未收棒之最末根(`opt.dropIncompleteLastBar: false` 保留);index 截齊至 price 最末時間;回傳 `{ timeFirst, timeLast, nPrice, nIndex, changed }`.

## 4. 參數(因子)

`buildParams(opt)` 以 `w-data-trade` 之 `dataConvert` 計算,輸出檔名 `${cointpe}_${keyKind}_${keyIn}_${keyOut}_${method}_${period}.json`(例 `price_ohlc_none_RSI_rsi_1day`),內容 `[{ time, param }]`,`param` 為 z-score.

- **內建目錄**(`src/params/catalog.mjs`):34 個定義(price 20、index 14,共 136 個輸出),不含標的專屬之 z-score 常數(nm 由 `buildParams` 自算;index 側 `optMethod` 為校正起點,見下).`opt.only`／`opt.exclude` 依 `id` 取捨;`opt.defs` 整組替換;`opt.extraDefs` 追加.定義格式:

```js
{
    id: 'price_ohlc_rsi',
    cointpe: 'price',            //'price' | 'index'
    keyKind: 'ohlc',             //輸出檔名之第 2 段
    fields: ['Close'],           //計算實際存取之 K 線欄位, 數據缺任一欄即整個定義跳過
    keysIn: [],                  //取值類(orig/ma/ema/vec 系)之來源欄位; 空陣列代表 'none'
    funAddKeysIn: null,          //逐筆擴增欄位之函數(如成交量衍生欄位)
    methods: [{
        method: 'rsi',           //對應 w-data-trade 之 calc*(可由 opt.calcs 擴充/覆寫)
        optMethod: null,         //傳入 calc 之設定(index 側之偏移參數; 為校正起點)
        deals: [{ keyOut: 'RSI' }, { keyIn: 'Close', keyOut: 'param', nm: { avg, std } }], //keyIn 可省(對每個 keysIn 展開), nm 可省(自算)
    }],
}
```

- **nm(z-score 之 avg／std)之凍結**:首次由 `opt.nmPeriod`(預設 `cfg.train`;`'all'` 為全部數據;或 `{ timeStart, timeEnd }`)之數據自算,寫入 `meta/params.json` 之 `nm`,之後每次重算參數皆沿用,使數據延長時既有策略之門檻不失真;`opt.recalibrate: true` 才重算.定義自帶 `nm` 者直接採用.
- **index 側偏移參數之校正**:溢價指數之 OHLC 量級與價格不同(可 ≈0 或負),以 `optMethod`(`plusClose`、`subMid` 等)把 index 系列變換到與 price 同形狀.內建目錄之值為 ETHUSDT 4hr 之率定值作起點,`buildParams` 預設以 `w-data-trade` 之 `dataCalibrate` 對 price 側同名 keyOut(去尾 `Mod`)重新校正並凍結於 `meta.optMethod`;`opt.calibrateIndex: false` 直接採定義值.回傳之 `calibrated` 列出 `adopt`／`score0`／`scoreBest`.
- **K 線週期**:每次呼叫 calc 皆併入 `barsPerDay = 86400 / intervalSec`(4hr 為 6),使 `w-data-trade`(≥ 1.0.34)之週期表於其他週期維持時間語意(`'1day'` 於 1hr K 線為 24 根;單根型態之標籤為該週期如 `'1hr'`;換算後不足 1 根之期剔除,相鄰週期四捨五入後同根數者保留不去重).`barsPerDay` 由 `buildKp` 於每次呼叫注入 opt,不放進定義之 `optMethod`,故 `dataCalibrate` 不會把它當搜尋參數.
- **自訂計算**:`opt.calcs = { myMethod: async (arr, keyIn, optMethod) => [{ period, len, vs: [{ time, ...keyOuts }] }] }` 搭配 `extraDefs` 之 `method: 'myMethod'`.
- **外部序列**:`opt.series = { key: [{ time, param }] | async fn }` 直接寫入 `param/`(key 不可含路徑分隔符).
- **Close-only 過濾**:`filterKeysCloseOnly(keys)`／`isKeyCloseOnly(key)` 只留由 Close 推導之因子(ma 系 + rsi／macd／bbpb);求解端以 `closeOnly: true` 啟用.

## 5. 先觸快取與因子普測

- `buildCache(opt)`:`w-trade-backtest` 之 `buildKLinesTpSl`,區間預設 `timeBegin` ~ K 線最末,`opt.tps`(預設 4~10,tp=sl)、`opt.modes`;設定相同且檔存在時不重建(`changed: false`),`opt.force` 重建.
- `sweepSingle(opt)`:對每個因子跑 long/short × tpsl × th × sym 全掃描,每方向選 best 等效年化(已平倉筆數須大於 `numTradeFinMin`,預設 50)輸出 raw 策略;`opt.limit`(前 N 個因子)、`opt.filterKeys(keys)`、`opt.takeLimit`(worker 數)、`opt.useAssm`／`opt.usePlateau`(訓練期穩定度 gate,預設關)、`opt.cleanFdOut`(預設清空輸出夾)、`opt.onProgress`.門檻範圍 `opt.thsLong`(預設 0~2)、`opt.thsShort`(預設 -2~0)、`opt.tpsls`.
- `sweepPairs(opt)`:讀 `strategiesP1` 之單因子策略,同向兩兩配對掃 {and, or} × {tpsl_A, tpsl_B},`eqYr > eqYrMin`(預設 15)才輸出;`opt.dedupOverlap`(0~1,進場 Jaccard 大於此值視同質只留高分;預設關)、`opt.limit`、`opt.fdF1`／`opt.fdTar`.
- 兩者皆以訓練期為等效年化基準,出場裁切於訓練期終點之下一根(`exitCut`),結果不隨快取延長而漂移;穩定度 gate 之窗長(90 天／30 天)依 `barsPerDay` 換算為根數.
- 給 `settings.unit` 時:每單名義依基礎單位、策略檔之 `settings` 記錄 `unit`;挑選依等效年化等與本金無關之量,不因 `uIni` 而變(最大持倉名義不設門檻);回傳與進度之形狀不變.

## 6. 最佳化求解(策略庫擴建)

`solve(opt)`／`createSolver(opt)`:每輪一次 `w-trade-solve` 之 `estimFinder`:隨機(或 `opt.mode` 固定)方向、隨機挑一種指標組成 `comps`(`'a,b,c'` 為挑 a 個一般類、b 個指數類、c 個成交量類;18 種預設,**依可用因子類別數自動過濾**,例如無 index 時只剩 `b = 0` 者;亦可 `opt.comps` 自訂),於訓練期以 `opt.methodOml`(預設 `'RGA'`)率定各 key 門檻與止盈止損,同時滿足 `thNumTrade`(預設 1)、`thRWin`(預設 0.5)、`thEqYr`(最低等效年化比例,預設 0.15)者由 `estimKeys` 寫入策略庫(同 tkid 僅於更佳時覆寫).

- **評估核心**:`engine: 'fast'`(預設)以 `w-trade-backtest` 之 `buildStrategyFastSession` 每次約 2~4 ms(官方約 60~100 ms),存檔前以官方 `runStrategy` 重跑並重衍生 summary／tkid／檔名,**落地口徑與完整版相同**;`engine: 'full'` 全程官方.
- **平行**:`workers: n` 以 `worker_threads` 開 n 個 worker 各自循環求解,主程序彙整事件與停止;此時 `opt` 除事件欄位外不可含函數(改用 `closeOnly` 等旗標);`workers: 0`(預設)於本程序內循序執行,可給 `funFilterKeysNorm`／`funFilterKeysIndex`／`funFilterKeysVolumn` 等函數.
- **事件**:`onReady({ workerId, counts, comps, engine })`、`onRound({ workerId, mode, comps, timeStart, timeEnd, candidates, ...status })`(其中 `elapsedMs` 為求解器累計耗時)、`onCandidate({ workerId, mode, comps, keys, conds, settings, summary })`(每個達門檻且存檔之候選)、`onProgress(status)`、`onError(err)`;另有放行前之 `gate`(見〈資源閘〉).
- **停止**:`maxStrategies`(策略庫檔數,含既有)、`maxRounds`(總輪數)、`maxTimeMs`、`shouldStop(status) => bool`、`solver.stop()`;每輪結束檢查;起跑前亦檢查(`workers: 0` 與 `workers > 0` 皆然:庫已達上限、已 `stop()` 或 `shouldStop` 成立即不起跑,`workers > 0` 時不起 worker);`workers > 0` 時各 worker 每輪結束等主程序放行才起下一輪,故停止條件成立時進行中之他 worker 至多再完成當輪(總輪數至多超出 `workers - 1`).
- **資源閘**:`gate: async ({ workerId, ...status }) => {}`,每輪起跑前(含 `workers > 0` 各 worker 之第 1 輪、`workers: 0` 之每輪)由主程序 `await` 其結果後才放行;可在其中量測 CPU／RAM,超限時延後 resolve 以暫停、回落時 resolve 以續跑.`workers > 0` 時 `gate` 於主程序執行(不傳入 worker),各 worker 之閘彼此獨立.閘 resolve 後主程序再查一次停止條件,成立即不放行,並對所有 worker(含仍在別的閘內等待者)送出停止,故閘等待期間停止條件成立不致懸置.`stop()` 隨時生效、不等閘;`shouldStop`／`maxTimeMs`／`maxStrategies` 於輪次結束與每個閘 resolve 後判定,**閘不 resolve 時這三項不會被判定**(閘內宜自行檢查停止);停止後閘之 promise 不被取消.閘拋錯(含 rejection)記入 `status().errors` 並觸發 `onError`,照常放行(不使求解卡死);已要求停止後不再呼叫閘;`maxRoundsPerWorker` 達上限之 worker 末輪後不再過閘.閘只能擋增量:暫停不會釋放 worker 已載入之記憶體.未給 `gate` 時行為不變.
- **基礎單位**:給 `settings.unit` 時,以 `settings.uIni` 與 `unit` 交給 `w-trade-solve` 之 `estimKeys`(策略檔之 `settings` 記錄之);入庫條件不變(最大持倉名義不設門檻),事件與 `status()` 之形狀不變.未給 `unit` 時求解照舊不讀 `cfg.settings`(`estimKeys` 之 `uIni` 1000、`uTrade` 1、`rFee` 0.0005).**策略庫須先依同一口徑重算後再以 `unit` 求解**(同 tkid 之新舊策略以等效年化比較是否覆寫,新舊口徑混在同一庫時比較失準).
- **其他**:`fdStrategies` 指定策略庫位置(預設 `cfg.fds.strategies`,可指到任何資料夾,多個管線可共用一庫);`thsTp`／`thsSl`(止盈止損百分比候選,預設 1~10);`oml`(最佳化演算法設定,如 `{ Np, Ng, NContiguous }`,原樣傳遞至 `w-optimization`);`useShowLog`.opt 之鍵只認 `SOLVE_OPT_KEYS`,打錯即拋錯.
- `status()` 回傳 `{ state, nRounds, nCandidates, nStrategies, nStrategiesStart, nNew, elapsedMs, workers, engine, fdStrategies, stopReason, errors }`.

## 7. 策略庫重算(基礎單位)

`recomputeStrategies(opt)`(`createPipeline(cfg).recomputeStrategies`):既有策略**不重新求解**,逐檔把 `settings` 改記研究用本金 `uIni` 與基礎單位 `unit`、摘要依新口徑重算後寫至另一夾(驗收後由使用端換夾).

- **忠實重放先行**:逐檔以檔內 `settings` 於其求解時間窗(`solve.timeStart`～`solve.timeEnd`)重跑官方 `runStrategy`,摘要須與檔內逐欄相同(`timeTest` 除外);只有通過者才以新口徑重算.不符者為 `mismatch`(列出欄名).檔內 `fitness` 與現行 `calcFitness(settings, summary)` 不同者(舊版適應函數所算)另記 `fitnessStale`,不擋重算,重算時以現行 `calcFitness` 重寫.
- **新口徑**:`settings` 之 `uIni` 換為目標、`unit` 設為目標(其餘欄與鍵序不變,`unit` 接於末);`summary` 為新 `settings` 之重放;`fitness` 重算;其餘欄(`tid`、`tkid`、`conds`、`solve` 等)與鍵序不變.斷言交易筆數、已平倉筆數、勝率與檔名不變(否則 `r8`).最大持倉名義不設門檻:超過目標 `uIni` 者照常重算寫出,只列於統計.檔名與檔數不變(不新增、不刪除、不改名).
- **模式**:`mode: 'verify'`(預設;只做忠實重放)、`'dry'`(重算、只出統計、不寫檔)、`'write'`(寫至 `opt.fdOut`,**須明給**,不提供原地寫回;以暫存檔再改名寫入,目標被短暫開啟時重試數次;不做 fsync).`write` 於任一不合格(`mismatch`、`r8`、`unsupported`、`error`)即中止(不再寫檔並列出;不可關閉,給 `stopOnError: false` 即拋錯),`verify`／`dry` 預設跑完並列出全部(`opt.stopOnError` 可改).目標口徑預設取 `cfg.settings`(`opt.uIni`／`opt.unit` 給予時優先;建議由使用端明給,使管線之 `settings` 於換夾前不必先改).
- **寫出之安全**(不得毀損或覆寫原策略庫;下列檢查皆於寫入來源夾與輸出夾之前,違反即拋錯):
  - `fdOut` 與 `fdIn` 為同一夾或互為上下層即拒.判定以 `fs.realpathSync.native` 正規化(`fdOut` 尚不存在時取其最近之既存上層再接其餘段;Windows 不分大小寫),另以 `dev`＋`ino` 比對目錄本體,故大小寫不同、8.3 短名、目錄連結(junction／symlink)之別名皆拒.檔案識別為 0 之檔案系統(部分網路分享、虛擬磁碟)不以識別比對、只用正規路徑;實體路徑取不到(`realpath` 拋錯)即拒絕執行並說明.建立 `fdOut` 之後再核一次(此時目錄本體之比對才生效,並封住檢查之後才被建成連結之先查後做).
  - `fdReport` 不得等於或位於 `fdIn`、`fdOut` 之內(三個模式皆檢).
  - 首次執行(無可續之 journal)時 `fdOut` 須不存在或不含 `*.json`;前次中斷所遺之暫存檔(`*.tmp-recompute`)於開始時清除.
  - 同一 `fdReport` 以鎖檔 `recompute.lock` 防兩個重算同時使用:內容(PID 與隨機識別)先寫入暫存檔再以 `fs.linkSync` 原子建立;鎖檔之行程仍在即拒;內容無法讀出而修改時刻在 60 秒內者視為使用中;其餘視為殘留而接手:鎖檔全程存在(不先移走再放回,免空窗使他行程建立另一把鎖而同時有兩個持有者),先以保護檔 `recompute.lock.takeover`(原子建立)使同時接手者只有一個進入、其餘即拒,持有保護檔者核對鎖檔仍為所判定之殘留鎖後以暫存檔改名覆蓋為新鎖(原子),回傳 `staleLock: true`;當機於保護檔存在期間而遺留者使其後之接手被拒(偏安全,錯誤訊息附處置:確認無其他重算行程後手動刪除保護檔).**PID 被重用時**(殘留鎖之 PID 已被他程式占用)會誤判為使用中而拒跑,錯誤訊息附鎖檔名(`recompute.lock`)與處置;確認該 PID 不是重算行程後手動刪除鎖檔.
- **可中斷續跑**:每檔結果逐行記於 `opt.fdReport`(預設 `meta/recompute/`)之 `journal_<mode>.jsonl`.首行記模式、資料夾、目標口徑、K 線與參數夾、時區、`thEqYr` 與三個套件(`w-trade-strategy`、`w-trade-solve`、`w-trade-backtest`)之版本,續跑時須相同,否則拋錯(中斷後改了目標口徑或 `thEqYr` 即無法續跑;`resume: false` 又因 `fdOut` 已含 `*.json` 而拒,只能刪除輸出夾重寫 ⇒ 兩者須於 `write` 前定案).各列另記來源檔之位元組數與修改時刻.續跑時已為 `ok` 或 `already`(檔內 `settings` 已等於目標)且來源檔未變者略過,來源檔已變者重做(仍經忠實重放);`write` 另核對輸出檔之位元組數與 sha256(記於 journal),輸出檔缺或不符即重做(`nRedo`).不合格者重做.journal 末行為中斷所遺之半截者丟棄後續跑(`journalTruncated`).`opt.resume: false` 清空重記.
- **入庫門檻**:取檔內 `solve.thREquivalentCumuProfitOrLossFinalNormYear`.檔內無門檻者,給 `opt.thEqYr`(有效數字,數字或數字字串,通過即轉為數值)即以之計並回報筆數(`cross.nThFallback`);未給則列為 `noThreshold`、不計入跨門檻.套件不給預設門檻.
- **統計**(回傳並寫 `report_<mode>.json`;例外中止時亦寫部分報告並標 `crashed`;全部不合格寫 `failures_<mode>.json`、跨門檻與無門檻之全部清單寫 `cross_<mode>.json`、最大持倉名義超過目標 `uIni` 者之全部清單寫 `overUIni_<mode>.json`、檔名與檔內交易次數級距不一致之舊檔寫 `nameMismatch_<mode>.json`):各狀態之隻數、忠實重放之相符數與不符之欄、`fitnessStale` 之隻數、新舊不同之欄、等效年化之前後與差之分布(百分比;前後以同一母體〔重算成功者〕計)、跨過入庫門檻之隻數與清單(往下 `down`、往上 `up`)與重算前後低於門檻之隻數、新口徑之最大持倉名義分布(`uTradeAllMaxAfter`)與同時持倉單位數之分布(`unitsMaxAfter` = `numTradeAllMax` × `units`)、**超過目標 `uIni` 之隻數與最大者**(`overUIni`:`n`、`maxUTradeAllMax`、`maxUnits`、由大至小之前 50 隻;統計基準,只列不判)、`nameMismatch`(只列,輸出沿用原檔名)、`write` 完成時之 `namesSame`(輸出夾之 `*.json` 皆屬 journal 已記為寫出者、且涵蓋本次所選;全庫時另須檔數等於 `fdIn` 之檔數,即檔名集合相同)、三個套件之版本、耗時.`write` 之 `ok` 須完成、無不合格且 `namesSame === true`.
- **其他**:`opt.files`(非空之檔名字串陣列)／`opt.limit`(非負整數,整數字串亦收並轉為數值;只處理前 N 檔,依檔名排序)只處理部分檔,打錯即拋錯(不默默改跑全庫);部分選取之續跑可縮小或擴大選取(`namesSame` 以「輸出夾之檔皆屬 journal 已記者、且涵蓋本次所選」判定)、`opt.takeLimit`(worker 數,正整數,整數字串亦收並轉為數值,預設 2;每 worker 載入全部序列一次)、`opt.onProgress({ i, n, counts, elapsedMs })`(回呼拋錯只計數〔`progressErrors`〕,不中斷).只處理求解所落地之策略檔(有 `solve` 時間窗者;普測之 raw 策略為 `unsupported`).各資料夾之相對路徑皆相對於呼叫時之工作目錄(`process.cwd()`),建議由進入檔傳絕對路徑.單檔重放無逾時.

```js
let pl = createPipeline(cfg)
let tgt = { uIni: 10000, unit, thEqYr: 0.15 }                          //目標口徑與無門檻者之替代門檻(數值為例), 由使用端明給
let fdOut = path.resolve(root, 'strategies_bu')                         //另一夾(不可與策略庫同夾或互為上下層)
let v = await pl.recomputeStrategies({ mode: 'verify', takeLimit: 4 })  //先驗證忠實重放
let d = await pl.recomputeStrategies({ mode: 'dry', ...tgt, takeLimit: 4 })     //看前後分布與跨門檻
let w = await pl.recomputeStrategies({ mode: 'write', fdOut, ...tgt, takeLimit: 4 }) //寫至另一夾, 驗收後再換夾
console.log(v.counts, d.cross.nDown, d.cross.nThFallback, w.ok, w.namesSame)
```

## 8. 測試

`npm test`(mocha `--no-parallel`;約 40 秒;測試所用 worker 數皆為固定小值〔`takeLimit: 2`、`workers: 1~2`〕,不隨 CPU 核數放大;合成 K 線於 `test/_tmp/` 下走完整條管線,不連網;會起 worker_threads).

| 測試檔 | 內容 |
|---|---|
| `unit-cfg` | 設定正規化:必填、週期與 `intervalSec`、預設值、`fds` 覆寫、外部數據與 `useIndex`、`train` 檢核、不認得之鍵、`barsPerDay`、`serializableCfg` |
| `unit-buildOhlc` | 外部陣列／函數來源、`timeBegin` 過濾、未收棒剔除、index 截齊、欄位檢核、meta 之 `changed` |
| `unit-buildParams` | 內建目錄規模、key 命名、nm 凍結／沿用／重算、`useIndex` 與缺欄位之剔除、index 校正之凍結、`extraDefs`＋`calcs`、`series`、自帶 nm、1hr K 線之週期換算 |
| `unit-sweep` | `buildCache`(跳過／強制)、`sweepCfgOf`、`sweepSingle`(格式、每因子每方向至多一檔、`filterKeys`、`cleanFdOut`)、`sweepPairs`(配對、`opr`、去重、`eqYrMin`) |
| `unit-solve` | close-only 規則與 `comps` 解析、`prepareSolve` 之分類與過濾、in-process 事件與策略檔格式、各停止條件、`mode` 與 `timeEndByMode`、`workers` 之停止與收尾、函數選項與不認得之鍵、`status`、資源閘 `gate`(呼叫序列與次數、閘內延遲推後該輪、閘拋錯、起跑前停止條件、閘等待期間停止之不懸置) |
| `unit-baseUnit` | 基礎單位 `settings.unit`:`normalizeUnit` 與 `normalizeCfg` 之檢核與補齊(`null` 補預設、數字字串轉為數值且轉換前後 `key` 相同、非一般物件拒)、`sweepCfgOf`、`sweepSingle`／`sweepPairs`／`solve`(in-process、`workers: 1`)之 `unit` 落地與摘要、加速核心依 `unit` 評估(與 `runStrategy` 之對應欄相同)、單一策略不設持倉門檻(研究用本金小於最大持倉名義時普測之挑選與求解之入庫不變、回傳與事件之形狀不變)、未給 `unit` 時不變 |
| `unit-recompute` | 策略庫重算:`verify`／`dry`／`write` 三模式、忠實重放與其鑑別(竄改摘要與 `fitness`、無 `solve`、壞檔)、新口徑之 `settings`／`summary`／`fitness` 與其餘欄不變、檔名與檔數不變、跨門檻清單、最大持倉名義超過 `uIni` 者照常重算並只列統計(隻數、最大者、單位數、清單)、續跑與 `already`、輸出檔被刪或竄改後續跑重做、journal 末行半截、殘留暫存檔、鎖檔(原子建立、使用中拒、內容無法讀出而很新者視為使用中、殘留接手時之保護檔與鎖檔全程存在、鎖檔無法讀取、接手之競態、多個子行程同時建立與同時接手時恰一個取得)、檔內 `unit` 之數字字串視為同一口徑(`already`)與記錄欄不同者重算、來源檔已變者續跑重做、縮小選取範圍之續跑、例外中止之部分報告、`noThreshold`／`nThFallback`、`nameMismatch`、寫出之安全(同夾、大小寫別名〔Windows〕、目錄連結別名、互為上下層、`fdReport` 位置、`fdOut` 非空、建立 `fdOut` 後被換成連結〔先查後做〕、實體路徑取不到皆拒,且每案〔含續跑〕原策略庫逐位不變)、別名判定之兩法各自之單元測試(正規路徑、目錄本體、識別為 0、實體路徑拋錯)、選項檢核(含數字字串之 `uIni`／`unit`／`thEqYr`／`takeLimit`／`limit` 轉為數值、`invalid opt.<名稱>: must be …` 訊息不含輸入值) |
| `unit-package` | 套件結構與發布面:package.json、依賴對帳與按需引入、`toolg/gDistRollup.mjs` 之 external 寫法、npm 打包清單、`g.mjs` 離線實跑與 README 同步、JSDoc 覆蓋與範例實跑、發布內容不含通用機敏樣式(磁碟機路徑、IPv4、權杖) |

共用測試件(隨包發布,下游可取用):`test/tools/synthKit.mjs`(合成 K 線與設定)、`test/tools/tmpdir.mjs`、`test/tools/jsdocExamples.mjs`;`test/tools/lockChild.mjs` 為 `unit-recompute` 之子行程(多個行程同時取鎖);`test/tools/lockRaceProbe.mjs` 為鎖檔之壓力探測(多個子行程同時接手同一殘留鎖,量持有者數與 `staleLock` 之分布);`test/tools/abPipeline.mjs` 為前後對拍工具(未給 `settings.unit` 時各階段之行為、回傳、事件與策略檔須逐位不變).

## 9. 限制與注意

- `w-data-trade` 各 calc 之週期表以 4hr K 線為基準,本套件以 `barsPerDay` 併入每次呼叫換算(需 ≥ 1.0.34;舊版無此選項時週期標籤只代表根數).`w-data-trade` 對無效之 `barsPerDay` 會靜默改用 4hr 基準,本套件於 `normalizeCfg` 以 `interval`／`intervalSec` 檢核後才換算,不會傳入無效值.
- `fetchData` 只支援幣安現貨 K 線與溢價指數 K 線,且 `w-dwdata-binance` 之 interval 只有 `1m`、`5m`、`15m`、`30m`、`1hr`、`4hr`;其他來源或週期請自行取得 K 線陣列經 `source` 給入.
- 同一工作根之 `timeZone`、`interval` 與 `timeBegin` 不可變更(變更即換新工作根),`meta/params.json` 之凍結值亦綁該工作根.
- `sweepSingle`／`sweepPairs` 預設清空各自輸出夾後重產;`solve` 之策略庫為累積式.
- index 校正之採納以分布形狀距離為準,未對求解品質做對照;可 `calibrateIndex: false` 退回起點值.
- 本套件不含回測、挑選與下單;等效年化等績效欄位皆為訓練期內之值.
- 基礎單位之交易規則以使用端給之現行規則套用於全部歷史;規則或緩衝改變屬口徑變更,須以 `recomputeStrategies` 重算策略庫.求解不讀 `cfg.settings` 之 `uTrade` 與 `rFee`(沿用 `estimKeys` 之 1 與 0.0005;給 `unit` 時只傳 `uIni` 與 `unit`).

## License
[MIT](LICENSE)
