import fs from 'fs'
import path from 'path'


//DEPS, 預設之檔案系統操作(測試可逐項替換以驗各判定法之分支)
let DEPS = {
    exists: (p) => fs.existsSync(p),
    realpath: (p) => fs.realpathSync.native(p),
    stat: (p) => fs.statSync(p, { bigint: true }),
    platform: process.platform,
}


/**
 * 資料夾之正規路徑: 取最近之既存上層以fs.realpathSync.native解析(目錄連結、8.3短名、實際大小寫)再接其餘段, win32轉小寫(不分大小寫比較)
 *
 * 實體路徑取不到(realpath拋錯)時throw, 不退回字串比較(無法確認兩夾之關係即不執行)
 *
 * @function
 * @param {String} p 輸入資料夾路徑字串(相對路徑相對於process.cwd())
 * @param {Object} [deps={}] 輸入可替換之操作{exists,realpath,stat,platform}(只供測試注入)，預設{}
 * @returns {String} 回傳正規路徑字串
 * @example
 *
 * console.log(canonOf('./a/../b') === canonOf('./b'))
 * // => true
 *
 */
let canonOf = (p, deps = {}) => {
    let d = { ...DEPS, ...deps }
    let cur = path.resolve(p)
    let rest = []
    while (!d.exists(cur)) {
        let up = path.dirname(cur)
        if (up === cur) {
            break
        }
        rest.unshift(path.basename(cur))
        cur = up
    }
    let real = cur
    if (d.exists(cur)) {
        try {
            real = d.realpath(cur)
        }
        catch (err) {
            throw new Error(`無法取得資料夾之實體路徑(${(err && err.code) || 'unknown'}), 無法確認與原策略庫之關係, 不執行重算`) //只帶錯誤碼(Node原生訊息含路徑)
        }
    }
    let full = path.join(real, ...rest)
    return d.platform === 'win32' ? full.toLowerCase() : full
}


/**
 * 既存資料夾之本體識別(dev + ino)
 *
 * 不存在、無法stat或檔案識別為0(部分網路分享與虛擬磁碟)時回傳null(不以識別比對, 只用正規路徑)
 *
 * @function
 * @param {String} p 輸入路徑字串
 * @param {Object} [deps={}] 輸入可替換之操作(只供測試注入)，預設{}
 * @returns {String|null} 回傳`${dev}:${ino}`或null
 * @example
 *
 * console.log(idOf('./not-exist-folder-x'))
 * // => null
 *
 */
let idOf = (p, deps = {}) => {
    let d = { ...DEPS, ...deps }
    let s = null
    try {
        s = d.stat(p)
    }
    catch (err) {
        return null
    }
    if (!s || s.ino === undefined || s.ino === null || BigInt(s.ino) === 0n) {
        return null
    }
    return `${s.dev}:${s.ino}`
}


//idsUpOf, 自身與各既存上層之本體識別
let idsUpOf = (p, deps) => {
    let out = []
    let cur = path.resolve(p)
    for (;;) {
        let id = idOf(cur, deps)
        if (id) {
            out.push(id)
        }
        let up = path.dirname(cur)
        if (up === cur) {
            break
        }
        cur = up
    }
    return out
}


/**
 * 正規路徑child是否等於或位於parent之內(以路徑分隔為界)
 *
 * @function
 * @param {String} child 輸入正規路徑字串
 * @param {String} parent 輸入正規路徑字串
 * @returns {Boolean} 回傳布林值
 * @example
 *
 * console.log(isWithin('/a/b/c', '/a/b'), isWithin('/a/b_bu', '/a/b'))
 * // => true false
 *
 */
let isWithin = (child, parent) => {
    let rel = path.relative(parent, child)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}


/**
 * 兩資料夾之關係: 以正規路徑(canonOf)與本體識別(idOf, 含各上層)兩法判定, 任一法成立即採
 *
 * @function
 * @param {String} a 輸入資料夾路徑字串
 * @param {String} b 輸入資料夾路徑字串
 * @param {Object} [deps={}] 輸入可替換之操作(只供測試注入)，預設{}
 * @returns {String|null} 回傳'same'(同一夾, 含別名)、'aInB'(a位於b之內)、'bInA'(b位於a之內)或null(無包含關係)
 * @example
 *
 * console.log(relationOf('./x/y', './x'), relationOf('./x', './x_bu'))
 * // => aInB null
 *
 */
let relationOf = (a, b, deps = {}) => {
    let ca = canonOf(a, deps)
    let cb = canonOf(b, deps)
    let ia = idOf(a, deps)
    let ib = idOf(b, deps)
    if (ca === cb || (ia !== null && ia === ib)) {
        return 'same'
    }
    if (isWithin(ca, cb) || (ib !== null && idsUpOf(a, deps).includes(ib))) {
        return 'aInB'
    }
    if (isWithin(cb, ca) || (ia !== null && idsUpOf(b, deps).includes(ia))) {
        return 'bInA'
    }
    return null
}


export { canonOf, idOf, isWithin, relationOf }
export default relationOf
