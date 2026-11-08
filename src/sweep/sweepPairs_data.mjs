import get from 'lodash-es/get.js'
import uniq from 'lodash-es/uniq.js'
import isnum from 'wsemi/src/isnum.mjs'
import dataProvide from 'w-data-tdprovide/src/WDataTdprovide.mjs'
import readF1Factors from './readF1Factors.mjs'


//precompute共享因子資料(抽自使用端既有管線):
//  讀單因子策略+因子序列, 算出每因子fire(觸發遮罩)+每key present(有資料遮罩), 皆位元打包成Uint8Array, 經workerData注入每個worker
//  回傳{ times, nBars, presentByKey(Uint8Array), byMode(各因子含fire: Uint8Array) }
/**
 * 預算雙因子普測之共享因子資料(各因子之觸發遮罩與各key之有資料遮罩，位元打包為Uint8Array；經workerData注入每個worker)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @param {Object} sc 輸入sweepCfgOf之普測設定物件
 * @param {String} fdF1 輸入單因子策略資料夾路徑字串
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {Integer} [opt.limit=0] 輸入每方向只取前limit個單因子，0為全量
 * @returns {Promise} 回傳Promise，resolve為{times,nBars,presentByKey,byMode:{long,short}}
 * @example
 * need test in nodejs.
 *
 * let p2 = await buildP2Data(cfg, sc, './data/strategiesP1', { limit: 10 })
 * console.log(p2.nBars, p2.byMode.long.length)
 */
let buildP2Data = async (cfg, sc, fdF1, opt = {}) => {

    let limit = get(opt, 'limit', 0)
    let provideData = dataProvide(cfg.fds.ohlc, cfg.fds.param)

    let factors = readF1Factors(fdF1)
    let byMode = {
        long: factors.filter((f) => f.mode === 'long'),
        short: factors.filter((f) => f.mode === 'short'),
    }
    if (limit > 0) {
        byMode.long = byMode.long.slice(0, limit)
        byMode.short = byMode.short.slice(0, limit)
    }
    let all = [...byMode.long, ...byMode.short]
    if (all.length === 0) {
        throw new Error(`單因子策略資料夾[${fdF1}]無策略, 請先執行sweepSingle`)
    }

    let ohlc = await provideData.getTimeSeriesByTimeRange(sc.keyOhlc, sc.tr.ts, sc.tr.te)
    let nBars = ohlc.length
    let times = ohlc.map((r) => r.time)
    let timeIdx = new Map()
    times.forEach((t, i) => timeIdx.set(t, i))
    let nBytes = Math.ceil(nBars / 8)

    let presentByKey = {}
    let paramByKey = new Map()
    for (let key of uniq(all.map((f) => f.key))) {
        let arr = await provideData.getTimeSeriesByTimeRange(key, sc.tr.ts, sc.tr.te)
        let pres = new Uint8Array(nBytes)
        let param = new Float64Array(nBars).fill(NaN)
        for (let rr of arr) {
            let i = timeIdx.get(rr.time)
            if (i !== undefined) {
                pres[i >> 3] |= (1 << (i & 7))
                if (isnum(rr.param)) {
                    param[i] = rr.param
                }
            }
        }
        presentByKey[key] = pres
        paramByKey.set(key, param)
    }

    let toShared = (fsArr) => fsArr.map((f) => {
        let param = paramByKey.get(f.key)
        let fire = new Uint8Array(nBytes)
        for (let i = 0; i < nBars; i++) {
            let b = f.sym === '>' ? param[i] > f.th : param[i] < f.th
            if (b) {
                fire[i >> 3] |= (1 << (i & 7))
            }
        }
        return { key: f.key, sym: f.sym, th: f.th, mode: f.mode, tpsl: f.tpsl, fire }
    })

    return {
        times,
        nBars,
        presentByKey,
        byMode: { long: toShared(byMode.long), short: toShared(byMode.short) },
    }
}


export default buildP2Data
