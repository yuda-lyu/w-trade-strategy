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
        interval: '4hr', //內建週期 '1m' | '3m' | '5m' | '15m' | '30m' | '1hr' | '2hr' | '4hr' | '6hr' | '8hr' | '12hr' | '1day' | '1week'; 其他週期另給 intervalSec
        timeZone: 'UTC', //時間字串之固定時區(預設 Asia/Taipei)
        timeBegin: arrPrice[0].time,
        source: { price: arrPrice, index: arrIndex }, //外部數據; 未給 index 時自動 useIndex=false 並剔除基於溢價指數之參數
        train: { timeStart: arrPrice[0].time, timeEnd: arrPrice[n - 1].time }, //終點為最後一根納入之K線之開盤時刻(每根1日而期間止於D日00:00者寫D−1日00:00)
    })

    //1. 數據 → 參數 → 先觸快取(source 為 'binance' 時先 await pl.fetchData(); 亦可一次 await pl.prepare())
    let ro = await pl.buildOhlc({ dropIncompleteLastBar: false })
    ms.push(`buildOhlc: ${ro.nPrice} 根 ${ro.timeFirst} ~ ${ro.timeLast}`)
    let rp = await pl.buildParams({ only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd', 'index_ohlc_close'] }) //未給 only 即內建 35 個定義全算
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
// => buildParams: 100 個因子序列(nm 由訓練期自算並凍結於 meta), 剔除 31 個定義
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
| 抓數據 | `fetchData` | `raw/{name}/{price,index}/{rawKeyOf(cfg)}/*.csv`(直接下載者為 `{interval}`;依時區合併者見〈數據〉) |
| 整理 K 線 | `buildOhlc` | `ohlc/{name}_price_{interval}.json`、`ohlc/{name}_index_{interval}.json` |
| 算參數(因子) | `buildParams` | `param/*.json`(每因子一檔;內建 35 個定義、140 個輸出) |
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
    interval: '4hr',                     //必填: K 線週期 '1m' | '3m' | '5m' | '15m' | '30m' | '1hr' | '2hr' | '4hr' | '6hr' | '8hr' | '12hr' | '1day' | '1week'(INTERVALS;其他週期須給 intervalSec = 每根 K 線之秒數: 60 之正整數倍且至多 31536000,數值或數字字串〔轉為數值〕;給了而無效即拋 `invalid cfg.intervalSec: must be a positive integer multiple of 60 up to 31536000`;內建週期另給不同值即拋 `invalid cfg.intervalSec: must equal the seconds of the built-in cfg.interval`)
    timeBasis: 'span',                   //可選: 時間口徑 'open'(以 K 線開盤時刻計, 同既有) | 'span'(計入每根之時距: 持倉天數與回測天數依實際時點); 未給 = 既有行為(見下)
    timeZone: 'Asia/Taipei',             //時間字串之固定時區(與數據一致, 變更時須換新工作根)
    dayStart: '2020-01-01',              //抓取起始日
    timeBegin: '2022-07-01T00:00:00',    //數據保留起點(早於此之 K 線不寫入 ohlc), 預設 `${dayStart}T00:00:00`
    source: 'binance',                   //'binance'(預設) 或 { price: arr | async (cfg) => arr, index?: arr | async (cfg) => arr }
    aggregateFrom: '4hr',                //可選(只用於 'binance'): 下載之取得方式, 原樣交給 w-dwdata-binance('none' 原生格線 | 'auto' | 基底週期鍵); 研究用之日線宜明給 '4hr'(與 4hr 資料同源); 未給時一律不傳, 由下載套件之預設('auto')決定, 任何週期鍵同一規則(原生格線與 timeZone 之界線對齊者直接下載, 如台北與 UTC 之 1m～4hr; 不對齊者合併, 如東京、加爾各答之 4hr; 須於任何時區皆直接下載原生週期者明給 'none')
    useIndex: true,                      //是否使用溢價指數; 外部數據未給 index 時預設 false; 為 false 時基於 index 之參數被剔除
    train: {                             //訓練期: 最佳化求解與普測之評估區間(只做數據與參數階段時可省)
        timeStart: '2022-07-01T00:00:00',
        timeEnd: '2025-10-06T00:00:00',      //終點 = 最後一根納入之K線之開盤時刻(該根整根納入); 每根1日而期間止於D日00:00者應寫D−1日00:00(見下)
        timeEndByMode: { long: '2025-04-08T00:00:00' }, //可選: 依方向另給終點(含義同timeEnd)
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

cfg 之鍵只認 `CFG_KEYS`,打錯即拋錯並列可用鍵;已正規化之 cfg 可再傳入(衍生鍵 `keyOhlc`、`keyIndex` 略過;原衍生鍵 `barsPerDay` 已移除,見〈限制與注意〉之 Breaking changes).`intervalSec` 以 `w-data-trade`(≥ 1.0.50)之 `chkIntervalSec` 檢核,內建週期之秒數(1m=60、3m=180、5m=300、15m=900、30m=1800、1hr=3600、2hr=7200、4hr=14400、6hr=21600、8hr=28800、12hr=43200、1day=86400、1week=604800;鍵名同 `w-dwdata-binance` 之週期鍵)皆通過;內建週期時以內建秒數為準,另給之 `intervalSec` 須有效且等於內建秒數(無效或不等即拋,不退回預設).

**時間口徑(`cfg.timeBasis`;選用)**:`'open'` 或 `'span'`(以 `w-trade-backtest` 之 `parseBarTime` 檢核,無效即拋 `invalid cfg.timeBasis: must be one of 'open', 'span'`).給了時以 `{ intervalSec: cfg.intervalSec, timeBasis }`(`barTimeOf(cfg)`)一致地交給每一處呼叫回測或求解者:普測兩核心之策略 `settings`(接於末)與 `calcOrdersSummarySimple` 之 opt、求解之 `estimFinder`(寫入策略 `settings`;加速核心與存檔前之官方重跑皆依 `strategy.settings`)、策略庫重算之目標口徑;`'span'` 時持倉天數與回測天數依實際時點計(日線之回測天數計至末根收盤,等效年化隨之),交易筆數與勝率不變.**未給時(含 `null`)各階段之行為、回傳與策略檔與既有逐位相同**;不因週期而自動改預設(日線研究宜明給 `'span'`).

**期間之終點(`train.timeEnd`、`timeEndByMode`)**:為**最後一根納入之 K 線之開盤時刻**,該根整根納入(`'span'` 之回測天數計至其收盤).每根 1 日而期間止於 D 日 00:00(下一期間自 D 日起)者應寫 **D−1 日 00:00**;若照 4hr 之寫法給 D 日 00:00,該根涵蓋 D 日整日,與下一期間之首日重疊.語意不因週期而變(4hr 不變);本套件之設定只有訓練期,不知下一期間之起點,故不另提示.

**工作根之口徑標記(`meta/basis.json`)**:同一工作根不得混存不同口徑之產物(同名之因子檔與策略檔不同義、凍結之 nm 失真).口徑 = 因子語意(根數為本)＋ `intervalSec` ＋ `timeBasis`;非 4hr(或 4hr 而由下載套件合併)時另記 `utcOffsets`(`timeZone` 於數據起點前 1 日至今後 1 年內之各 UTC 偏移分鐘數;同偏移之別名視為相同)、`aggregateBase`(合併之基底週期鍵;直接下載與外部數據為 `null`)、`dayStart`(`source: 'binance'` 時;外部數據為 `null`);求解另記 `thsCond` 與 `levelNumTradeBounds`.4hr(直接下載或外部數據)且未給 `timeBasis`、`thsCond`、`levelNumTradeBounds` 者為預設口徑,**不寫標記、不增任何檔**;但標記存在(他口徑所寫)時照常讀取比對.其餘於首個產出之階段寫入標記:`buildParams`、`sweepSingle`、`sweepPairs` 於寫檔前,`solve` 於**首個策略存檔之前**(求解選項此時已經 `w-trade-solve` 檢測,無效者不留標記);寫入一律「重讀 → 比對 → 寫入」:穩態(標記已存在且一致、無須寫入)時無鎖讀取比對即返回;須寫入時才取短暫之互斥檔 `meta/basis.json.lock`(原子建立、用畢即刪;逾 30 秒未更新者視為殘留而移除,移除失敗亦視為占用而續等;等候上限 35 秒〔大於殘留判定,故持鎖行程被強制結束而遺留者於等候中即被清除〕,逾時拋 `invalid cfg.root: must not have meta/basis.json.lock held by another process; retry later`;建立或移除時之 `EPERM`、`EBUSY` 等視為占用而重試,其餘錯誤只帶錯誤碼、不外漏原生訊息與路徑:`invalid cfg.root: must allow creating meta/basis.json.lock (<錯誤碼>)`、`invalid cfg.root: must allow writing meta/basis.json (<錯誤碼>)`、讀取標記失敗〔暫時性之 `EPERM`、`EBUSY`、`EACCES` 先短暫重試〕:`invalid cfg.root: must allow reading meta/basis.json (<錯誤碼>)`),故首輪中途中止後同一設定再跑不被拒,同口徑之並行者等候後比對通過,兩個求解器(或求解與普測)交錯時後到者於存檔前即拋、不混存兩種口徑.其後各階段(含 `buildOhlc`,只檢查不寫)之口徑須與之相同,不同即拋 `invalid cfg.<intervalSec|timeBasis|timeZone|aggregateFrom|dayStart>: must match the basis recorded in the work root (meta/basis.json)`(求解選項為 `invalid opt.<名稱>: must match the basis recorded in the work root (meta/basis.json); with an empty strategy library, set solve to null in meta/basis.json, or use a new work root` —— 已寫標記而尚未存任何策略即中止者,改求解選項前須依此復原:策略庫尚無任何策略檔時把 `meta/basis.json` 之 `solve` 改為 `null` 後重跑〔只由求解寫入標記之 4hr 工作根亦可刪除該檔〕,或另建工作根;先於任何寫檔);標記存在而無法解析(非 JSON 或非物件)即拋 `invalid cfg.root: must have a readable basis record in meta/basis.json; use a new work root`(任何階段,含 4hr 預設口徑;不當成無標記),`periodBasis` 不為 `'bars'` 即拋 `invalid cfg.root: must have a supported period basis in meta/basis.json; use a new work root`.無標記而須寫標記時(`buildOhlc` 亦於寫任何 K 線檔之前檢查),該口徑所綁之既有產物須為空(每根秒數或數據口徑 ⇒ `param/`、`meta/params.json` 與各策略夾;時間口徑 ⇒ 各策略夾;求解選項 ⇒ 策略庫),否則拋 `invalid cfg.root: must not contain <夾> built without a recorded basis (meta/basis.json); use a new work root` —— 例如以舊版(依時間換算根數)建立之日線工作根,須另建新工作根.策略庫重算(`recomputeStrategies`)不讀寫標記:以不同 `timeBasis` 重算後換夾者,須同時改用新工作根(或使標記與換入之庫一致),否則下一階段即因口徑不一而拋(不會靜默混用).

**外部數據(股價等)**:`source.price` 為 K 線陣列 `[{ time: 'YYYY-MM-DDTHH:mm:ss', Open, High, Low, Close, Volumn?, ... }]`(或回傳該陣列之 async 函數),欄位名與幣安現貨一致(`Volumn`、`QuoteAssetVolume`、`NumberOfTrades`、`TakerBuyBaseAssetVolume`、`TakerBuyQuoteAssetVolume`);缺少之欄位會使依賴該欄位之參數定義被整個剔除(`buildParams` 回傳之 `dropped` 列出原因),只有 OHLC 時仍有 ma／ema／vec／rsi／macd／bbpb／adx／atr／kdj／donchian／keltner／supertrend／ichimoku／vortex／klr／candle 等可用.

## 3. 數據

- `fetchData(opt)`:`w-dwdata-binance` 之 `saveData`,現貨 K 線端點 `https://api.binance.com/api/v3/klines`、溢價指數 `https://www.binance.com/fapi/v1/premiumIndexKlines`(可由 `opt.endpointPrice`／`opt.endpointIndex` 改);既有且完整之分段不重抓,最新分段每次必抓;`opt.proxy`、`opt.timeBudget`、`opt.timeGrace`、`opt.useShowLog` 透傳;`cfg.aggregateFrom` 有給時轉傳.**是否合併與資料夾位置一律依下載套件之判定**(`getIntervalPlan` 之 `mode`／`key`;`rawKeyOf(cfg)`):直接下載者存於 `raw/{name}/{type}/{interval}`(既有),依指定時區之界線合併者存於 `raw/{name}/{type}/{interval}_tz{±HHMM}_d{YYYYMMDD}_from{基底}`(例 `1day_tz+0800_d20200101_from4hr`;資料夾名含偏移與 `dayStart`,讀取與抓取須同一 `timeZone`、`dayStart`、`aggregateFrom`).須合併時價格與溢價指數以同一設定呼叫(故同一合併夾,即 `rawKeyOf(cfg)`),取得方式與未輸出之目標根(`missing`:當日未收、基底缺漏等;此處不拋錯,期間內之洞由 `buildOhlc` 判定)記於 `meta/aggregate.json`;直接下載時不寫此檔.**未給 `cfg.aggregateFrom` 時一律不傳,由下載套件之預設(`'auto'`)決定,既有六鍵(`1m`、`5m`、`15m`、`30m`、`1hr`、`4hr`)與新週期鍵同一規則**:原生格線於期間內之各偏移下皆與 `timeZone` 之界線對齊者直接下載(台北與 UTC 之六鍵皆是,下載之 raw〔資料夾與內容〕與既有逐位相同;例:台北之 `4hr` 為 `raw/{name}/{type}/4hr`),不對齊者改走合併(例:東京〔UTC+9〕之 `4hr` 由 `1hr` 合併、加爾各答〔UTC+5:30〕之 `4hr` 由 `30m` 合併,資料夾為 `4hr_tz+0900_d20200101_from1hr` 等,各根以當地界線起訖,與原生 4h 根不同);有日光節約而須合併者(如紐約之 `4hr`)由下載套件拒絕(於 `normalizeCfg` 即拋,錯誤原樣上拋).須於任何時區皆直接下載原生週期(同舊版之行為)者明給 `aggregateFrom: 'none'`(不論時區皆直接下載、資料夾為 `{interval}`,有日光節約之時區亦不拋;原生根以 UTC 為格線,與當地界線不對齊,見〈日界〉).
- `buildOhlc(opt)`:合併分段 csv(或接外部陣列)為序列 json;只留 `time >= timeBegin`;預設剔除尚未收棒之最末根(`opt.dropIncompleteLastBar: false` 保留);index 截齊至 price 最末時間;回傳 `{ timeFirst, timeLast, nPrice, nIndex, changed }`.**非 4hr 時於寫檔前核對時刻格線**(`checkBarGrid`):相鄰兩根之時差須為每根秒數之正整數倍(可有缺根)、`timeBegin` 與訓練期各界線(`timeStart`、`timeEnd`、`timeEndByMode`)須落在價格序列之格線上、溢價指數須與價格同一格線,不合即拋(例:台北時區之研究界線〔00:00〕配以 UTC 為日界之日線〔台北 08:00 開盤,即明給 `aggregateFrom: 'none'` 者〕即拒;給了不在格線上之 `timeBegin` 或訓練期界線,如日線配 08:00 之界線,亦拒);4hr 不核對(維持既有行為).**`1week`**:每根開於週界線(依 `timeZone`),預設之 `timeBegin`(`${dayStart}T00:00:00`)不一定在其上(如預設 `dayStart` 為週三),須明給落在週界線上之 `timeBegin`,否則拋上列 `invalid cfg.timeBegin` 之格線錯誤.**期間內之洞**(非 4hr):依序列之相鄰時差判定(`gapsOf`;不依賴每次抓取都會覆寫之 `meta/aggregate.json`).`source: 'binance'` 時(交易所資料本身有缺且補不回,遇無數據之段略過並記錄,不拋錯)**預設放行**(`opt.allowGaps` 預設 `true`):把各洞(`{ time, bars }`)與根集合差記入 `meta/ohlc.json` 之 `gaps`(亦隨回傳;價格與溢價指數於共同區間內之根集合不一致者,缺根之一方必有期間內之洞,亦屬之),並以 `console.warn` 提示一則(內容只含序列名與洞數,如 `price gaps: 1, index gaps: 3`,不含時刻;無洞不提示).**明給 `opt.allowGaps: false` 為嚴格模式**(`buildOhlc(cfg, { allowGaps: false })`;管線為 `prepare({ ohlcOpt: { allowGaps: false } })`):遇洞即於寫檔前拋 `invalid <price|index> series: must not have missing bars within the period when opt.allowGaps is false`;**只有明給 `false` 為嚴格**,未給、`null`、其他值皆視為預設放行;外部數據(股票等有交易日曆者,洞為常態)不受 `opt.allowGaps` 影響,不拋、不提示,只記洞數與缺根數;尾端(晚於最末一根)之未收棒或缺根不屬期間內.**4hr 不做此判定**(使用者 2026-11-19 裁定:幣安資料本身即有缺根處,4hr 之缺根**不會被攔下**,亦不核對時刻格線;4hr 而由下載套件合併者〔如東京之 `4hr`〕亦同,其未輸出之目標根見 `meta/aggregate.json`).有溢價指數時 `gaps.edges` 另記兩序列之首、尾根數差(`headBars`:溢價指數首根晚於價格首根之根數,早於者為負;`tailBars`:溢價指數末根早於價格末根之根數),共同區間外之差不屬洞之判定、不拋;`tailBars` 逾 1 根時以 `console.warn` 印一則提示(近期之溢價指數類因子缺值).洞之影響:`'span'` 之持倉天數與回測天數依實際時刻(不失真),根數為本之因子於洞附近跨越較多時間、價格與溢價指數之根對不上.4hr 不判定、不加欄.寫檔前另以口徑標記比對(見〈設定〉).
- **日界**:交易所原生之 `1day`(及 `6hr`、`12hr`)以 UTC 為格線,與 `Asia/Taipei` 之 00:00 不對齊;依指定時區之日界合成之日線由下載套件 `w-dwdata-binance` 提供(本套件不自行聚合),只給 `interval`(與 `timeZone`)即得該時區界線之各根(下載套件自動合併;研究用宜明給 `aggregateFrom: '4hr'`).外部數據之日界由使用端自負,格線核對同上.

## 4. 參數(因子)

`buildParams(opt)` 以 `w-data-trade` 之 `dataConvert` 計算,輸出檔名 `${cointpe}_${keyKind}_${keyIn}_${keyOut}_${method}_${period}.json`(例 `price_ohlc_none_RSI_rsi_1day`),內容 `[{ time, param }]`,`param` 為 z-score.

- **內建目錄**(`src/params/catalog.mjs`):35 個定義(price 21、index 14,共 140 個輸出;其中 34 個抽自使用端既有管線,另增方向改變法 `price_ohlc_dirchange`,見下),不含標的專屬之 z-score 常數(nm 由 `buildParams` 自算;index 側 `optMethod` 為校正起點,見下).`opt.only`／`opt.exclude` 依 `id` 取捨;`opt.defs` 整組替換;`opt.extraDefs` 追加.定義格式:

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
- **K 線週期(根數為本)**:每次呼叫 calc 皆併入 `intervalSec`(= `cfg.intervalSec`,每根 K 線之秒數;4hr 為 14400),使 `w-data-trade`(≥ 1.0.50)各 calc 之內建週期表以**根數**為準:一個參數描述的是「幾根」之線型,換週期時根數不變(`len`、`vs` 與 4hr 時相同),期別標籤(輸出檔名與參數鍵名之末段)= 根數 × 每根時長.內建表之標籤以每根 4hr 寫定(`'1day'` = 6 根、`'30day'` = 180 根),例:
  - 均線(`ma` 系)之根數 6、12、24、42、90、180:4hr 為 `1day`、`2day`、`4day`、`7day`、`15day`、`30day`;1hr 為 `6hr`、`12hr`、`1day`、`42hr`、`90hr`、`180hr`;1day 為 `6day`、`12day`、`24day`、`42day`、`90day`、`180day`.
  - 單根型態(`candle`、`klr`)之標籤為該週期本身(`'1hr'`、`'1day'`);任何週期下皆不剔除任何一期.
  - 標籤規則:時間跨度為整日數者寫 `Nday`,否則整小時數者寫 `Nhr`,否則 `Nm`;不同根數於同一週期下標籤必不同.由參數鍵名之末段與 `intervalSec` 查根數用 `w-data-trade` 之 `periodInfo`(例:`periodInfo('3day', { intervalSec: 86400 })` 為 3 根).
  - `intervalSec` 由 `buildKp` 於每次呼叫注入 opt(直接呼叫 `buildKp` 時,呼叫端給之 `optMethod` 內之 `intervalSec` 可覆寫);`buildParams` 內一律以 `cfg.intervalSec` 為準:交給 `dataConvert` 之各 method 之 `optMethod.intervalSec` 皆為 `cfg.intervalSec`(含不讀選項之 `orig`;`w-data-trade` 要求同一次呼叫之各 method 同一每根秒數),交給 `dataCalibrate` 之 `optMethodInit`／`optMethodRef` 去除 `intervalSec` 並明列搜尋參數 `opt.params`(只校正偏移參數,不把每根時長當搜尋參數),故凍結於 `meta.optMethod` 者不含 `intervalSec`;無效值於 `buildKp`／`normalizeCfg` 即拋錯,不傳入 `w-data-trade`.
  - **暖機**:根數為本,故最長期別於任何週期下皆約需 360 根才有第 1 筆值(依 `w-data-trade` 文件:`adx` 之 `len` 180 自索引 359 起,`ichimoku` 之 `senkouB` 180 自 269,`macd` 倍率 6 自 208);日 K 線即約一年數據,**數據起點(`timeBegin`)宜早於訓練起點至少 360 根**(日線即約 360 日;本套件不強制、不自動改;`timeBegin` 綁工作根,須於建庫前決定);根數不足之期(例:日 K 線僅 100 根時之 `180day` 均線)於 `w-data-trade` 回傳空 `vs`,`buildParams` 仍寫出該期之空序列檔(`[]`)並列入 `keys`(數據過短時 4hr 亦同).
  - 本套件之程式不依因子名稱之期別段做任何判斷(close-only 過濾與三類分類只讀鍵名之第 3、5 段與前綴);由期別標籤反推根數請用 `w-data-trade` 之 `periodInfo`(方向改變法之門檻標籤 `${門檻}pct` 不是時間跨度,`periodInfo`〔`w-data-trade` ≥ 1.0.58〕對之回 `{ bars: 0, spanSec: 0 }`〔同 `none`,無根數視窗〕,見下條).
- **方向改變法(directional change;`price_ohlc_dirchange`,method `dirChange`)**:以 `w-data-trade`(≥ 1.0.58)之 `calcDirChange` 計算,只用收盤、因果(各根之值只用該根與其前之收盤):自至今之極值反向達門檻(對數報酬 `ln(1 + 門檻% ÷ 100)`)即確認換向.4 個輸出 × 4 個門檻(4、6、8、10%)= 16 個鍵,例 `price_ohlc_none_dirState_dirChange_6pct`:`dirState`(已確認之方向 ±1)、`dirRetrace`(自極值逆向之回撤占門檻之比例,`[0, 1)`)、`dirRun`(自轉折點順方向之對數報酬占門檻之比例,確認當根 ≥ 1)、`dirAge`(自確認起之根數).
  - **只列價格側**:溢價指數之值近 0、可為負,取對數無意義.
  - **期別段為門檻**(`4pct`…`10pct`),不是根數:任何 K 線週期下鍵名相同,`intervalSec` 只交 `w-data-trade` 檢核,不換算.確認前無值(序列自第 1 次確認之根起;未曾確認之門檻為空序列).
  - **nm 與既有工作根**:同其他定義(各門檻共用一組 nm;凍結於 `meta/params.json`).已凍結 nm 之既有工作根升版後重跑 `buildParams`(**不須亦不可 `opt.recalibrate`**)時,只對此定義之 4 個 nm 以凍結之 nm 期間自算並追加,既有之序列檔與 nm 逐位不變,不拋錯、不略過;不想要此類因子者以 `opt.exclude: ['price_ohlc_dirchange']` 排除(給 `opt.only` 而未選之者,回傳與 `meta/params.json` 之 `dropped` 多列此定義).既有之策略檔不受影響(不重算);其後之普測與求解會把 16 個鍵納入一般類之抽樣母體.
  - **`dirState` 與門檻格點**:z 分數化後只有兩個值 `z− < 0 < z+`(nm 期間內兩種方向皆出現時),求解之預設門檻格點(−2～2、步長 0.1)中凡落於 `[z−, z+)` 者以 `>` 皆分出同一組(方向為漲之根;`<` 對稱),0 恆在其中;其餘格點為恆真或恆假之條件.不須特別處理,只是此鍵之有效門檻較少.
  - close-only 過濾放行(`calcDirChange` 只讀 Close).
- **自訂計算**:`opt.calcs = { myMethod: async (arr, keyIn, optMethod) => [{ period, len, vs: [{ time, ...keyOuts }] }] }` 搭配 `extraDefs` 之 `method: 'myMethod'`.
- **外部序列**:`opt.series = { key: [{ time, param }] | async fn }` 直接寫入 `param/`(key 不可含路徑分隔符).
- **Close-only 過濾**:`filterKeysCloseOnly(keys)`／`isKeyCloseOnly(key)` 只留由 Close 推導之因子(ma 系 + rsi／macd／bbpb／dirChange);求解端以 `closeOnly: true` 啟用.

## 5. 先觸快取與因子普測

- `buildCache(opt)`:`w-trade-backtest` 之 `buildKLinesTpSl`,區間預設 `timeBegin` ~ K 線最末,`opt.tps`(預設 4~10,tp=sl)、`opt.modes`;設定相同且檔存在時不重建(`changed: false`),`opt.force` 重建.
- `sweepSingle(opt)`:對每個因子跑 long/short × tpsl × th × sym 全掃描,每方向選 best 等效年化(已平倉筆數須大於 `numTradeFinMin`,預設 50)輸出 raw 策略;`opt.limit`(前 N 個因子)、`opt.filterKeys(keys)`、`opt.takeLimit`(worker 數)、`opt.useAssm`／`opt.usePlateau`(訓練期穩定度 gate,預設關)、`opt.cleanFdOut`(預設清空輸出夾)、`opt.onProgress`.門檻範圍 `opt.thsLong`(預設 0~2)、`opt.thsShort`(預設 -2~0)、`opt.tpsls`.
- `sweepPairs(opt)`:讀 `strategiesP1` 之單因子策略,同向兩兩配對掃 {and, or} × {tpsl_A, tpsl_B},`eqYr > eqYrMin`(預設 15)才輸出;`opt.dedupOverlap`(0~1,進場 Jaccard 大於此值視同質只留高分;預設關)、`opt.limit`、`opt.fdF1`／`opt.fdTar`.
- 兩者皆以訓練期為等效年化基準,出場裁切於訓練期終點之下一根(`exitCut`),結果不隨快取延長而漂移;穩定度 gate 之窗長(90 天／30 天)以時間界定,依每日 K 線根數(`86400 / intervalSec`,於 `sweepCfgOf` 內自算)換算為根數(與上述期別之根數為本無關).
- 給 `settings.unit` 時:每單名義依基礎單位、策略檔之 `settings` 記錄 `unit`;挑選依等效年化等與本金無關之量,不因 `uIni` 而變(最大持倉名義不設門檻);回傳與進度之形狀不變.
- 給 `cfg.timeBasis` 時:策略檔之 `settings` 於末記 `intervalSec` 與 `timeBasis`,摘要(`calcOrdersSummarySimple`)依之計回測天數('span' 計至末根收盤),挑選隨之;未給時不變.
- 策略之 `settings` 之數值欄須有效(`w-trade-backtest` ≥ 1.1.43 於重放時拒絕 0 與負值):`sweepCfgOf` 於開跑前檢查 `opt.tpsls` 各元素為正數、`cfg.settings` 之 `uIni`、`uTrade`(給 `unit` 時不檢)為正數、`rFee` 為非負數(數值或數字字串,只檢不轉型),不合即拋 `invalid opt.tpsls: …`／`invalid cfg.settings.<名稱>: …`.
- 開跑前檢查工作根之口徑標記(見〈設定〉),不一致即拋.
- 同一根 K 線內同時觸及止盈與止損時,一律先判止損(`w-trade-backtest` 之既有約定);每根時長愈長(如日線)愈常發生,績效因而偏保守.

## 6. 最佳化求解(策略庫擴建)

`solve(opt)`／`createSolver(opt)`:每輪一次 `w-trade-solve` 之 `estimFinder`:隨機(或 `opt.mode` 固定)方向、隨機挑一種指標組成 `comps`(`'a,b,c'` 為挑 a 個一般類、b 個指數類、c 個成交量類;18 種預設,**依可用因子類別數自動過濾**,例如無 index 時只剩 `b = 0` 者;亦可 `opt.comps` 自訂),於訓練期以 `opt.methodOml`(預設 `'RGA'`)率定各 key 門檻與止盈止損,同時滿足 `thNumTrade`(預設 1)、`thRWin`(預設 0.5)、`thEqYr`(最低等效年化比例,預設 0.15)者由 `estimKeys` 寫入策略庫(同 tkid 僅於更佳時覆寫).

- **評估核心**:`engine: 'fast'`(預設)以 `w-trade-backtest` 之 `buildStrategyFastSession` 每次約 2~4 ms(官方約 60~100 ms),存檔前以官方 `runStrategy` 重跑並重衍生 summary／tkid／檔名,**落地口徑與完整版相同**;`engine: 'full'` 全程官方.
- **平行**:`workers: n` 以 `worker_threads` 開 n 個 worker 各自循環求解,主程序彙整事件與停止;此時 `opt` 除事件欄位外不可含函數(改用 `closeOnly` 等旗標);`workers: 0`(預設)於本程序內循序執行,可給 `funFilterKeysNorm`／`funFilterKeysIndex`／`funFilterKeysVolumn` 等函數.
- **事件**:`onReady({ workerId, counts, comps, engine })`、`onRound({ workerId, mode, comps, timeStart, timeEnd, candidates, ...status })`(其中 `elapsedMs` 為求解器累計耗時)、`onCandidate({ workerId, mode, comps, keys, conds, settings, summary })`(每個達門檻且存檔之候選)、`onProgress(status)`、`onError(err)`;另有放行前之 `gate`(見〈資源閘〉).
- **停止**:`maxStrategies`(策略庫檔數,含既有)、`maxRounds`(總輪數)、`maxTimeMs`、`shouldStop(status) => bool`、`solver.stop()`;每輪結束檢查;起跑前亦檢查(`workers: 0` 與 `workers > 0` 皆然:庫已達上限、已 `stop()` 或 `shouldStop` 成立即不起跑,`workers > 0` 時不起 worker);`workers > 0` 時各 worker 每輪結束等主程序放行才起下一輪,故停止條件成立時進行中之他 worker 至多再完成當輪(總輪數至多超出 `workers - 1`).
- **資源閘**:`gate: async ({ workerId, ...status }) => {}`,每輪起跑前(含 `workers > 0` 各 worker 之第 1 輪、`workers: 0` 之每輪)由主程序 `await` 其結果後才放行;可在其中量測 CPU／RAM,超限時延後 resolve 以暫停、回落時 resolve 以續跑.`workers > 0` 時 `gate` 於主程序執行(不傳入 worker),各 worker 之閘彼此獨立.閘 resolve 後主程序再查一次停止條件,成立即不放行,並對所有 worker(含仍在別的閘內等待者)送出停止,故閘等待期間停止條件成立不致懸置.`stop()` 隨時生效、不等閘;`shouldStop`／`maxTimeMs`／`maxStrategies` 於輪次結束與每個閘 resolve 後判定,**閘不 resolve 時這三項不會被判定**(閘內宜自行檢查停止);停止後閘之 promise 不被取消.閘拋錯(含 rejection)記入 `status().errors` 並觸發 `onError`,照常放行(不使求解卡死);已要求停止後不再呼叫閘;`maxRoundsPerWorker` 達上限之 worker 末輪後不再過閘.閘只能擋增量:暫停不會釋放 worker 已載入之記憶體.未給 `gate` 時行為不變.
- **基礎單位**:給 `settings.unit` 時,以 `settings.uIni` 與 `unit` 交給 `w-trade-solve` 之 `estimKeys`(策略檔之 `settings` 記錄之);入庫條件不變(最大持倉名義不設門檻),事件與 `status()` 之形狀不變.未給 `unit` 時求解照舊不讀 `cfg.settings`(`estimKeys` 之 `uIni` 1000、`uTrade` 1、`rFee` 0.0005).**策略庫須先依同一口徑重算後再以 `unit` 求解**(同 tkid 之新舊策略以等效年化比較是否覆寫,新舊口徑混在同一庫時比較失準).
- **時間口徑**:給 `cfg.timeBasis` 時以 `intervalSec` 與 `timeBasis` 交給 `estimFinder`(`w-trade-solve` 寫入策略之 `settings`;加速核心與存檔前之官方重跑皆依之);未給時不傳(同既有).
- **門檻格點與交易次數級距**:`thsCond`(各 key 條件門檻之格點陣列)與 `levelNumTradeBounds`(交易次數各級距之下界陣列)原樣轉傳 `w-trade-solve`(有效性與錯誤訊息由其決定,錯誤原樣上拋);策略檔之 `solve` 記錄所用之值,自訂級距時 `tkid` 另帶設定(`…@下界`)、檔名雜湊隨之.同一工作根之格點與級距須一致(口徑標記).
- **其他**:`fdStrategies` 指定策略庫位置(預設 `cfg.fds.strategies`,可指到任何資料夾,多個管線可共用一庫;共用時各管線須同一口徑);`thsTp`／`thsSl`(止盈止損百分比候選,預設 1~10;給了即原樣轉傳,無效者由 `w-trade-solve` 拋錯);`oml`(最佳化演算法設定,如 `{ Np, Ng, NContiguous }`,原樣傳遞至 `w-optimization`;**不得含口徑鍵** `thsCond`、`levelNumTradeBounds`、`intervalSec`、`timeBasis`——其值於攤平時會覆寫轉傳之口徑而不入口徑標記,故含者於建立求解器時即拋 `invalid opt.oml.<鍵>: must be given as opt.<鍵>`,先於任何建夾與寫檔;口徑鍵一律以 `opt.<鍵>` 給〔`intervalSec`、`timeBasis` 由 `cfg` 決定〕;亦不得含求解器保留之 `useRunStrategyBeforeSave`、`funRunStrategyCustomBeforeSave`〔存檔前官方重跑與標記之寫入皆經此回呼,覆寫者使策略於無標記且未經官方重跑下存檔〕,含者拋 `invalid opt.oml.<鍵>: must not be given (reserved by the solver)`);`useShowLog`.opt 之鍵只認 `SOLVE_OPT_KEYS`,打錯即拋錯.
- `status()` 回傳 `{ state, nRounds, nCandidates, nStrategies, nStrategiesStart, nNew, elapsedMs, workers, engine, fdStrategies, stopReason, errors }`.

## 7. 策略庫重算(基礎單位)

`recomputeStrategies(opt)`(`createPipeline(cfg).recomputeStrategies`):既有策略**不重新求解**,逐檔把 `settings` 改記研究用本金 `uIni` 與基礎單位 `unit`、摘要依新口徑重算後寫至另一夾(驗收後由使用端換夾).

- **忠實重放先行**:逐檔以檔內 `settings` 於其求解時間窗(`solve.timeStart`～`solve.timeEnd`)重跑官方 `runStrategy`,摘要須與檔內逐欄相同(`timeTest` 除外);只有通過者才以新口徑重算.不符者為 `mismatch`(列出欄名).檔內 `fitness` 與現行 `calcFitness(settings, summary)` 不同者(舊版適應函數所算)另記 `fitnessStale`,不擋重算,重算時以現行 `calcFitness` 重寫.
- **新口徑**:`settings` 之 `uIni` 換為目標、`unit` 設為目標(其餘欄與鍵序不變,`unit` 接於末);`summary` 為新 `settings` 之重放;`fitness` 重算;其餘欄(`tid`、`tkid`、`conds`、`solve` 等)與鍵序不變.斷言交易筆數、已平倉筆數、勝率與檔名不變(否則 `r8`).最大持倉名義不設門檻:超過目標 `uIni` 者照常重算寫出,只列於統計.檔名與檔數不變(不新增、不刪除、不改名).檔內 `settings` 已等於目標且 `fitness` 為現行算法者為 `already`(`write` 時逐位複製):`settings.uIni` 與 `settings.unit` 之數字字串視同同值之數字(例:檔內 `uIni: '10000'` 與目標 `10000` 視為相同,`already` 者連原字串寫法一併複製;與目標不同值者依目標重算,寫出之 `uIni` 為目標之數值);`settings.uIni` 為無效值(非數字字串、非正數或非數值型別)者於忠實重放時即被 `w-trade-backtest` 拒絕,記為 `error`(訊息不含輸入值),`verify`／`dry` 照常跑完並列出、`write` 依下述中止規則停止.上列對數字字串之收受須 `w-trade-backtest` ≥ 1.1.43(`package.json` 已定此下限;更舊版對 `settings.uIni` 之數字字串不轉型而以原字串運算,摘要失真).
- **時間口徑與級距**:忠實重放以檔內 `settings`(含其 `intervalSec`、`timeBasis`);給 `cfg.timeBasis` 時目標口徑另含 `{ intervalSec, timeBasis }`(新 `settings` 於末記之,摘要依之重算;交易筆數、已平倉筆數、勝率與檔名照常斷言不變),未給時檔內之時間欄原樣保留.檔名之不變檢查與 `nameMismatch` 以檔內 `solve.levelNumTradeBounds`(自訂級距者)呼叫 `genStrategyFileName`(`optFnOf`),未記者為預設級距.
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

`npm test`(mocha `--no-parallel`;約 6 分鐘;測試所用 worker 數皆為固定小值〔`takeLimit: 2`、`workers: 1~2`〕,不隨 CPU 核數放大;合成 K 線於 `test/_tmp/` 下走完整條管線,不連網;會起 worker_threads).

| 測試檔 | 內容 |
|---|---|
| `unit-cfg` | 設定正規化:必填、週期與 `intervalSec`(內建 13 種週期之值皆通過 `w-data-trade` 之 `chkIntervalSec`;數字字串轉為數值;給了而無效即拋、訊息不含輸入值;內建週期另給不同值即拋)、`timeBasis`(有給才出現、無效即拋、`barTimeOf`)、預設值、`fds` 覆寫、外部數據與 `useIndex`、`train` 檢核、不認得之鍵、已移除之 `barsPerDay` 不產出亦不收、既有六鍵與新週期鍵同一規則(不留 `LEGACY_INTERVALS`、`aggregateFromOf`;未給 `aggregateFrom` 不出現於回傳)、`serializableCfg` |
| `unit-buildOhlc` | 外部陣列／函數來源、`timeBegin` 過濾、未收棒剔除、index 截齊、欄位檢核、meta 之 `changed`、非 4hr 之時刻格線核對(界線不在格線、間距非整數倍、重複時刻、溢價指數錯開皆拒且不寫檔;4hr 不核對)、外部數據之期間內之洞只記數量(4hr 不加欄)、溢價指數晚開始或較早結束之 `gaps.edges` 與提示、`gapsOf`、`edgesOf`、`checkBarGrid`、`1week` 之預設 `timeBegin` 不在週界線即拒 |
| `unit-readCsvFolder` | `readCsvFolder` 只讀分段 csv 資料夾第 1 層之 `.csv`(依檔名排序合併、僅留 `time` 與指定欄位、數值字串轉數值;非 `.csv` 之檔、第 2 與第 3 層子資料夾內之 `.csv` 皆不讀) |
| `unit-buildParams` | 內建目錄規模、key 命名、nm 凍結／沿用／重算、`useIndex` 與缺欄位之剔除、index 校正之凍結、`extraDefs`＋`calcs`、`series`、自帶 nm、4hr／1hr／1day K 線之期別標籤與根數(手寫期望值)、`buildKp` 之 `intervalSec`(預設、覆寫、數字字串、無效即拋、舊選項 `barsPerDay` 不收;預設與直接呼叫 `w-data-trade` 逐位相同;1hr 之 index 校正與寫出皆併入)、`dataCalibrate` 不把 `intervalSec` 當搜尋參數(凍結值不含之)、`dataConvert` 之各 method 同一 `intervalSec`、方向改變法(目錄之 id 小寫與字母序位置、只在價格側、16 鍵與值、門檻標籤不隨週期、`buildKp` 之 `dirChange` 接線、`dirState` 之 z 分數與門檻格點、既有工作根加入此定義時既有序列與 nm 逐位不變) |
| `unit-sweep` | `buildCache`(跳過／強制)、`sweepCfgOf`(含策略 `settings` 數值欄與 `tpsls` 之檢核、`barTime`)、`sweepSingle`(格式、每因子每方向至多一檔、`filterKeys`、`cleanFdOut`)、`sweepPairs`(配對、`opr`、去重、`eqYrMin`) |
| `unit-interval` | 每根時長與時間口徑之接線(日線合成數據;以真實回測套件之輸出驗證,不用替身):`timeBasis` 轉傳至普測兩核心、求解(in-process、`workers: 1`、`engine: 'full'`)、加速核心、策略庫重算之每一處(`'span'` 之回測天數 n、未給為 n − 1);求解新選項 `thsCond`／`levelNumTradeBounds` 之轉傳與重算之級距;無效之止盈止損候選錯誤上拋(含有效與無效混雜)、`thsTp`／`thsSl` 給了即轉傳(非陣列、空陣列亦由求解套件拋錯;`solveFwdOf`);`oml` 不得覆寫口徑鍵(`thsCond`、`levelNumTradeBounds`、`intervalSec`、`timeBasis`)與保留鍵(`useRunStrategyBeforeSave`、`funRunStrategyCustomBeforeSave`;四種入口:`createSolver`、`solve`、`workers: 1`、直接呼叫 `runRound`;先於建夾與寫檔);根數為本之端到端(4hr 與 1day 同一串 K 線:890 鍵〔依根數之期別 874 + 方向改變法之門檻鍵 16〕、標籤對應〔門檻標籤不變〕、逐值相同) |
| `api-fetchBinance` | 與 `w-dwdata-binance` 之對接(本機假交易所,作業系統配發之埠):台北日線＋`aggregateFrom: '4hr'` 由 4h 合併、價格與溢價指數同一合併夾(`rawKeyOf`)、`meta/aggregate.json`(取得方式與未輸出之目標根)、`buildOhlc` 讀合併夾且各欄等於 6 根之合併;交易所來源之期間內之洞(預設放行並記錄、以 `console.warn` 提示一則〔內容只含序列名與洞數〕,明給 `allowGaps: false` 於寫檔前拋且不寫檔,只有 `false` 為嚴格;無洞不提示;尾端之未收棒不算;4hr 不判洞、不提示);4hr 直接下載之資料夾不變、不寫該檔;未給 `aggregateFrom` 時一律不傳(同下載套件之預設 `'auto'`,既有六鍵與新週期鍵同一規則):台北、UTC 之 4hr 直接下載、資料夾為 `4hr`、K 線為假交易所之原樣 4h 根(同 1.0.22 以前),東京、加爾各答之 4hr 改走合併(1hr、30m 合併為當地界線起訖之 4hr,合併夾 = `rawKeyOf`,`buildOhlc` 讀之,各根等於基底各根之合併),紐約之 4hr 於 `normalizeCfg` 即拋;明給 `aggregateFrom: 'none'` 者於東京、加爾各答、紐約皆直接下載原生 4h;幣安來源之時區無效者於 `normalizeCfg` 即拋;須合併而時區有日光節約、`aggregateFrom` 無效、非幣安來源給 `aggregateFrom` 皆於 `normalizeCfg` 即拋(下載套件之錯誤原樣上拋) |
| `unit-basis` | 工作根之口徑標記 `meta/basis.json`:4hr 預設不建檔(亦無互斥檔)、日線新工作根寫標記(含 `utcOffsets`、`aggregateBase`、`dayStart`)與首個策略存檔之前補記求解選項、口徑不一即拋(求解選項、`timeBasis`〔含 `sweepPairs`〕、每根秒數、時區、合併之基底、`dayStart`)且不動既有檔(`buildOhlc` 於寫 K 線檔前即擋)、無標記之舊語意工作根即拋、4hr 既有庫改給新選項、無效之求解選項不留標記、首輪中途中止後同設定再跑不被拒、兩個求解器交錯不混存、標記無法解析即拋(含 4hr 預設口徑)、`periodBasis` 不支援即拋、`checkBasis`／`commitBasis`(重讀 → 比對 → 寫入)之判定、互斥檔(同口徑並行之等候、穩態不取互斥檔〔遺留之新互斥檔下 2 個 worker 之求解照常〕、等候上限大於殘留判定、持續更新者逾時拋、無法移除之殘留以固定訊息拋)、互斥檔之建立與標記之寫入／讀取失敗以固定訊息拋(只帶錯誤碼、不外漏原生訊息與路徑;讀取遇暫時性之 `EPERM`、`EBUSY` 先重試)、`src/util/basis.mjs` 全部訊息之 V19／V20 靜態掃描、`buildOhlc` 於無標記之舊工作根即拒且 K 線檔不變、求解口徑不同之訊息與復原途徑 |
| `unit-solve` | close-only 規則與 `comps` 解析(含方向改變法之鍵)、`prepareSolve` 之分類與過濾、in-process 事件與策略檔格式、各停止條件、`mode` 與 `timeEndByMode`、`workers` 之停止與收尾、函數選項與不認得之鍵、`status`、資源閘 `gate`(呼叫序列與次數、閘內延遲推後該輪、閘拋錯、起跑前停止條件、閘等待期間停止之不懸置) |
| `unit-baseUnit` | 基礎單位 `settings.unit`:`normalizeUnit` 與 `normalizeCfg` 之檢核與補齊(`null` 補預設、數字字串轉為數值且轉換前後 `key` 相同、非一般物件拒)、`sweepCfgOf`、`sweepSingle`／`sweepPairs`／`solve`(in-process、`workers: 1`)之 `unit` 落地與摘要、加速核心依 `unit` 評估(與 `runStrategy` 之對應欄相同)、單一策略不設持倉門檻(研究用本金小於最大持倉名義時普測之挑選與求解之入庫不變、回傳與事件之形狀不變)、未給 `unit` 時不變 |
| `unit-recompute` | 策略庫重算:`verify`／`dry`／`write` 三模式、忠實重放與其鑑別(竄改摘要與 `fitness`、無 `solve`、壞檔)、新口徑之 `settings`／`summary`／`fitness` 與其餘欄不變、檔名與檔數不變、跨門檻清單、最大持倉名義超過 `uIni` 者照常重算並只列統計(隻數、最大者、單位數、清單)、續跑與 `already`、輸出檔被刪或竄改後續跑重做、journal 末行半截、殘留暫存檔、鎖檔(原子建立、使用中拒、內容無法讀出而很新者視為使用中、殘留接手時之保護檔與鎖檔全程存在、鎖檔無法讀取、接手之競態、多個子行程同時建立與同時接手時恰一個取得)、檔內 `unit` 之數字字串視為同一口徑(`already`)與記錄欄不同者重算、來源檔已變者續跑重做、縮小選取範圍之續跑、例外中止之部分報告、`noThreshold`／`nThFallback`、`nameMismatch`、寫出之安全(同夾、大小寫別名〔Windows〕、目錄連結別名、互為上下層、`fdReport` 位置、`fdOut` 非空、建立 `fdOut` 後被換成連結〔先查後做〕、實體路徑取不到皆拒,且每案〔含續跑〕原策略庫逐位不變)、別名判定之兩法各自之單元測試(正規路徑、目錄本體、識別為 0、實體路徑拋錯)、選項檢核(含數字字串之 `uIni`／`unit`／`thEqYr`／`takeLimit`／`limit` 轉為數值、`invalid opt.<名稱>: must be …` 訊息不含輸入值、檔內 `settings.uIni` 之數字字串〔同值為 `already`、不同值依目標重算、無效值為 `error` 且不中斷整批〕) |
| `unit-package` | 套件結構與發布面:package.json、依賴對帳與按需引入、`toolg/gDistRollup.mjs` 之 external 寫法、npm 打包清單、`g.mjs` 離線實跑與 README 同步、JSDoc 覆蓋與範例實跑、發布內容不含通用機敏樣式(磁碟機路徑、IPv4、權杖) |

共用測試件(隨包發布,下游可取用):`test/tools/synthKit.mjs`(合成 K 線與設定)、`test/tools/tmpdir.mjs`、`test/tools/jsdocExamples.mjs`;`test/tools/lockChild.mjs` 為 `unit-recompute` 之子行程(多個行程同時取鎖);`test/tools/lockRaceProbe.mjs` 為鎖檔之壓力探測(多個子行程同時接手同一殘留鎖,量持有者數與 `staleLock` 之分布);`test/tools/fakeExchange.mjs` 為假交易所(本機 HTTP、作業系統配發之埠;`api-fetchBinance` 與 `abPipeline` 共用);`test/tools/solveDet.mjs` 為求解測試之決定性輔助(`quickDetOf`:固定亂數種子、方向、指標組成與挑 key,使單輪之產出為定數;`untilOne`:以有上限之輪數求解至策略庫有策略;`unit-baseUnit`、`unit-solve`、`unit-recompute` 共用);`test/tools/abPipeline.mjs` 為前後對拍工具(4hr 未給新選項時各階段之行為、回傳、事件,及整個工作根之輸出樹〔檔名清單與每檔之內容;新增或消失之檔皆被抓到〕須逐位不變;`--tz` 指定時區,`--raw` 改以假交易所之幣安來源跑既有六鍵之 `fetchData`〔raw 之全部 csv〕與 `buildOhlc`,其中 4hr 另跑其後各階段).

## 9. 限制與注意

- **Breaking changes(配合 `w-data-trade` 1.0.50 之根數為本;`opt.barsPerDay` 已於該版移除)**:
  - `cfg.barsPerDay`(衍生欄)與 `buildKp` 之 `opt.barsPerDay` 已移除,改為 `cfg.intervalSec`／`opt.intervalSec`(每根 K 線之秒數);傳入已移除之 `barsPerDay` 為不認得之鍵(`normalizeCfg` 拋錯;`buildKp` 視為未知鍵忽略),不保留相容路徑.把舊版 `normalizeCfg` 之回傳物件(含 `barsPerDay`)再傳入新版會因不認得之鍵而拋錯,須重新由原始設定正規化.
  - **非 4hr 週期之因子鍵與值改變**:根數不變、期別標籤依「根數 × 每根時長」換算(例:1hr 之均線由 `1day`〔24 根〕、`2day`〔48 根〕…`30day`〔720 根〕改為 `6hr`〔6 根〕、`12hr`、`1day`〔24 根〕、`42hr`、`90hr`、`180hr`〔180 根〕),各期之序列值隨根數而變.**以舊版建立之非 4hr 因子庫須重建**(因子、普測與求解之策略檔所引因子鍵皆須重產),**不可與新版混用**;4hr 之鍵集合、鍵序與數值與舊版逐位相同.
  - **暖機**:根數為本下最長期別約需 360 根,資料起點(`timeBegin`)宜早於訓練起點至少 360 根(見〈參數〉之 K 線週期).
  - **內建週期另給不同之 `intervalSec` 即拋**(`invalid cfg.intervalSec: must equal the seconds of the built-in cfg.interval`;舊版以內建秒數為準而靜默忽略);已正規化之 cfg 換 `interval` 後再傳入者須一併清除 `intervalSec`.`INTERVALS` 新增 `3m`、`2hr`、`6hr`、`8hr`、`12hr`、`1day`、`1week`(原以非內建名稱另給 `intervalSec` 者,同名同值時照常).
  - 非 4hr 之工作根新增口徑標記 `meta/basis.json` 與 `buildOhlc` 之時刻格線核對(見〈設定〉與〈數據〉);以舊版建立之非 4hr 工作根於新版之 `buildParams`、普測與求解即拋(須另建工作根;1.0.22 以前所建之非 4hr 工作根亦同,無法與更舊版所建者區分).
  - 非 4hr 而 `source: 'binance'` 者,期間內有洞時 `buildOhlc` 預設照常(略過、記入 `meta/ohlc.json` 之 `gaps`,並以 `console.warn` 提示一則,內容只含序列名與洞數);舊版靜默接受、不記錄.明給 `opt.allowGaps: false`(嚴格模式)才於寫檔前拋錯.
  - 標記存在而無法解析者,任何階段(含 4hr 預設口徑)即拋.
  - `source: 'binance'` 而 `timeZone` 無效者,於 `normalizeCfg` 即由 `w-dwdata-binance`(≥ 1.0.60;其檢測時區不論取得方式)拋錯(先於任何連網、建夾、寫檔);既有版本於其後之階段才出錯.外部數據不經此檢核(同既有).
  - **既有六鍵(`1m`、`5m`、`15m`、`30m`、`1hr`、`4hr`)之下載不再明傳 `'none'`,與新週期鍵同一規則(未給 `aggregateFrom` 一律不傳,由 `w-dwdata-binance` 之預設 `'auto'` 決定;本套件不留新舊兩套語意)**:`Asia/Taipei` 與 `UTC` 下既有六鍵之原生格線與界線對齊,**下載之 raw(資料夾與內容)與整個 4hr 工作根逐位相同**;**目標之原生格線與 `timeZone` 之界線不對齊之時區為不相容之改變**:東京(UTC+9)、加爾各答(UTC+5:30)等之 `4hr`(及 `1hr` 等)改由較短之原生週期合併(資料夾與各根改變:`4hr_tz+0900_d20200101_from1hr` 等,各根以當地界線起訖,不再是 UTC 之原生 4h 根),**既有之 4hr 工作根於這些時區須另建**;有日光節約之時區(如紐約)之 `4hr` 等須合併者於 `normalizeCfg` 即拋 `w-dwdata-binance` 之錯誤(先於任何連網、建夾、寫檔).**遷移**:須維持舊行為(UTC 原生格線之根、資料夾 `4hr`)者明給 `aggregateFrom: 'none'`(任何時區皆直接下載原生週期,有日光節約之時區亦不拋).
  - **1m、5m、15m、30m、1hr(非 4hr 之既有鍵)屬不相容之改變**:①`buildParams` 等寫 `meta/basis.json`(另記 `utcOffsets` 等),`meta/ohlc.json` 多 `gaps` 欄;②有日光節約之時區而明給 `aggregateFrom: 'none'` 之日內週期,於秋季回撥日之當地時刻字串重複,被格線核對拒絕(既有版本靜默寫出重複時刻);③`source: 'binance'` 而期間內有洞者,預設照常並記入 `gaps`、以 `console.warn` 提示一則(明給 `opt.allowGaps: false` 才拋;4hr 不判定);④舊版所建之工作根(無標記而有產物)於 `buildOhlc`、`buildParams`、普測與求解即拋.
  - **4hr 不做格線核對與期間內之洞之判定**(使用者 2026-11-19 裁定:幣安資料本身即有缺根處):4hr 之缺根不會被攔下(`buildOhlc` 不加 `gaps` 欄,維持既有行為);此為刻意之範圍,非遺漏.
  - `solve` 之 `oml` 不得含 `thsCond`、`levelNumTradeBounds`、`intervalSec`、`timeBasis`(含者拋 `invalid opt.oml.<鍵>: must be given as opt.<鍵>`,先於任何建夾與寫檔):`oml` 攤平時會覆寫轉傳給求解之同名口徑而不入口徑標記,口徑標記即被繞過.
  - `cfg.intervalSec` 現依 `w-data-trade` 之判準檢核(60 之正整數倍且至多 31536000;數字字串轉為數值),給了而無效即拋 `invalid cfg.intervalSec: must be a positive integer multiple of 60 up to 31536000`(內建週期時另給之無效值亦拋;舊版於內建週期時忽略另給之值〔含 0、空字串、`NaN`〕,非內建週期時只檢核為大於 0 之數值〔數字字串雖通過但不轉型,非整數與非 60 之倍數亦通過〕,故設定檔中帶佔位值者升級後會於建立管線時拋錯).`package.json` 之 `w-data-trade` 最低版為 ^1.0.50.
- `w-data-trade` 1.0.50 起 `opt.intervalSec` 給了而無效即拒絕(不退回預設 4hr);本套件於 `normalizeCfg` 與 `buildKp` 先以同一判準檢核並轉為數值,不會傳入無效值.
- `fetchData` 只支援幣安現貨 K 線與溢價指數 K 線,週期與取得方式依 `w-dwdata-binance`(須為支援 `getIntervalPlan` 與 `aggregateFrom` 之版本;`package.json` 定其下限)之週期鍵;其他來源或週期請自行取得 K 線陣列經 `source` 給入.`src/cfg.mjs` 頂層匯入其 `src/intervals.mjs`,低於該下限之版本使本套件載入失敗.
- 同一工作根之 `timeZone`、`interval` 與 `timeBegin` 不可變更(變更即換新工作根),`meta/params.json` 之凍結值亦綁該工作根.
- `sweepSingle`／`sweepPairs` 預設清空各自輸出夾後重產;`solve` 之策略庫為累積式.
- index 校正之採納以分布形狀距離為準,未對求解品質做對照;可 `calibrateIndex: false` 退回起點值.
- 本套件不含回測、挑選與下單;等效年化等績效欄位皆為訓練期內之值.
- 基礎單位之交易規則以使用端給之現行規則套用於全部歷史;規則或緩衝改變屬口徑變更,須以 `recomputeStrategies` 重算策略庫.求解不讀 `cfg.settings` 之 `uTrade` 與 `rFee`(沿用 `estimKeys` 之 1 與 0.0005;給 `unit` 時只傳 `uIni` 與 `unit`).

## License
[MIT](LICENSE)
