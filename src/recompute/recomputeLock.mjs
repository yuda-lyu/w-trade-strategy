import fs from 'fs'
import path from 'path'
import crypto from 'crypto'


/**
 * 策略庫重算之鎖檔名(置於fdReport)
 *
 * @type {String}
 */
let LOCK_NAME = 'recompute.lock'


/**
 * 內容無法讀出之鎖檔於此毫秒數內(依修改時刻)視為使用中, 逾此才視為殘留
 *
 * @type {Number}
 */
let LOCK_FRESH_MS = 60000


//isPidAlive, 行程是否存在(EPERM代表存在而無權限)
let isPidAlive = (pid) => {
    try {
        process.kill(pid, 0)
        return true
    }
    catch (err) {
        return err.code === 'EPERM'
    }
}

//readRaw, 讀鎖檔之原文, 讀不到時為null
let readRaw = (fp) => {
    try {
        return fs.readFileSync(fp, 'utf8')
    }
    catch (err) {
        return null
    }
}

//parseLock, 解析鎖檔之內容{pid,token,...}, 無法解析或缺pid時為null
let parseLock = (raw) => {
    try {
        let j = JSON.parse(raw)
        return j && typeof j === 'object' && Number.isInteger(j.pid) && j.pid > 0 ? j : null
    }
    catch (err) {
        return null
    }
}

//createAtomic, 內容先寫入暫存檔再以linkSync建立鎖檔(已存在即回false), 鎖檔一出現即有完整內容
let createAtomic = (fpLock, content) => {
    let tmp = `${fpLock}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    fs.writeFileSync(tmp, content, 'utf8')
    try {
        fs.linkSync(tmp, fpLock)
        return true
    }
    catch (err) {
        if (err.code === 'EEXIST') {
            return false
        }
        throw err
    }
    finally {
        fs.rmSync(tmp, { force: true })
    }
}

//replaceAtomic, 內容先寫入暫存檔再改名覆蓋既有檔(目標全程存在, 無空窗; 目標被他行程短暫開啟時重試數次); before為測試用之鉤子(暫存檔已寫入、改名之前呼叫)
let replaceAtomic = (fp, content, before) => {
    let tmp = `${fp}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    fs.writeFileSync(tmp, content, 'utf8')
    try {
        if (typeof before === 'function') {
            before()
        }
        for (let k = 0; ; k++) {
            try {
                fs.renameSync(tmp, fp)
                return
            }
            catch (err) {
                if (k >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
                    throw err
                }
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (k + 1))
            }
        }
    }
    finally {
        fs.rmSync(tmp, { force: true })
    }
}

//GUARD_NAME, 接手殘留鎖時之保護檔名(同時接手者以原子建立之保護檔排隊, 只有一個進入; 內部用)
let GUARD_NAME = `${LOCK_NAME}.takeover`

//busyError, 使用中之錯誤(附鎖檔名與處置; 不帶路徑, 路徑由呼叫端之fdReport得知)
let busyError = (pid, why) => {
    let who = pid ? `另一個重算行程(pid ${pid})` : '另一個重算行程'
    return new Error(`fdReport之鎖檔(${LOCK_NAME})正由${who}使用${why ? `(${why})` : ''}; 若確認該PID不是本重算行程(PID被重用)或該鎖檔為當機所遺, 手動刪除該鎖檔後再執行`)
}


/**
 * 取得策略庫重算之鎖(同一fdReport只容一個執行中之重算)
 *
 * 鎖檔內容{pid,token,...info,at}先寫入暫存檔再以fs.linkSync原子建立(已存在即EEXIST), 故鎖檔一出現即有完整內容
 * 已存在時: 內容之pid仍存在即拒(含本行程; PID被重用時亦拒, 訊息附處置); 鎖檔無法讀取、或內容無法讀出且修改時刻在LOCK_FRESH_MS內視為使用中而拒; 其餘視為殘留而接手
 * 接手殘留鎖: 鎖檔全程存在(不先移走再放回, 免空窗使他行程建立另一把鎖而同時有兩個持有者): 先以保護檔(recompute.lock.takeover, 原子建立)使同時接手者只有一個進入, 其餘即拒; 持有保護檔者再讀鎖檔, 內容仍為所判定之殘留鎖才以暫存檔改名覆蓋為新鎖(原子), 不同(他行程已先接手)即拒; 保護檔於結束時(含例外)只釋放自己建立者; 當機於保護檔存在期間而遺留者使其後之接手被拒(偏安全), 訊息附處置
 *
 * @function
 * @param {String} fdReport 輸入鎖檔所在資料夾字串(須已存在)
 * @param {Object} [info={}] 輸入另記於鎖檔之資訊物件(如mode)，預設{}
 * @param {Object} [hooks={}] 輸入測試用之鉤子{beforeTakeover,beforeReplace}(判定為殘留後、取保護檔前呼叫；持有保護檔且核對無誤、暫存檔已寫入而改名覆蓋鎖檔前呼叫；只供測試注入)，預設{}
 * @returns {Object} 回傳鎖物件{fpLock,token,staleLock}，staleLock為是否接手殘留鎖
 * @example
 * need test in nodejs.
 *
 * let lock = acquireRecomputeLock(fdReport, { mode: 'write' })
 * releaseRecomputeLock(lock)
 */
let acquireRecomputeLock = (fdReport, info = {}, hooks = {}) => {
    let fpLock = path.resolve(fdReport, LOCK_NAME)
    let token = crypto.randomBytes(12).toString('hex')
    let content = JSON.stringify({ pid: process.pid, token, ...info, at: new Date().toISOString() })
    if (createAtomic(fpLock, content)) {
        return { fpLock, token, staleLock: false }
    }

    //已存在: 判定使用中或殘留
    let st = null
    try {
        st = fs.statSync(fpLock)
    }
    catch (err) {
        st = null
    }
    if (st === null) {
        //判定之間已被釋放: 再試一次建立
        if (createAtomic(fpLock, content)) {
            return { fpLock, token, staleLock: false }
        }
        throw busyError(null, '建立時他行程已取得')
    }
    let rawOld = readRaw(fpLock)
    let old = rawOld === null ? null : parseLock(rawOld)
    if (old !== null && isPidAlive(old.pid)) {
        throw busyError(old.pid)
    }
    if (rawOld === null) {
        throw busyError(null, '鎖檔無法讀取')
    }
    if (old === null && Date.now() - st.mtimeMs < LOCK_FRESH_MS) {
        throw busyError(null, `內容無法讀出且修改時刻在${LOCK_FRESH_MS / 1000}秒內`)
    }
    if (typeof hooks.beforeTakeover === 'function') {
        hooks.beforeTakeover()
    }

    //接手殘留鎖: 保護檔(原子建立)使同時接手者只有一個進入, 持有者核對鎖檔仍為所判定之殘留鎖後以暫存檔改名覆蓋(鎖檔全程存在)
    let fpGuard = path.resolve(fdReport, GUARD_NAME)
    if (!createAtomic(fpGuard, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }))) {
        throw busyError(null, `他行程正接手殘留鎖檔(保護檔${GUARD_NAME}已存在; 若確認無其他重算行程, 手動刪除該保護檔)`)
    }
    try {
        let rawNow = readRaw(fpLock)
        if (rawNow === null) {
            //判定之後鎖檔已被移除(他行程釋放或手動刪除): 以原子建立為準
            if (createAtomic(fpLock, content)) {
                return { fpLock, token, staleLock: true }
            }
            throw busyError(null, '接手殘留鎖檔時他行程已建立新鎖')
        }
        if (rawNow !== rawOld) {
            let other = parseLock(rawNow)
            throw busyError(other ? other.pid : null, '他行程已先接手殘留鎖檔')
        }
        replaceAtomic(fpLock, content, hooks.beforeReplace)
        return { fpLock, token, staleLock: true }
    }
    finally {
        let g = parseLock(readRaw(fpGuard))
        if (g && g.token === token) {
            fs.rmSync(fpGuard, { force: true })
        }
    }
}


/**
 * 釋放策略庫重算之鎖: 鎖檔之token與本鎖相同時才刪除(不刪他行程之鎖)
 *
 * @function
 * @param {Object} lock 輸入acquireRecomputeLock回傳之鎖物件
 * @returns {Boolean} 回傳是否刪除了鎖檔
 * @example
 * need test in nodejs.
 *
 * releaseRecomputeLock(lock)
 */
let releaseRecomputeLock = (lock) => {
    if (!lock) {
        return false
    }
    let cur = parseLock(readRaw(lock.fpLock))
    if (cur && cur.token === lock.token) {
        fs.rmSync(lock.fpLock, { force: true })
        return true
    }
    return false
}


export { LOCK_NAME, LOCK_FRESH_MS, acquireRecomputeLock, releaseRecomputeLock }
export default acquireRecomputeLock
