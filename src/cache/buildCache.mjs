import path from 'path'
import get from 'lodash-es/get.js'
import isEqual from 'lodash-es/isEqual.js'
import isearr from 'wsemi/src/isearr.mjs'
import istime from 'wsemi/src/istime.mjs'
import fsIsFile from 'wsemi/src/fsIsFile.mjs'
import buildKLinesTpSl from 'w-trade-backtest/src/buildKLinesTpSl.mjs'
import { ensureFolder, readJsonOr, writeJson, nowIso } from '../util/fsx.mjs'


/**
 * 預設之止盈止損百分比候選(tp=sl)
 *
 * @type {Array}
 */
let TPS_DEFAULT = [4, 5, 6, 7, 8, 9, 10]


/**
 * 先觸快取檔路徑(cfg.fds.cache/cacheKLinesTpSl.json)
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @returns {String} 回傳快取檔絕對路徑
 * @example
 *
 * console.log(fpCacheOf({ fds: { cache: '/x/cache' } }).replace(/\\/g, '/').endsWith('/x/cache/cacheKLinesTpSl.json'))
 * // => true
 *
 */
let fpCacheOf = (cfg) => path.resolve(cfg.fds.cache, 'cacheKLinesTpSl.json')


/**
 * 建置各K線與各止盈止損組合之先觸結果快取(供單因子與雙因子普測使用)
 *
 * 以w-trade-backtest之buildKLinesTpSl建置，區間預設自cfg.timeBegin至K線最末時間(meta/ohlc.json之timeLast)，設定與前次相同且快取檔存在時不重建
 *
 * @function
 * @param {Object} cfg 輸入normalizeCfg正規化後之設定物件
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {String} [opt.ts] 輸入起始時間，預設cfg.timeBegin
 * @param {String} [opt.te] 輸入結束時間，預設K線最末時間
 * @param {Array} [opt.tps=[4,5,6,7,8,9,10]] 輸入止盈止損百分比陣列
 * @param {Array} [opt.modes=['long','short']] 輸入交易方向陣列
 * @param {Boolean} [opt.force=false] 輸入是否強制重建布林值
 * @returns {Promise} 回傳Promise，resolve為{fpCache,want,meta,changed}
 * @example
 * need test in nodejs.
 *
 * let r = await buildCache(cfg)
 * console.log(r.meta.nBars, r.changed)
 */
let buildCache = async (cfg, opt = {}) => {

    ensureFolder(cfg.fds.param)
    let fpCache = fpCacheOf(cfg)
    let fpMeta = path.resolve(cfg.fds.meta, 'cache.json')

    //ts, te
    let ohlcMeta = readJsonOr(path.resolve(cfg.fds.meta, 'ohlc.json'), null)
    let ts = get(opt, 'ts', '')
    if (!istime(ts)) {
        ts = cfg.timeBegin
    }
    let te = get(opt, 'te', '')
    if (!istime(te)) {
        te = get(ohlcMeta, 'timeLast', '')
    }
    if (!istime(te)) {
        throw new Error(`無法決定快取結束時間, 請先執行buildOhlc或給opt.te`)
    }

    //tps, modes
    let tps = get(opt, 'tps', null)
    if (!isearr(tps)) {
        tps = TPS_DEFAULT
    }
    let modes = get(opt, 'modes', null)
    if (!isearr(modes)) {
        modes = ['long', 'short']
    }

    let want = { keyOhlc: cfg.keyOhlc, ts, te, tps, modes }

    //skip
    let prev = readJsonOr(fpMeta, null)
    if (get(opt, 'force', false) !== true && prev && isEqual(prev.want, want) && fsIsFile(fpCache)) {
        return { ...prev, changed: false }
    }

    //build
    let r = await buildKLinesTpSl(cfg.fds.ohlc, cfg.fds.param, fpCache, want)
    let meta = { fpCache, want, meta: r.meta, at: nowIso() }
    writeJson(fpMeta, meta)

    return { ...meta, changed: true }
}


export { TPS_DEFAULT, fpCacheOf }
export default buildCache
