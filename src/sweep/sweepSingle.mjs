import path from 'path'
import get from 'lodash-es/get.js'
import map from 'lodash-es/map.js'
import isestr from 'wsemi/src/isestr.mjs'
import isearr from 'wsemi/src/isearr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import dataProvide from 'w-data-tdprovide/src/WDataTdprovide.mjs'
import genStrategyFileName from 'w-trade-solve/src/genStrategyFileName.mjs'
import parfor from '../util/parfor.mjs'
import { sweepCfgOf } from './common.mjs'
import { ensureFolder, cleanFolder, listJsonKeys, writeJson } from '../util/fsx.mjs'


/**
 * 單因子策略普測(平行): 對param資料夾全部因子，每因子long/short全掃描(tpsl×th×sym)選best等效年化策略，raw逐檔輸出
 *
 * 抽自使用端既有管線；須先有buildParams之因子序列與buildCache之先觸快取；輸出之策略檔格式與w-trade-solve estimKeys之策略庫相容(含訓練期summary)
 * 每因子一個工作，由parfor持久worker pool動態派工，主程序負責讀序列與寫檔
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件(須含train)
 * @param {Object} [opt={}] 輸入設定物件，預設{}，另接受sweepCfgOf之tpsls/thsLong/thsShort/assm/fpCache
 * @param {String} [opt.fdTar] 輸入輸出資料夾，預設cfg.fds.strategiesP1
 * @param {Number} [opt.numTradeFinMin=50] 輸入納入比較之已平倉筆數門檻(須大於此值)
 * @param {Integer} [opt.limit=0] 輸入只取前limit個因子(快速測試用)，0為全量
 * @param {Integer} [opt.takeLimit] 輸入同時worker數，預設os.availableParallelism()-1
 * @param {Boolean} [opt.useAssm=false] 輸入是否啟用訓練期穩定度gate
 * @param {Boolean} [opt.usePlateau=false] 輸入是否啟用th鄰域平台檢查
 * @param {Boolean} [opt.cleanFdOut=true] 輸入開跑前是否清空輸出資料夾
 * @param {Function} [opt.filterKeys] 輸入因子key過濾函數(keys) => keys，可為async
 * @param {Function} [opt.onProgress] 輸入進度回呼({i,n,nOut,elapsedMs})
 * @returns {Promise} 回傳Promise，resolve為{nFactors,nOut,fdTar,elapsedMs}
 * @example
 * need test in nodejs.
 *
 * let r = await sweepSingle(cfg, { takeLimit: 4 })
 * console.log(r.nFactors, r.nOut)
 */
let sweepSingle = async (cfg, opt = {}) => {

    let sc = sweepCfgOf(cfg, opt)

    let fdTar = get(opt, 'fdTar', '')
    fdTar = isestr(fdTar) ? path.resolve(fdTar) : cfg.fds.strategiesP1
    let numTradeFinMin = get(opt, 'numTradeFinMin', 50)
    let limit = get(opt, 'limit', 0)
    let takeLimit = get(opt, 'takeLimit', undefined)
    let useAssm = get(opt, 'useAssm', false) === true
    let usePlateau = get(opt, 'usePlateau', false) === true
    let cleanFdOut = get(opt, 'cleanFdOut', true) !== false
    let onProgress = get(opt, 'onProgress', null)

    //keys
    let keys = listJsonKeys(cfg.fds.param)
    if (isfun(opt.filterKeys)) {
        keys = await opt.filterKeys(keys)
    }
    if (!isearr(keys)) {
        throw new Error(`param資料夾[${cfg.fds.param}]無因子序列`)
    }
    if (limit > 0) {
        keys = keys.slice(0, limit)
    }

    //jobs
    let provideData = dataProvide(cfg.fds.ohlc, cfg.fds.param)
    let jobs = []
    for (let factor of keys) {
        let arr = await provideData.getTimeSeriesByTimeRange(factor, sc.tr.ts, sc.tr.te)
        jobs.push({ factor, arr, numTradeFinMin, useAssm, usePlateau })
    }

    //fdTar
    if (cleanFdOut) {
        cleanFolder(fdTar)
    }
    else {
        ensureFolder(fdTar)
    }

    //run
    let t0 = Date.now()
    let nOut = 0
    let i = 0
    let n = jobs.length
    let nr = Math.max(Math.floor(n / 200), 1)
    await parfor(new URL('./sweepSingle_worker.mjs', import.meta.url), jobs, {
        takeLimit,
        initData: sc,
        cb: (r, k) => {
            i++
            if (r && isearr(r.strategies)) {
                for (let s of r.strategies) {
                    let fn = genStrategyFileName(s.name, s.interval, s.mode, map(s.conds, 'key'), s.settings, s.summary)
                    writeJson(path.resolve(fdTar, fn), s)
                    nOut++
                }
            }
            if (isfun(onProgress) && (i % nr === 0 || i === n)) {
                onProgress({ i, n, nOut, elapsedMs: Date.now() - t0 })
            }
        },
    })

    return { nFactors: n, nOut, fdTar, elapsedMs: Date.now() - t0 }
}


export default sweepSingle
