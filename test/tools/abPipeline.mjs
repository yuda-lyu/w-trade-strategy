//前後對拍工具(未給settings.unit時各階段之行為、回傳、事件與策略檔須逐位不變; 不帶.test.中綴, 不會被mocha抓取)
//  用法:
//    node test/tools/abPipeline.mjs <src資料夾> <標籤> [--small] [--only 情境,情境]   以固定亂數種子跑整條管線(多組settings與合成數據), 結果寫入 test/_tmp/abPipeline/<標籤>/
//    node test/tools/abPipeline.mjs --diff <標籤A> <標籤B>          比較兩次結果, 列出不同之項目(全同則離開碼0)
//  做法: 載入src前凍結Date(wsemi之random以載入時刻為種子), 載入後還原; Math.random以固定種子替換; 去重之普測以1個worker跑(其結果依完成次序);
//    各階段(buildOhlc、buildParams、buildCache、sweepSingle、sweepPairs、solve加速核心與完整版)之回傳、事件、status與全部策略檔經遮蔽時間欄與工作路徑後逐項記雜湊;
//    先對同一份src連跑兩次(標籤不同)證明本工具可重現, 再與基準版之src(如git archive解出之舊碼, 相依經上層node_modules解析)比較
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath, pathToFileURL } from 'url'


let FD_TEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let FD_AB = path.resolve(FD_TEST, '_tmp', 'abPipeline')

//diffMode, 比較兩次結果
let diffMode = (tagA, tagB) => {
    let a = JSON.parse(fs.readFileSync(path.resolve(FD_AB, tagA, 'result.json'), 'utf8'))
    let b = JSON.parse(fs.readFileSync(path.resolve(FD_AB, tagB, 'result.json'), 'utf8'))
    let diffs = []
    for (let name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        let ia = (a[name] || {}).items || {}
        let ib = (b[name] || {}).items || {}
        for (let label of new Set([...Object.keys(ia), ...Object.keys(ib)])) {
            if (ia[label] !== ib[label]) {
                diffs.push(`${name} ${label}`)
            }
        }
    }
    let nA = Object.values(a).reduce((t, r) => t + r.nFiles, 0)
    let nB = Object.values(b).reduce((t, r) => t + r.nFiles, 0)
    console.log(`情境 ${Object.keys(a).length}/${Object.keys(b).length}、策略檔 ${nA}/${nB}、不同之項目 ${diffs.length}`)
    for (let d of diffs.slice(0, 50)) {
        console.log(d)
    }
    process.exit(diffs.length === 0 && nA === nB ? 0 : 1)
}

let args = process.argv.slice(2)
if (args[0] === '--diff') {
    diffMode(args[1], args[2])
}

let [srcDirIn, tag] = args
let small = args.includes('--small')
let only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null //只跑指定情境(名稱如default_s100)
let srcDir = path.resolve(srcDirIn)
let work = path.resolve(FD_AB, tag)
fs.rmSync(work, { recursive: true, force: true })
fs.mkdirSync(path.resolve(work, 'dump'), { recursive: true })

let mulberry32 = (a) => () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

//Math.random於載入前即以間接函數替換(lodash等於載入時就捕捉Math.random, 載入後才換會漏掉其使用者, 如lodash之sample), 各情境再換其內部之固定種子產生器
let rng = mulberry32(1)
Math.random = () => rng()

//載入階段凍結時間, 其後還原
let RealDate = Date
let FIXED = 1700000000000
class FakeDate extends RealDate {
    constructor(...a) {
        if (a.length === 0) {
            super(FIXED)
        }
        else {
            super(...a)
        }
    }

    static now() {
        return FIXED
    }
}
globalThis.Date = FakeDate
let imp = (p) => import(pathToFileURL(p).href)
let { default: createPipeline } = await imp(path.join(srcDir, 'createPipeline.mjs'))
let { default: normalizeCfg } = await imp(path.join(srcDir, 'cfg.mjs'))
let { genArrPrice, genArrIndex } = await imp(path.resolve(FD_TEST, 'tools', 'synthKit.mjs'))
globalThis.Date = RealDate

let MASK_KEYS = new Set(['elapsedMs', 'timeSolved', 'timeTest', 'msPerFile', 'at'])
let mask = (v) => {
    let text = JSON.stringify(v, (k, x) => (MASK_KEYS.has(k) ? '<t>' : x), 2)
    if (text === undefined) {
        text = 'undefined'
    }
    return text.split(work).join('<W>').split(work.replace(/\\/g, '\\\\')).join('<W>').split(work.replace(/\\/g, '/')).join('<W>')
}
let sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16)

let n = small ? 260 : 420
let quick = { thNumTrade: 1, thRWin: 0, thEqYr: -1e9, thsTp: [3, 5], thsSl: [3, 5], oml: { Np: 6, NContiguous: 3, Ng: 15 } }
let SETTINGS = {
    default: undefined,
    uIni5000: { uIni: 5000 },
    uTrade3: { uIni: 5000, uTrade: 3 },
    rFee: { rFee: 0.001 },
    uIniStr: { uIni: '2000' }, //未給unit時normalizeCfg不轉型(settings原樣, 本庫cfg層語意; 其後之轉型與否由各階段所用之套件決定)
    unitNull: { unit: null },
}
let STARTS = { s100: 100, s2000: 2000 }

let result = {}
let nextSeed = 20261118
for (let [sn, st] of Object.entries(SETTINGS)) {
    for (let [dn, start] of Object.entries(STARTS)) {
        let name = `${sn}_${dn}`
        if (only && !only.includes(name)) {
            nextSeed++
            continue
        }
        let fd = path.resolve(work, 'run', name)
        let dump = path.resolve(work, 'dump', name)
        fs.mkdirSync(fd, { recursive: true })
        fs.mkdirSync(dump, { recursive: true })
        rng = mulberry32(nextSeed)
        let items = {}
        let put = (label, v) => {
            let t = mask(v)
            fs.writeFileSync(path.resolve(dump, `${label}.txt`), t, 'utf8')
            items[label] = sha(t)
        }
        let arrP = genArrPrice(n, { start })
        let arrI = genArrIndex(n)
        let cfgIn = { root: path.resolve(fd, 'root'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: 'UTC', timeBegin: arrP[0].time, source: { price: arrP, index: arrI }, train: { timeStart: arrP[0].time, timeEnd: arrP[n - 1].time } }
        if (st) {
            cfgIn.settings = st
        }
        put('normalizeCfg', normalizeCfg(cfgIn))
        let pl = createPipeline(cfgIn)
        put('cfg', pl.cfg)
        put('buildOhlc', await pl.buildOhlc())
        put('buildParams', await pl.buildParams({ only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd', 'index_ohlc_close'] }))
        put('buildCache', await pl.buildCache())
        put('sweepSingle', await pl.sweepSingle({ numTradeFinMin: 3, limit: 8, takeLimit: 1 }))
        put('sweepPairs', await pl.sweepPairs({ numTradeFinMin: 3, eqYrMin: -1e9, limit: 6, takeLimit: 1 }))
        let rounds = []
        let cands = []
        let stFast = await pl.solve({ ...quick, mode: 'long', maxRounds: 3, onRound: (ev) => rounds.push(ev), onCandidate: (ev) => cands.push(ev) })
        put('solveFast', stFast)
        put('solveFastRounds', rounds)
        put('solveFastCands', cands)
        let rounds2 = []
        let stFull = await pl.solve({ ...quick, mode: 'short', engine: 'full', maxRounds: 1, onRound: (ev) => rounds2.push(ev) })
        put('solveFull', stFull)
        put('solveFullRounds', rounds2)
        put('status', pl.status())
        let nFiles = 0
        for (let k of ['strategiesP1', 'strategiesP2', 'strategies']) {
            let fdS = pl.cfg.fds[k]
            let files = fs.existsSync(fdS) ? fs.readdirSync(fdS).filter((f) => f.endsWith('.json')).sort() : []
            put(`files_${k}`, files)
            for (let f of files) {
                put(`file_${k}_${f}`, JSON.parse(fs.readFileSync(path.resolve(fdS, f), 'utf8')))
                nFiles++
            }
        }
        result[name] = { nFiles, items }
        fs.rmSync(fd, { recursive: true, force: true })
        console.log(name, 'files', nFiles, 'items', Object.keys(items).length)
        nextSeed++
    }
}
fs.writeFileSync(path.resolve(work, 'result.json'), JSON.stringify(result, null, 1), 'utf8')
let total = Object.values(result).reduce((t, r) => t + r.nFiles, 0)
console.log('done', tag, 'scenarios', Object.keys(result).length, 'strategyFiles', total)
