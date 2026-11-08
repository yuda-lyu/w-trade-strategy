import get from 'lodash-es/get.js'
import uniq from 'lodash-es/uniq.js'
import genTid from 'w-trade-solve/src/genTid.mjs'
import genSid from 'w-trade-solve/src/genSid.mjs'
import calcOrdersSummarySimple from 'w-trade-backtest/src/calcOrdersSummarySimple.mjs'
import loadKLinesTpSl from 'w-trade-backtest/src/loadKLinesTpSl.mjs'
import calcOS from './calcOrdersStability.mjs'
import { eqYrOf } from './common.mjs'
import { makeOtt } from '../util/ott.mjs'


//雙因子普測之worker核心工廠(設定由sc注入)
//  createCore({ sc, p2data }) → core(job): 對「因子A=byMode[mode][i]」遍歷所有j>i的B配對,
//  每對掃{and,or}×candTpsls, 候選按eqYr由高至低取「第一個通過穩定度gate」者, eqYr>eqYrMin才輸出
//  job = { mode, i, numTradeFinMin, eqYrMin, useAssm, withMask }
//  進場合成用位元運算(intersect=fireA&fireB; union=(fireA|fireB)&presA&presB)
/**
 * 建立雙因子普測之worker核心(載入先觸快取一次，回傳逐因子A之配對工作函數)
 *
 * @function
 * @param {Object} init 輸入{sc(sweepCfgOf之設定),p2data(buildP2Data之共享資料)}
 * @returns {Function} 回傳async函數core(job) => {strategies}，job為{mode,i,numTradeFinMin,eqYrMin,useAssm,withMask}
 * @example
 * need test in nodejs.
 *
 * let core = createCore({ sc, p2data })
 * let r = await core({ mode: 'long', i: 0, numTradeFinMin: 50, eqYrMin: 15 })
 */
let createCore = (init) => {

    let sc = init.sc
    let p2data = init.p2data
    let ott = makeOtt(sc.timeZone)
    let tbl = loadKLinesTpSl(sc.fpCache)

    let trTimes = Object.keys(tbl.bars).filter((t) => t >= sc.tr.ts && t <= sc.tr.te)
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

    let optOrders = { uTrade: sc.uTrade, uIni: sc.uIni, rFee: sc.rFee, maxExitTime: sc.exitCut, skipSort: true }

    let intersectBits = (fireA, fireB) => {
        let r = []
        let nb = fireA.length
        for (let wd = 0; wd < nb; wd++) {
            let x = fireA[wd] & fireB[wd]
            if (x) {
                let base = wd << 3
                for (let b = 0; b < 8; b++) {
                    if (x & (1 << b)) {
                        r.push(base + b)
                    }
                }
            }
        }
        return r
    }

    let unionBitsBothPresent = (fireA, fireB, presA, presB) => {
        let r = []
        let nb = fireA.length
        for (let wd = 0; wd < nb; wd++) {
            let x = (fireA[wd] | fireB[wd]) & presA[wd] & presB[wd]
            if (x) {
                let base = wd << 3
                for (let b = 0; b < 8; b++) {
                    if (x & (1 << b)) {
                        r.push(base + b)
                    }
                }
            }
        }
        return r
    }

    let buildCombo = (mode, A, B, opr, tpsl, summary = {}) => {
        let r = tpsl / 100
        let conds = [
            { key: A.key, sym: A.sym, th: A.th, opr },
            { key: B.key, sym: B.sym, th: B.th, opr },
        ]
        return {
            tid: genTid(sc.name, sc.interval, mode, [A.key, B.key]),
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

    let times = p2data.times
    let presentByKey = p2data.presentByKey
    let byMode = p2data.byMode
    let nMaskBytes = Math.ceil(times.length / 8)

    let core = async (job) => {

        let mode = get(job, 'mode')
        let i = get(job, 'i')
        let numTradeFinMin = get(job, 'numTradeFinMin', 50)
        let eqYrMin = get(job, 'eqYrMin', 15)
        let useAssm = get(job, 'useAssm', false)
        let withMask = get(job, 'withMask', false)

        let fs = byMode[mode]
        let A = fs[i]
        let fireA = A.fire
        let presA = presentByKey[A.key]

        let strategies = []
        for (let j = i + 1; j < fs.length; j++) {

            let B = fs[j]
            let fireB = B.fire
            let candTpsls = uniq([A.tpsl, B.tpsl])

            let combos = []
            for (let opr of ['and', 'or']) {
                let entIdx = opr === 'and'
                    ? intersectBits(fireA, fireB)
                    : unionBitsBothPresent(fireA, fireB, presA, presentByKey[B.key])
                if (!entIdx.length) {
                    continue
                }
                let entTimes = entIdx.map((k) => times[k])
                for (let tpsl of candTpsls) {
                    let orders = tbl.ordersFromBars(mode, tpsl, entTimes, optOrders)
                    let sm = calcOrdersSummarySimple(ott, sc.uIni, orders, sc.tr.ts, sc.tr.te, { skipSort: true })
                    if (sm.numTradeFin <= numTradeFinMin) {
                        continue
                    }
                    let eqYr = eqYrOf(sm)
                    if (eqYr === null) {
                        continue
                    }
                    combos.push({ opr, tpsl, eqYr, summary: sm, entIdx, entTimes })
                }
            }

            combos.sort((a, b) => b.eqYr - a.eqYr)
            let chosen = null
            for (let c of combos) {
                if (c.eqYr <= eqYrMin) {
                    break
                }
                if (useAssm) {
                    let orders = tbl.ordersFromBars(mode, c.tpsl, c.entTimes, optOrders)
                    let st = calcOS.calcOrdersStability(baseOf(mode, c.tpsl), orders, sc.assm)
                    if (!st.ok) {
                        continue
                    }
                }
                chosen = c
                break
            }

            if (chosen) {
                let s = buildCombo(mode, A, B, chosen.opr, chosen.tpsl, chosen.summary)
                if (withMask) {
                    let mask = new Uint8Array(nMaskBytes)
                    for (let k of chosen.entIdx) {
                        mask[k >> 3] |= (1 << (k & 7))
                    }
                    s._entMask = mask
                }
                strategies.push(s)
            }

        }

        return { strategies }
    }

    return core
}


export default createCore
