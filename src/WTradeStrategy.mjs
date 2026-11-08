//w-trade-strategy 之聚合入口(自有套件慣例 src/W<Name>.mjs: 預設匯出全部 API 之物件, 供 rollup 打 dist/w-trade-strategy.umd.js 作 main; ESM 使用者仍可深層匯入 src/**)
//  不另放邏輯; 各模組之函數皆可自其檔以深層路徑取用
import readStrategies from 'w-trade-solve/src/readStrategies.mjs'
import createPipeline from './createPipeline.mjs'
import normalizeCfg, { INTERVALS, FDS, CFG_KEYS, intervalSec, serializableCfg } from './cfg.mjs'
import fetchBinance, { ENDPOINT_PRICE, ENDPOINT_INDEX } from './data/fetchBinance.mjs'
import buildOhlc, { HEADS_PRICE, HEADS_INDEX, normalizeExternal, isBarComplete } from './data/buildOhlc.mjs'
import buildParams, { buildKp, validateDef, nmKeyOf } from './params/buildParams.mjs'
import buildCache, { TPS_DEFAULT, fpCacheOf } from './cache/buildCache.mjs'
import sweepSingle from './sweep/sweepSingle.mjs'
import sweepPairs from './sweep/sweepPairs.mjs'
import dedupStrategies from './sweep/dedupStrategies.mjs'
import { sweepCfgOf, assmDefaultOf, eqYrOf } from './sweep/common.mjs'
import { buildBaseBars, calcOrdersStability, binomTailGE } from './sweep/calcOrdersStability.mjs'
import { createSolver, solve, EVENT_KEYS, SOLVE_OPT_KEYS } from './solve/solve.mjs'
import { COMPS_ALL, classifyKeys, parseComps, allowedComps, prepareSolve, runRound } from './solve/solveRound.mjs'
import makeFastEngine from './solve/fastEngine.mjs'
import CATALOG, { funAddKeysInVbs } from './params/catalog.mjs'
import { isKeyCloseOnly, filterKeysCloseOnly, compsCloseOnly } from './params/keysCloseOnly.mjs'
import { makeOtt } from './util/ott.mjs'
import parfor from './util/parfor.mjs'
import { countJson } from './util/fsx.mjs'


/**
 * 策略庫建置管線套件之聚合物件(與各模組之匯出為同一實體)
 *
 * 總組裝：createPipeline(cfg)(別名createTradeStrategy)；階段函數：fetchBinance、buildOhlc、buildParams、buildCache、sweepSingle、sweepPairs、solve、createSolver；
 * 設定與常數：normalizeCfg、CFG_KEYS、INTERVALS、FDS、CATALOG、COMPS_ALL、compsCloseOnly、TPS_DEFAULT、EVENT_KEYS、SOLVE_OPT_KEYS；
 * 工具：classifyKeys、parseComps、allowedComps、isKeyCloseOnly、filterKeysCloseOnly、readStrategies、countStrategies、makeOtt、parfor等
 *
 * @type {Object}
 * @example
 * need test in nodejs.
 *
 * import WTradeStrategy from 'w-trade-strategy/src/WTradeStrategy.mjs'
 *
 * let pl = WTradeStrategy.createPipeline({ root: './data', name: 'ETH', symbol: 'ETHUSDT', interval: '4hr', train: { timeStart: '2022-07-01T00:00:00', timeEnd: '2025-10-06T00:00:00' } })
 * await pl.prepare()
 * let st = await pl.solve({ workers: 4, maxStrategies: 30000 })
 * console.log(st.nStrategies)
 */
let WTradeStrategy = {

    //總組裝
    createPipeline,
    createTradeStrategy: createPipeline,

    //設定
    normalizeCfg,
    serializableCfg,
    CFG_KEYS,
    INTERVALS,
    FDS,
    intervalSec,

    //數據
    fetchBinance,
    ENDPOINT_PRICE,
    ENDPOINT_INDEX,
    buildOhlc,
    HEADS_PRICE,
    HEADS_INDEX,
    normalizeExternal,
    isBarComplete,

    //參數
    buildParams,
    buildKp,
    validateDef,
    nmKeyOf,
    CATALOG,
    funAddKeysInVbs,
    isKeyCloseOnly,
    filterKeysCloseOnly,
    compsCloseOnly,

    //快取與普測
    buildCache,
    TPS_DEFAULT,
    fpCacheOf,
    sweepCfgOf,
    assmDefaultOf,
    eqYrOf,
    sweepSingle,
    sweepPairs,
    dedupStrategies,
    buildBaseBars,
    calcOrdersStability,
    binomTailGE,

    //求解
    solve,
    createSolver,
    prepareSolve,
    runRound,
    makeFastEngine,
    COMPS_ALL,
    classifyKeys,
    parseComps,
    allowedComps,
    EVENT_KEYS,
    SOLVE_OPT_KEYS,

    //工具
    readStrategies,
    countStrategies: countJson,
    makeOtt,
    parfor,

}


export default WTradeStrategy
