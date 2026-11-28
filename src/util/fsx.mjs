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


//isEmptyArrayJson, 檔案內容解析後是否為長度0之陣列; 無法讀取(含資料夾)、解析失敗或非陣列者皆為false
//  先讀前64位元組: 「[」之後(略過空白)尚有「]」以外之內容者不可能是空陣列, 即不讀全檔(一般之序列檔數百KB, 於此判定)
let isEmptyArrayJson = (fp) => {
    let head = ''
    try {
        let h = fs.openSync(fp, 'r')
        try {
            let buf = Buffer.alloc(64)
            head = buf.toString('utf8', 0, fs.readSync(h, buf, 0, buf.length, 0))
        }
        finally {
            fs.closeSync(h)
        }
    }
    catch (err) {
        return false
    }
    if (/^\s*\[\s*[^\s\]]/.test(head)) {
        return false
    }
    let v = readJsonOr(fp, null)
    return Array.isArray(v) && v.length === 0
}


/**
 * 刪除資料夾內第1層內容解析後為長度0之陣列之json檔(例如無值之期所成之空序列檔)，其餘檔(非空陣列、非陣列、解析失敗、無法讀取、非json副檔名)與子資料夾一律不動
 *
 * @function
 * @param {String} fd 輸入資料夾路徑字串
 * @returns {Array} 回傳已刪除檔案之主檔名字串陣列(依listJsonKeys之次序)，資料夾不存在時回傳[]
 * @example
 * need test in nodejs.
 *
 * let keys = removeEmptyArrayJsons('./data/param')
 */
let removeEmptyArrayJsons = (fd) => {
    let removed = []
    for (let k of listJsonKeys(fd)) {
        let fp = path.resolve(fd, `${k}.json`)
        if (isEmptyArrayJson(fp)) {
            fs.rmSync(fp)
            removed.push(k)
        }
    }
    return removed
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


export { ensureFolder, readJsonOr, writeJson, listJsonKeys, removeEmptyArrayJsons, countJson, cleanFolder, nowIso }
