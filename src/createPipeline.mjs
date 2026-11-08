import path from 'path'
import get from 'lodash-es/get.js'
import isestr from 'wsemi/src/isestr.mjs'
import readStrategies from 'w-trade-solve/src/readStrategies.mjs'
import normalizeCfg from './cfg.mjs'
import fetchBinance from './data/fetchBinance.mjs'
import buildOhlc from './data/buildOhlc.mjs'
import buildParams from './params/buildParams.mjs'
import buildCache from './cache/buildCache.mjs'
import sweepSingle from './sweep/sweepSingle.mjs'
import sweepPairs from './sweep/sweepPairs.mjs'
import { createSolver, solve } from './solve/solve.mjs'
import { readJsonOr, listJsonKeys, countJson } from './util/fsx.mjs'


/**
 * 建立策略庫管線(以設定綁定各階段函數)
 *
 * 階段: fetchData(幣安抓取) → buildOhlc(整理K線序列) → buildParams(計算因子序列) → buildCache(先觸快取) → sweepSingle/sweepPairs(因子普測) 與 solve/createSolver(最佳化求解擴建策略庫)
 * prepare(opt)依序執行fetchData(僅source為'binance'且opt.fetch不為false時)、buildOhlc、buildParams、buildCache(opt.cache為false時略過)，各階段選項由opt.fetchOpt、opt.ohlcOpt、opt.paramsOpt、opt.cacheOpt傳入，回傳{fetch?,ohlc,params,cache?}
 *
 * @function
 * @param {Object} cfgIn 輸入設定物件(見normalizeCfg)
 * @returns {Object} 回傳管線物件{cfg,fetchData,buildOhlc,buildParams,buildCache,prepare,sweepSingle,sweepPairs,solve,createSolver,readStrategies,countStrategies,status}
 * @example
 *
 * let pl = createPipeline({ root: './data', name: 'ETH', symbol: 'ETHUSDT', interval: '4hr', train: { timeStart: '2022-07-01T00:00:00', timeEnd: '2025-10-06T00:00:00' } })
 * console.log(pl.cfg.keyOhlc, typeof pl.prepare, typeof pl.solve, pl.countStrategies())
 * // => ETH_price_4hr function function 0
 *
 */
let createPipeline = (cfgIn) => {

    let cfg = normalizeCfg(cfgIn)

    let fdOf = (fd, def) => (isestr(fd) ? path.resolve(fd) : def)

    let prepare = async (opt = {}) => {
        let r = {}
        if (cfg.source === 'binance' && get(opt, 'fetch', true) !== false) {
            r.fetch = await fetchBinance(cfg, get(opt, 'fetchOpt', {}))
        }
        r.ohlc = await buildOhlc(cfg, get(opt, 'ohlcOpt', {}))
        r.params = await buildParams(cfg, get(opt, 'paramsOpt', {}))
        if (get(opt, 'cache', true) !== false) {
            r.cache = await buildCache(cfg, get(opt, 'cacheOpt', {}))
        }
        return r
    }

    let status = () => {
        return {
            cfg: { root: cfg.root, name: cfg.name, symbol: cfg.symbol, interval: cfg.interval, useIndex: cfg.useIndex, source: cfg.source === 'binance' ? 'binance' : 'external', train: cfg.train },
            ohlc: readJsonOr(path.resolve(cfg.fds.meta, 'ohlc.json'), null),
            params: { nKeys: listJsonKeys(cfg.fds.param).length, meta: readJsonOr(path.resolve(cfg.fds.meta, 'params.json'), null) },
            cache: readJsonOr(path.resolve(cfg.fds.meta, 'cache.json'), null),
            strategies: {
                solve: countJson(cfg.fds.strategies),
                p1: countJson(cfg.fds.strategiesP1),
                p2: countJson(cfg.fds.strategiesP2),
            },
        }
    }

    return {
        cfg,
        fetchData: (opt = {}) => fetchBinance(cfg, opt),
        buildOhlc: (opt = {}) => buildOhlc(cfg, opt),
        buildParams: (opt = {}) => buildParams(cfg, opt),
        buildCache: (opt = {}) => buildCache(cfg, opt),
        prepare,
        sweepSingle: (opt = {}) => sweepSingle(cfg, opt),
        sweepPairs: (opt = {}) => sweepPairs(cfg, opt),
        solve: (opt = {}) => solve(cfg, opt),
        createSolver: (opt = {}) => createSolver(cfg, opt),
        readStrategies: (fd, opt = {}) => readStrategies(fdOf(fd, cfg.fds.strategies), opt),
        countStrategies: (fd) => countJson(fdOf(fd, cfg.fds.strategies)),
        status,
    }
}


export default createPipeline
