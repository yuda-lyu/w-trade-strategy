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
