import fs from 'fs'
import path from 'path'
import get from 'lodash-es/get.js'
import fsIsFolder from 'wsemi/src/fsIsFolder.mjs'
import fsCreateFolder from 'wsemi/src/fsCreateFolder.mjs'
import fsReadJson from 'wsemi/src/fsReadJson.mjs'
import fsWriteJson from 'wsemi/src/fsWriteJson.mjs'


/**
 * 資料夾不存在則建立
 *
 * @function
 * @param {String} fd 輸入資料夾路徑字串
 * @returns {String} 回傳同一路徑字串
 * @example
 * need test in nodejs.
 *
 * ensureFolder('./data/param')
 */
let ensureFolder = (fd) => {
    if (!fsIsFolder(fd)) {
        fsCreateFolder(fd)
    }
    return fd
}


/**
 * 讀取json檔，不存在或解析失敗時回傳def
 *
 * @function
 * @param {String} fp 輸入檔案路徑字串
 * @param {*} [def=null] 輸入預設值，預設null
 * @returns {*} 回傳解析結果或def
 * @example
 * need test in nodejs.
 *
 * let meta = readJsonOr('./data/meta/ohlc.json', null)
 */
let readJsonOr = (fp, def = null) => {
    if (!fs.existsSync(fp)) {
        return def
    }
    let r = fsReadJson(fp) //回傳{success}或{error}
    return get(r, 'success', def)
}


/**
 * 寫出json檔(自動建立上層資料夾)
 *
 * @function
 * @param {String} fp 輸入檔案路徑字串
 * @param {*} obj 輸入資料
 * @param {Object} [opt={}] 輸入設定物件，預設{}
 * @param {Boolean} [opt.format=true] 輸入是否縮排布林值，預設true
 * @returns {undefined} 無回傳
 * @example
 * need test in nodejs.
 *
 * writeJson('./data/meta/x.json', { a: 1 })
 */
let writeJson = (fp, obj, opt = {}) => {
    ensureFolder(path.dirname(fp))
    fsWriteJson(fp, obj, { useFormat: opt.format !== false })
}


/**
 * 列舉資料夾內第1層json檔之主檔名(即序列key或策略檔名)
 *
 * @function
 * @param {String} fd 輸入資料夾路徵字串
 * @returns {Array} 回傳主檔名字串陣列，資料夾不存在時回傳[]
 * @example
 * need test in nodejs.
 *
 * let keys = listJsonKeys('./data/param')
 */
let listJsonKeys = (fd) => {
    if (!fsIsFolder(fd)) {
        return []
    }
    return fs.readdirSync(fd)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
}


/**
 * 計算資料夾內第1層json檔數
 *
 * @function
 * @param {String} fd 輸入資料夾路徑字串
 * @returns {Number} 回傳檔數，資料夾不存在時為0
 * @example
 * need test in nodejs.
 *
 * let n = countJson('./data/strategies')
 */
let countJson = (fd) => {
    if (!fsIsFolder(fd)) {
        return 0
    }
    let n = 0
    for (let f of fs.readdirSync(fd)) {
        if (f.endsWith('.json')) {
            n++
        }
    }
    return n
}


/**
 * 清空資料夾內全部檔案與子資料夾(不存在則建立)
 *
 * @function
 * @param {String} fd 輸入資料夾路徑字串
 * @returns {String} 回傳同一路徑字串
 * @example
 * need test in nodejs.
 *
 * cleanFolder('./data/strategiesP1')
 */
let cleanFolder = (fd) => {
    if (fsIsFolder(fd)) {
        fs.rmSync(fd, { recursive: true, force: true })
    }
    fsCreateFolder(fd)
    return fd
}


/**
 * 當下時間之ISO字串(UTC)，供meta記錄
 *
 * @function
 * @returns {String} 回傳ISO時間字串
 * @example
 *
 * console.log(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(nowIso()))
 * // => true
 *
 */
let nowIso = () => new Date().toISOString()


export { ensureFolder, readJsonOr, writeJson, listJsonKeys, countJson, cleanFolder, nowIso }
