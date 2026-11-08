import get from 'lodash-es/get.js'
import isnum from 'wsemi/src/isnum.mjs'
import genTid from 'w-trade-solve/src/genTid.mjs'
import genSid from 'w-trade-solve/src/genSid.mjs'
import calcOrdersSummarySimple from 'w-trade-backtest/src/calcOrdersSummarySimple.mjs'
import loadKLinesTpSl from 'w-trade-backtest/src/loadKLinesTpSl.mjs'
import calcOS from './calcOrdersStability.mjs'
import { eqYrOf } from './common.mjs'
import { makeOtt } from '../util/ott.mjs'


//單因子普測之worker核心工廠(設定由sc注入)
//  createCore(sc) → core(job): 對「一個因子」跑long/short × tpsl × th × sym全掃描, 每方向選best等效年化策略
//  job = { factor, arr, numTradeFinMin, useAssm, usePlateau }
//    · arr: 該因子訓練期序列(主程序讀好傳入)
//    · numTradeFinMin: best納入比較的已平倉筆數門檻(須大於此值)
//    · useAssm: 訓練期穩定度gate(預設關: 某消融實驗確證訓練窗gate對前向有害, 留opt-in)
//    · usePlateau: th鄰域平台檢查(預設關, 同上)
//  選法: 候選(過numTradeFin門檻)按eqYr由高至低, 取「第一個通過plateau+穩定度gate」者; 全不過 → 該方向不輸出
//  訓練窗紀律(maxExitTime): 出場 > 訓練期終點當根者視未平倉(exitCut=終點之下一根), 結果不隨快取延長而漂移
/**
 * 建立單因子普測之worker核心(載入先觸快取一次，回傳逐因子工作函數)
 *
 * @function
 * @param {Object} sc 輸入sweepCfgOf之普測設定物件
 * @returns {Function} 回傳async函數core(job) => {factor,strategies}，job為{factor,arr,numTradeFinMin,useAssm,usePlateau}
 * @example
 * need test in nodejs.
 *
 * let core = createCore(sc)
 * let r = await core({ factor: 'price_ohlc_none_RSI_rsi_1day', arr, numTradeFinMin: 50 })
 */
let createCore = (sc) => {

    let ott = makeOtt(sc.timeZone)
    let tbl = loadKLinesTpSl(sc.fpCache)

    //trTimes, 訓練期bar時間(升序)
    let trTimes = Object.keys(tbl.bars).filter((t) => t >= sc.tr.ts && t <= sc.tr.te)

    //baseOf, 各(mode,tpsl)基準prefix sums(lazy)
    let _baseCache = new Map()
    let baseOf = (mode, tpsl) => {
        let k = `${mode}_${tpsl}`
        let hit = _baseCache.get(k)
        if (hit) {
            return hit
        }
        let b = calcOS.buildBaseBars(trTimes, (t) => tbl.bars[t][k], sc.exitCut)
        _baseCache.set(k, b)
        return b
    }

    let optOrders = { uTrade: sc.uTrade, uIni: sc.uIni, rFee: sc.rFee, maxExitTime: sc.exitCut }

    //buildStrategy, 組單因子策略物件(raw)
    let buildStrategy = (mode, factor, sym, th, tpsl, summary = {}) => {
        let r = tpsl / 100
        let conds = [{ key: factor, sym, th }]
        return {
            tid: genTid(sc.name, sc.interval, mode, [factor]),
            sid: genSid(sc.name, sc.interval, mode, conds),
            name: sc.name,
            symbol: sc.symbol,
            interval: sc.interval,
            keyOhlc: sc.keyOhlc,
            mode,
            conds,
            settings: { uIni: sc.uIni, uTrade: sc.uTrade, rTakeProfit: r, rStopLoss: r, rFee: sc.rFee },
            summary,
        }
    }

    //entryTimesOf, 該因子序列取param sym th者
    let entryTimesOf = (arr, sym, th) => {
        return arr
            .filter((r) => isnum(r.param) && (sym === '>' ? r.param > th : r.param < th))
            .map((r) => r.time)
    }

    //evalCfg, 評估該(mode,sym,th,tpsl)的訓練期等效年化+全段edge
    let evalCfg = (arr, mode, sym, th, tpsl) => {
        let entryTimes = entryTimesOf(arr, sym, th)
        let orders = tbl.ordersFromBars(mode, tpsl, entryTimes, optOrders)
        let sm = calcOrdersSummarySimple(ott, sc.uIni, orders, sc.tr.ts, sc.tr.te)
        let eqYr = eqYrOf(sm)
        let nFin = 0
        let nWin = 0
        for (let o of orders) {
            if (o.timeEnd) {
                nFin++
                if (o.uProfitOrLoss > 0) {
                    nWin++
                }
            }
        }
        let base = baseOf(mode, tpsl)
        let bc = base.pr[base.n]
        let bw = base.pw[base.n]
        let edge = (nFin > 0 && bc > 0) ? (nWin / nFin - bw / bc) * 100 : null
        return { eqYr, summary: sm, edge }
    }

    let core = async (job) => {

        let factor = get(job, 'factor')
        let arr = get(job, 'arr')
        let numTradeFinMin = get(job, 'numTradeFinMin', 50)
        let useAssm = get(job, 'useAssm', false)
        let usePlateau = get(job, 'usePlateau', false)

        let strategies = []
        for (let mode of ['long', 'short']) {

            let ths = mode === 'long' ? sc.thsLong : sc.thsShort

            //1) 全掃tpsl × th × sym
            let rows = []
            for (let tpsl of sc.tpsls) {
                for (let thIdx = 0; thIdx < ths.length; thIdx++) {
                    for (let sym of sc.syms) {
                        let th = ths[thIdx]
                        let { eqYr, summary, edge } = evalCfg(arr, mode, sym, th, tpsl)
                        rows.push({ tpsl, th, thIdx, sym, eqYr, summary, edge })
                    }
                }
            }
            let edgeAt = new Map(rows.map((r) => [`${r.tpsl}|${r.sym}|${r.thIdx}`, r.edge]))

            //2) 候選=過樣本門檻者, 按eqYr由高至低; 取第一個通過plateau+穩定度gate者
            let cands = rows
                .filter((r) => r.eqYr != null && r.summary.numTradeFin > numTradeFinMin)
                .sort((a, b) => b.eqYr - a.eqYr)
            let best = null
            for (let c of cands) {

                if (usePlateau) {
                    if (!(c.edge !== null && c.edge > 0)) {
                        continue
                    }
                    let nb = []
                    for (let d of [-1, 1]) {
                        let e = edgeAt.get(`${c.tpsl}|${c.sym}|${c.thIdx + d}`)
                        if (e !== null && e !== undefined) {
                            nb.push(e)
                        }
                    }
                    if (!nb.length) {
                        continue
                    }
                    let ratio = (nb.reduce((s, x) => s + x, 0) / nb.length) / c.edge
                    if (ratio < sc.assm.plateauMin) {
                        continue
                    }
                }

                if (useAssm) {
                    let entryTimes = entryTimesOf(arr, c.sym, c.th)
                    let orders = tbl.ordersFromBars(mode, c.tpsl, entryTimes, optOrders)
                    let st = calcOS.calcOrdersStability(baseOf(mode, c.tpsl), orders, sc.assm)
                    if (!st.ok) {
                        continue
                    }
                }

                best = c
                break
            }

            if (best) {
                strategies.push(buildStrategy(mode, factor, best.sym, best.th, best.tpsl, best.summary))
            }

        }

        return { factor, strategies }
    }

    return core
}


export default createCore
