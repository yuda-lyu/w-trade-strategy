import get from 'lodash-es/get.js'
import map from 'lodash-es/map.js'
import round from 'lodash-es/round.js'
import rang from 'wsemi/src/rang.mjs'
import isearr from 'wsemi/src/isearr.mjs'
import iseobj from 'wsemi/src/iseobj.mjs'
import isestr from 'wsemi/src/isestr.mjs'
import fsIsFile from 'wsemi/src/fsIsFile.mjs'
import { makeOtt } from '../util/ott.mjs'
import { fpCacheOf } from '../cache/buildCache.mjs'


/**
 * 訓練期穩定度gate之預設門檻(滾動窗90天、步30天，依每日根數換算為根數)
 *
 * @function
 * @param {Number} barsPerDay 輸入每日K線根數
 * @returns {Object} 回傳門檻物件{rollWindowBars,rollStepBars,minRollResolved,minRollEdges,icirMin,posMin,nBlocks,minBlockResolved,blockPosMin,plateauMin,sparseMinN,sparsePMax,sparseMinBlocks}
 * @example
 *
 * let a = assmDefaultOf(6)
 * console.log(a.rollWindowBars, a.rollStepBars, assmDefaultOf(24).rollWindowBars)
 * // => 540 180 2160
 *
 */
let assmDefaultOf = (barsPerDay) => ({
    rollWindowBars: Math.max(Math.round(90 * barsPerDay), 2),
    rollStepBars: Math.max(Math.round(30 * barsPerDay), 1),
    minRollResolved: 5,
    minRollEdges: 4,
    icirMin: 0.5,
    posMin: 0.6,
    nBlocks: 4,
    minBlockResolved: 5,
    blockPosMin: 0.5,
    plateauMin: 0.5,
    sparseMinN: 10,
    sparsePMax: 0.1,
    sparseMinBlocks: 2,
})


/**
 * 組出普測(單因子/雙因子)之共用設定(可結構化複製, 經workerData注入worker)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件(須含train)
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {String} [opt.fpCache] 輸入先觸快取檔路徑，預設cfg.fds.cache/cacheKLinesTpSl.json
 * @param {Array} [opt.tpsls=[4,5,6,7,8,9,10]] 輸入止盈止損百分比陣列(tp=sl)
 * @param {Array} [opt.thsLong] 輸入做多門檻陣列，預設0~2切10段
 * @param {Array} [opt.thsShort] 輸入做空門檻陣列，預設-2~0切10段
 * @param {Object} [opt.assm] 輸入穩定度gate門檻之覆寫物件
 * @returns {Object} 回傳普測設定物件
 * @example
 * need test in nodejs.
 *
 * let sc = sweepCfgOf(cfg, { tpsls: [5, 7] })
 * console.log(sc.exitCut, sc.tpsls)
 */
let sweepCfgOf = (cfg, opt = {}) => {

    if (!cfg.train) {
        throw new Error(`cfg.train未給, 普測須以訓練期為等效年化基準`)
    }

    let fpCache = get(opt, 'fpCache', '')
    if (!isestr(fpCache)) {
        fpCache = fpCacheOf(cfg)
    }
    if (!fsIsFile(fpCache)) {
        throw new Error(`尚無先觸快取檔[${fpCache}], 請先執行buildCache`)
    }

    let ott = makeOtt(cfg.timeZone)
    let barsPerDay = 86400 / cfg.intervalSec

    let tpsls = get(opt, 'tpsls', null)
    if (!isearr(tpsls)) {
        tpsls = [4, 5, 6, 7, 8, 9, 10]
    }
    let thsLong = get(opt, 'thsLong', null)
    if (!isearr(thsLong)) {
        thsLong = map(rang(0, 2, 10), (v) => round(v, 1))
    }
    let thsShort = get(opt, 'thsShort', null)
    if (!isearr(thsShort)) {
        thsShort = map(rang(-2, 0, 10), (v) => round(v, 1))
    }

    return {
        name: cfg.name,
        symbol: cfg.symbol,
        interval: cfg.interval,
        intervalSec: cfg.intervalSec,
        keyOhlc: cfg.keyOhlc,
        timeZone: cfg.timeZone,
        tr: { ts: cfg.train.timeStart, te: cfg.train.timeEnd },
        exitCut: ott(cfg.train.timeEnd).add(cfg.intervalSec, 'second').format('YYYY-MM-DDTHH:mm:ss'), //訓練窗出場裁切點=訓練期終點之下一根
        tpsls,
        thsLong,
        thsShort,
        syms: ['>', '<'],
        uIni: cfg.settings.uIni,
        uTrade: cfg.settings.uTrade,
        rFee: cfg.settings.rFee,
        assm: { ...assmDefaultOf(barsPerDay), ...(iseobj(opt.assm) ? opt.assm : {}) },
        fpCache,
        barsPerDay,
    }
}


/**
 * 由回測摘要取等效年化數值(百分比字串轉數值)，無效時回null
 *
 * @function
 * @param {Object} summary 輸入摘要物件(含rEquivalentCumuProfitOrLossFinalNormYear)
 * @returns {Number|null} 回傳等效年化(%)數值或null
 * @example
 *
 * console.log(eqYrOf({ rEquivalentCumuProfitOrLossFinalNormYear: '33.87%' }), eqYrOf({}))
 * // => 33.87 null
 *
 */
let eqYrOf = (summary) => {
    let v = get(summary, 'rEquivalentCumuProfitOrLossFinalNormYear', null)
    if (!isestr(v)) {
        return null
    }
    let x = Number(String(v).replace('%', ''))
    return Number.isFinite(x) ? x : null
}


export { assmDefaultOf, sweepCfgOf, eqYrOf }
export default sweepCfgOf
