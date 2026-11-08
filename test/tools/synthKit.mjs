import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'


//合成K線與設定之共用測試件(各unit-*.test.mjs引用;隨npm包發布, 下游亦可取用)
//  本檔不帶.test.中綴, 不會被mocha當測試檔抓取


//FD_TEST, 測試資料夾(本檔所在之上層);FD_PACK, 套件根(以本檔位置推導, 不用cwd)
let FD_TEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let FD_PACK = path.resolve(FD_TEST, '..')


//buildFdTmp, 暫存根資料夾test/_tmp/<name>_<pid>_<rand>(gitignore;各測試after自刪), 建立前先清同名殘留
let buildFdTmp = (name) => {
    let fd = path.resolve(FD_TEST, '_tmp', `${name}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`)
    fs.rmSync(fd, { recursive: true, force: true })
    fs.mkdirSync(fd, { recursive: true })
    return fd
}


//tBase, tStep: 基準起始時間2023-01-01T00:00:00(以timeZone='UTC'解讀), 每根K線間隔4小時
let tBase = Date.UTC(2023, 0, 1)
let tStep = 4 * 3600 * 1000


//genTimes, 產生n根K線之時間字串序列'YYYY-MM-DDTHH:mm:ss'(opt.stepMs可改間隔)
let genTimes = (n, opt = {}) => {
    let base = opt.base !== undefined ? opt.base : tBase
    let step = opt.stepMs !== undefined ? opt.stepMs : tStep
    let ts = []
    for (let i = 0; i < n; i++) {
        ts.push(new Date(base + i * step).toISOString().slice(0, 19))
    }
    return ts
}


//genArrPrice, 以sin/cos合成之確定性價格K線(含成交量欄位, 與幣安現貨欄位同名)
let genArrPrice = (n, opt = {}) => {
    let ts = genTimes(n, opt)
    let c = opt.start !== undefined ? opt.start : 100
    let arr = []
    for (let i = 0; i < n; i++) {
        let o = c
        c = Math.max(1, c + Math.sin(i * 0.31) * 2 + Math.cos(i * 0.11) * 1.5 + Math.sin(i * 0.017) * 0.8)
        let vol = 1000 + Math.abs(Math.sin(i * 0.23)) * 500
        let buy = vol * (0.4 + 0.2 * Math.abs(Math.cos(i * 0.19)))
        arr.push({
            time: ts[i],
            Open: o,
            High: Math.max(o, c) + 1,
            Low: Math.min(o, c) - 1,
            Close: c,
            Volumn: vol,
            CloseTime: ts[i],
            QuoteAssetVolume: vol * c,
            NumberOfTrades: Math.round(50 + Math.abs(Math.sin(i * 0.41)) * 30),
            TakerBuyBaseAssetVolume: buy,
            TakerBuyQuoteAssetVolume: buy * c,
        })
    }
    return arr
}


//genArrIndex, 合成之溢價指數K線(量級約±0.001, 與幣安premium index相近)
let genArrIndex = (n, opt = {}) => {
    let ts = genTimes(n, opt)
    let arr = []
    let c = 0
    for (let i = 0; i < n; i++) {
        let o = c
        c = Math.sin(i * 0.27) * 0.0006 + Math.cos(i * 0.09) * 0.0004
        arr.push({
            time: ts[i],
            Open: o,
            High: Math.max(o, c) + 0.0001,
            Low: Math.min(o, c) - 0.0001,
            Close: c,
        })
    }
    return arr
}


//cfgOf, 以外部合成數據建立設定(timeZone用UTC使合成時間字串與isBarComplete判斷一致);ov可覆寫任一鍵(含interval與stepMs)
let cfgOf = (fdTmp, n, ov = {}) => {
    let stepMs = ov.stepMs !== undefined ? ov.stepMs : tStep
    let arrP = genArrPrice(n, { stepMs })
    let arrI = genArrIndex(n, { stepMs })
    let { stepMs: _s, ...rest } = ov
    let cfg = {
        root: path.resolve(fdTmp, 'root'),
        name: 'TST',
        symbol: 'TSTUSDT',
        interval: '4hr',
        timeZone: 'UTC',
        timeBegin: arrP[0].time,
        source: { price: arrP, index: arrI },
        train: { timeStart: arrP[0].time, timeEnd: arrP[n - 1].time },
        ...rest,
    }
    return { cfg, arrP, arrI }
}


export {
    FD_TEST,
    FD_PACK,
    buildFdTmp,
    tBase,
    tStep,
    genTimes,
    genArrPrice,
    genArrIndex,
    cfgOf
}
