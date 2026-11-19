//前後對拍工具(未給新選項之4hr, 各階段之行為、回傳、事件與策略檔須逐位不變; 不帶.test.中綴, 不會被mocha抓取)
//  用法:
//    node test/tools/abPipeline.mjs <src資料夾> <標籤> [--small] [--tz <時區>] [--raw] [--only 情境,情境]   以固定亂數種子跑整條管線(多組settings與合成數據), 結果寫入 test/_tmp/abPipeline/<標籤>/
//    node test/tools/abPipeline.mjs --diff <標籤A> <標籤B>          比較兩次結果, 列出不同之項目(全同則離開碼0)
//  情境之族(二擇一):
//    預設(外部數據): 6組settings × 2組合成數據之4hr整條管線; --tz指定cfg.timeZone(預設UTC; 如Asia/Taipei)
//    --raw(幣安來源): 本機假交易所(test/tools/fakeExchange.mjs)只回固定時間以前之根; 既有六鍵(1m、5m、15m、30m、1hr、4hr)各一情境: fetchBinance(raw資料夾之全部csv、回傳)與buildOhlc(K線序列); 其中4hr另跑整條管線之其餘階段並雜湊整個輸出樹,
//      1m～1hr只雜湊raw與ohlc資料夾(其後各階段之輸出樹依設計有新增之標記檔與欄, 不屬4hr之逐位不變範圍); --tz指定cfg.timeZone(預設UTC)
//  做法: 載入src前凍結Date(wsemi之random以載入時刻為種子), 載入後還原; Math.random以固定種子替換; 去重之普測以1個worker跑(其結果依完成次序);
//    各階段(buildOhlc、buildParams、buildCache、sweepSingle、sweepPairs、solve加速核心與完整版)之回傳、事件、status, 及整個工作根之輸出樹(全部檔名之清單與每檔之內容; json經遮蔽時間欄與工作路徑, 其餘檔遮蔽工作路徑)逐項記雜湊;
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
    let tA = Object.values(a).reduce((t, r) => t + (r.nTree || 0), 0)
    let tB = Object.values(b).reduce((t, r) => t + (r.nTree || 0), 0)
    console.log(`情境 ${Object.keys(a).length}/${Object.keys(b).length}、策略檔 ${nA}/${nB}、輸出樹之檔 ${tA}/${tB}、不同之項目 ${diffs.length}`)
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
let useRaw = args.includes('--raw')
let tz = args.includes('--tz') ? args[args.indexOf('--tz') + 1] : 'UTC'
let only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null //只跑指定情境(名稱如default_s100、raw_4hr)
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
let { createFakeExchange } = await imp(path.resolve(FD_TEST, 'tools', 'fakeExchange.mjs'))
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

//RAW_INTERVALS, 既有六鍵(--raw之情境); RAW_NOW為假交易所之「現在」上限(固定, 兩次執行取得同一批根), RAW_DAY_START為抓取起始日(固定; 4hr須有足夠之根跑其後各階段, 故較早)
let RAW_INTERVALS = ['1m', '5m', '15m', '30m', '1hr', '4hr']
let RAW_NOW = Date.UTC(2026, 10, 18, 12, 0, 0) - 1
let RAW_DAY_START = '2026-11-17'
let RAW_DAY_START_4HR = '2026-05-01'

let result = {}
let nextSeed = 20261118

//runChain, 4hr整條管線(buildParams起)之各階段; light為true時略去sweepPairs(假交易所之價格無趨勢, 單因子普測可能無策略可供雙因子)
let runChain = async (pl, put, light = false) => {
    put('buildParams', await pl.buildParams({ only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd', 'index_ohlc_close'] }))
    put('buildCache', await pl.buildCache())
    put('sweepSingle', await pl.sweepSingle({ numTradeFinMin: 3, limit: 8, takeLimit: 1 }))
    if (!light) {
        put('sweepPairs', await pl.sweepPairs({ numTradeFinMin: 3, eqYrMin: -1e9, limit: 6, takeLimit: 1 }))
    }
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
}

//dumpTree, 整個工作根之輸出樹: 檔名清單(新增或消失之檔皆被抓到)與每檔之內容; keep為路徑過濾(相對工作根, 以/分隔)
let dumpTree = (fdRoot, put, keep = () => true) => {
    let rels = []
    let walk = (d) => {
        for (let nm of fs.readdirSync(d).sort()) {
            let p = path.resolve(d, nm)
            if (fs.statSync(p).isDirectory()) {
                walk(p)
            }
            else {
                let rel = path.relative(fdRoot, p).split(path.sep).join('/')
                if (keep(rel)) {
                    rels.push(rel)
                }
            }
        }
    }
    walk(fdRoot)
    put('tree', rels)
    let nFiles = 0
    for (let r of rels) {
        let raw = fs.readFileSync(path.resolve(fdRoot, r), 'utf8')
        let v = raw
        if (r.endsWith('.json')) {
            try {
                v = JSON.parse(raw)
            }
            catch (err) {
                v = raw
            }
        }
        put(`tree_${r.split('/').join('~')}`, v)
        if (/^(strategiesP1|strategiesP2|strategies)\//.test(r)) {
            nFiles++
        }
    }
    return { nFiles, nTree: rels.length }
}

//newPut, 記雜湊並寫傾印檔
let newPut = (name) => {
    let dump = path.resolve(work, 'dump', name)
    fs.mkdirSync(dump, { recursive: true })
    let items = {}
    let put = (label, v) => {
        let t = mask(v)
        fs.writeFileSync(path.resolve(dump, `${label}.txt`), t, 'utf8')
        items[label] = sha(t)
    }
    return { items, put }
}

if (!useRaw) {
    for (let [sn, st] of Object.entries(SETTINGS)) {
        for (let [dn, start] of Object.entries(STARTS)) {
            let name = `${sn}_${dn}`
            if (only && !only.includes(name)) {
                nextSeed++
                continue
            }
            let fd = path.resolve(work, 'run', name)
            fs.mkdirSync(fd, { recursive: true })
            rng = mulberry32(nextSeed)
            let { items, put } = newPut(name)
            let arrP = genArrPrice(n, { start })
            let arrI = genArrIndex(n)
            let cfgIn = { root: path.resolve(fd, 'root'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: tz, timeBegin: arrP[0].time, source: { price: arrP, index: arrI }, train: { timeStart: arrP[0].time, timeEnd: arrP[n - 1].time } }
            if (st) {
                cfgIn.settings = st
            }
            put('normalizeCfg', normalizeCfg(cfgIn))
            let pl = createPipeline(cfgIn)
            put('cfg', pl.cfg)
            put('buildOhlc', await pl.buildOhlc())
            await runChain(pl, put)
            let r = dumpTree(pl.cfg.root, put)
            result[name] = { nFiles: r.nFiles, nTree: r.nTree, items }
            fs.rmSync(fd, { recursive: true, force: true })
            console.log(name, 'files', r.nFiles, 'tree', r.nTree, 'items', Object.keys(items).length)
            nextSeed++
        }
    }
}
else {
    let fx = await createFakeExchange({ nowCap: RAW_NOW })
    try {
        for (let iv of RAW_INTERVALS) {
            let name = `raw_${iv}`
            if (only && !only.includes(name)) {
                nextSeed++
                continue
            }
            let fd = path.resolve(work, 'run', name)
            fs.mkdirSync(fd, { recursive: true })
            rng = mulberry32(nextSeed)
            let { items, put } = newPut(name)
            let cfgIn = { root: path.resolve(fd, 'root'), name: 'TST', symbol: 'TSTUSDT', interval: iv, timeZone: tz, dayStart: iv === '4hr' ? RAW_DAY_START_4HR : RAW_DAY_START }
            put('normalizeCfg', normalizeCfg(cfgIn))
            let pl = createPipeline(cfgIn)
            put('cfg', pl.cfg)
            fx.ex.reqs = []
            put('fetch', await pl.fetchData({ endpointPrice: fx.epOf('price'), endpointIndex: fx.epOf('index') }))
            put('requests', fx.ex.reqs)
            let ro = await pl.buildOhlc()
            if (iv !== '4hr') {
                delete ro.gaps //1m～1hr: 新版依設計於回傳與meta/ohlc.json加gaps欄(不屬逐位不變之範圍), 其餘欄與K線序列須相同
            }
            put('buildOhlc', ro)
            let keep = (rel) => true
            if (iv === '4hr') {
                let ohlc = JSON.parse(fs.readFileSync(path.resolve(pl.cfg.fds.ohlc, `${pl.cfg.keyOhlc}.json`), 'utf8'))
                let tr = { timeStart: ohlc[0].time, timeEnd: ohlc[Math.min(ohlc.length, 600) - 1].time } //訓練期取前600根
                pl = createPipeline({ ...cfgIn, train: tr })
                put('train', tr)
                await runChain(pl, put, true)
            }
            else {
                keep = (rel) => rel.startsWith('raw/') || rel.startsWith('ohlc/') //1m～1hr: 其後各階段之標記檔與欄依設計新增, 只比raw與K線序列
            }
            let r = dumpTree(pl.cfg.root, put, keep)
            result[name] = { nFiles: r.nFiles, nTree: r.nTree, items }
            fs.rmSync(fd, { recursive: true, force: true })
            console.log(name, 'files', r.nFiles, 'tree', r.nTree, 'items', Object.keys(items).length)
            nextSeed++
        }
    }
    finally {
        await fx.close()
    }
}
fs.writeFileSync(path.resolve(work, 'result.json'), JSON.stringify(result, null, 1), 'utf8')
let total = Object.values(result).reduce((t, r) => t + r.nFiles, 0)
console.log('done', tag, 'scenarios', Object.keys(result).length, 'strategyFiles', total)
