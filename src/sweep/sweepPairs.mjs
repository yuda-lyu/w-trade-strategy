import path from 'path'
import get from 'lodash-es/get.js'
import map from 'lodash-es/map.js'
import isestr from 'wsemi/src/isestr.mjs'
import isearr from 'wsemi/src/isearr.mjs'
import isfun from 'wsemi/src/isfun.mjs'
import isnum from 'wsemi/src/isnum.mjs'
import fsIsFolder from 'wsemi/src/fsIsFolder.mjs'
import genStrategyFileName from 'w-trade-solve/src/genStrategyFileName.mjs'
import parfor from '../util/parfor.mjs'
import { sweepCfgOf } from './common.mjs'
import buildP2Data from './sweepPairs_data.mjs'
import dedupStrategies from './dedupStrategies.mjs'
import { ensureFolder, cleanFolder, writeJson } from '../util/fsx.mjs'


/**
 * 雙因子策略普測(平行): 讀單因子普測之策略，同模式兩兩配對掃{AND,OR}×{tpsl_A,tpsl_B}選best，eqYr>eqYrMin才raw逐檔輸出
 *
 * 抽自使用端既有管線；須先有sweepSingle之單因子策略、buildParams之因子序列與buildCache之先觸快取
 * 先precompute共享因子資料(位元遮罩)一次性注入每個worker，平行粒度為因子A(每個A對所有j>i之B配對)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件(須含train)
 * @param {Object} [opt={}] 輸入設定物件，預設{}，另接受sweepCfgOf之tpsls/assm/fpCache
 * @param {String} [opt.fdF1] 輸入單因子策略資料夾，預設cfg.fds.strategiesP1
 * @param {String} [opt.fdTar] 輸入輸出資料夾，預設cfg.fds.strategiesP2
 * @param {Number} [opt.numTradeFinMin=50] 輸入納入比較之已平倉筆數門檻(須大於此值)
 * @param {Number} [opt.eqYrMin=15] 輸入輸出門檻之等效年化(%)
 * @param {Integer} [opt.limit=0] 輸入每方向只取前limit個單因子(快速測試用)，0為全量
 * @param {Integer} [opt.takeLimit] 輸入同時worker數
 * @param {Boolean} [opt.useAssm=false] 輸入是否啟用訓練期穩定度gate
 * @param {Number} [opt.dedupOverlap=null] 輸入入庫去重門檻(0~1，進場Jaccard>此值視同質只留高分)，null為關閉
 * @param {Boolean} [opt.cleanFdOut=true] 輸入開跑前是否清空輸出資料夾
 * @param {Function} [opt.onProgress] 輸入進度回呼({i,n,nOut,nBuf,elapsedMs})
 * @returns {Promise} 回傳Promise，resolve為{nJobs,nOut,nDrop,fdTar,elapsedMs}
 * @example
 * need test in nodejs.
 *
 * let r = await sweepPairs(cfg, { dedupOverlap: 0.9 })
 * console.log(r.nOut, r.nDrop)
 */
let sweepPairs = async (cfg, opt = {}) => {

    let sc = sweepCfgOf(cfg, opt)

    let fdF1 = get(opt, 'fdF1', '')
    fdF1 = isestr(fdF1) ? path.resolve(fdF1) : cfg.fds.strategiesP1
    let fdTar = get(opt, 'fdTar', '')
    fdTar = isestr(fdTar) ? path.resolve(fdTar) : cfg.fds.strategiesP2
    let numTradeFinMin = get(opt, 'numTradeFinMin', 50)
    let eqYrMin = get(opt, 'eqYrMin', 15)
    let limit = get(opt, 'limit', 0)
    let takeLimit = get(opt, 'takeLimit', undefined)
    let useAssm = get(opt, 'useAssm', false) === true
    let dedupOverlap = get(opt, 'dedupOverlap', null)
    if (!isnum(dedupOverlap)) {
        dedupOverlap = null
    }
    let cleanFdOut = get(opt, 'cleanFdOut', true) !== false
    let onProgress = get(opt, 'onProgress', null)

    if (!fsIsFolder(fdF1)) {
        throw new Error(`單因子策略資料夾[${fdF1}]不存在, 請先執行sweepSingle`)
    }

    //1) precompute
    let p2data = await buildP2Data(cfg, sc, fdF1, { limit })

    //2) jobs
    let jobs = []
    for (let mode of ['long', 'short']) {
        for (let i = 0; i < p2data.byMode[mode].length; i++) {
            jobs.push({ mode, i, numTradeFinMin, eqYrMin, useAssm, withMask: dedupOverlap !== null })
        }
    }

    //3) fdTar
    if (cleanFdOut) {
        cleanFolder(fdTar)
    }
    else {
        ensureFolder(fdTar)
    }

    //4) run
    let t0 = Date.now()
    let nOut = 0
    let buf = []
    let i = 0
    let n = Math.max(jobs.length, 1)
    let nr = Math.max(Math.floor(n / 200), 1)
    let writeOne = (s) => {
        let fn = genStrategyFileName(s.name, s.interval, s.mode, map(s.conds, 'key'), s.settings, s.summary)
        writeJson(path.resolve(fdTar, fn), s)
        nOut++
    }
    if (jobs.length > 0) {
        await parfor(new URL('./sweepPairs_worker.mjs', import.meta.url), jobs, {
            takeLimit,
            initData: { sc, p2data },
            cb: (r, k) => {
                i++
                if (r && isearr(r.strategies)) {
                    for (let s of r.strategies) {
                        if (dedupOverlap !== null) {
                            buf.push(s)
                        }
                        else {
                            writeOne(s)
                        }
                    }
                }
                if (isfun(onProgress) && (i % nr === 0 || i === n)) {
                    onProgress({ i, n, nOut, nBuf: buf.length, elapsedMs: Date.now() - t0 })
                }
            },
        })
    }

    //5) dedup
    let nDrop = 0
    if (dedupOverlap !== null) {
        let r = dedupStrategies(buf, dedupOverlap)
        nDrop = r.nDrop
        for (let s of r.kept) {
            delete s._entMask
            writeOne(s)
        }
    }

    return { nJobs: jobs.length, nOut, nDrop, fdTar, elapsedMs: Date.now() - t0 }
}


export default sweepPairs
