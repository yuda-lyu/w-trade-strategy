import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { Worker } from 'worker_threads'
import createPipeline from '../src/createPipeline.mjs'
import normalizeCfg from '../src/cfg.mjs'
import { BASIS_FILE, BASIS_GUARD, fpBasisOf, basisOf, readBasis, checkBasis, basisPendingOf, commitBasis } from '../src/util/basis.mjs'
import { buildFdTmp, cfgOf } from './tools/synthKit.mjs'


//規格來源: 規則帳本TS-22與README之〈2. 設定〉 —— 舊語意之工作根誤用新版之防呆
//  標記須涵蓋會使同名檔不同義之全部口徑: 因子語意(根數為本)、intervalSec、timeBasis、非4hr時之時區UTC偏移、合併之基底與dayStart、求解之thsCond與levelNumTradeBounds; 同一工作根口徑不一即拋(檢測先於副作用)
//  4hr且未給任何新選項時不增任何欄位或檔案(無meta/basis.json), 但標記存在時照常讀取比對; 標記無法解析即拋(任何階段)
//  無標記而為非預設口徑者: 該口徑所綁之既有產物須為空, 否則拋(例如以依時間換算根數之舊版建立之日線工作根)
//  寫入一律重讀 → 比對 → 寫入; 求解於首個策略存檔之前寫入(中止後同設定再跑不被拒; 兩個求解器交錯時後到者於存檔前即拋)


let fdTmp = buildFdTmp('basis')
let DAY = 86400 * 1000
let quick = { thNumTrade: 1, thRWin: 0, thEqYr: -1e9, thsTp: [3, 5], thsSl: [3, 5], oml: { Np: 6, NContiguous: 3, Ng: 15 } }
let untilOne = { maxStrategies: 1, maxRounds: 30 } //求解至策略庫至少1隻(單輪可能0隻)
let only = ['price_ohlc_close', 'price_ohlc_rsi', 'index_ohlc_close']
let MSG_UNREADABLE = 'invalid cfg.root: must have a readable basis record in meta/basis.json; use a new work root'
let MSG_BUSY = 'invalid cfg.root: must not have meta/basis.json.lock held by another process; retry later'
let msgSolve = (k) => `invalid opt.${k}: must match the basis recorded in the work root (meta/basis.json); with an empty strategy library, set solve to null in meta/basis.json, or use a new work root`

let readMk = (pl) => JSON.parse(fs.readFileSync(fpBasisOf(pl.cfg), 'utf8'))
let hasMk = (pl) => fs.existsSync(fpBasisOf(pl.cfg))
let listJson = (fd) => (fs.existsSync(fd) ? fs.readdirSync(fd).filter((f) => f.endsWith('.json')).sort() : [])
let nJson = (fd) => listJson(fd).length
let snap = (fd) => (fs.existsSync(fd) ? fs.readdirSync(fd).sort().map((f) => `${f}:${fs.statSync(path.resolve(fd, f)).size}`).join('|') : '')
let mkDay = (solve = null) => ({ periodBasis: 'bars', intervalSec: 86400, timeBasis: null, utcOffsets: [0], aggregateBase: null, dayStart: null, solve })

//cfgDayOf, 日線之設定(外部數據, 不建任何產物; 供commitBasis之單元)
let cfgDayOf = (name) => normalizeCfg({ root: path.resolve(fdTmp, name), name: 'T', symbol: 'T', interval: '1day', source: { price: [] }, timeZone: 'UTC', timeBegin: '2023-01-01T00:00:00' })

//holder, 另一執行緒持有互斥檔(呼叫前由本執行緒建立): delayMs後(給fp與marker時先寫入該標記)移除互斥檔; touchMs大於0時持有期間每touchMs更新其修改時刻; 回傳{exited}(執行緒結束之Promise)
let holder = async ({ fg, fp = null, marker = null, delayMs, touchMs = 0 }) => {
    let code = [
        'const fs = require(\'fs\')',
        'const { workerData: w } = require(\'worker_threads\')',
        'let iv = w.touchMs > 0 ? setInterval(() => { let d = new Date(); try { fs.utimesSync(w.fg, d, d) } catch (e) {} }, w.touchMs) : null',
        'setTimeout(() => {',
        '    if (iv) clearInterval(iv)',
        '    if (w.fp && w.marker) fs.writeFileSync(w.fp, JSON.stringify(w.marker))',
        '    fs.rmSync(w.fg, { force: true })',
        '}, w.delayMs)',
    ].join('\n')
    let wk = new Worker(code, { eval: true, workerData: { fg, fp, marker, delayMs, touchMs } })
    await new Promise((resolve) => wk.once('online', resolve))
    return { exited: new Promise((resolve) => wk.once('exit', resolve)) }
}

//withGuardScale, 暫改互斥檔之時限(用畢還原)
let withGuardScale = async (scale, fn) => {
    let saved = { ...BASIS_GUARD }
    Object.assign(BASIS_GUARD, scale)
    try {
        return await fn()
    }
    finally {
        Object.assign(BASIS_GUARD, saved)
    }
}

let mkPl = (name, ov = {}) => {
    let day = ov.interval === '1day' || ov.interval === undefined
    let { cfg } = cfgOf(fdTmp, 400, { root: path.resolve(fdTmp, name), interval: '1day', stepMs: DAY, ...(day ? {} : { stepMs: 4 * 3600 * 1000 }), ...ov })
    return createPipeline(cfg)
}


describe('basis(工作根之口徑標記)', function() {

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('4hr且未給新選項: 整條管線(buildOhlc、buildParams、buildCache、sweepSingle、sweepPairs、solve)不建立meta/basis.json與其互斥檔', async function() {
        this.timeout(120000)
        let pl = mkPl('h4', { interval: '4hr' })
        await pl.buildOhlc()
        await pl.buildParams({ only })
        await pl.buildCache({ tps: [3, 5] })
        await pl.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1 })
        await pl.sweepPairs({ numTradeFinMin: 3, eqYrMin: -1e9, limit: 3, takeLimit: 1 })
        await pl.solve({ ...quick, mode: 'long', ...untilOne })
        assert.ok(nJson(pl.cfg.fds.strategies) > 0)
        assert.strictEqual(hasMk(pl), false)
        assert.deepStrictEqual(fs.readdirSync(pl.cfg.fds.meta).sort(), ['cache.json', 'ohlc.json', 'params.json'])
    })

    it('日線之新工作根: buildParams寫標記(含utcOffsets、aggregateBase、dayStart); 首次求解於首個策略存檔之前補記solve; 其後同口徑之各階段照常', async function() {
        this.timeout(120000)
        let pl = mkPl('d1')
        await pl.buildOhlc()
        assert.strictEqual(hasMk(pl), false) //buildOhlc只比對不寫
        await pl.buildParams({ only })
        assert.deepStrictEqual(readMk(pl), mkDay())
        await pl.buildCache({ tps: [3, 5] })
        await pl.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1 })
        await pl.solve({ ...quick, mode: 'long', ...untilOne })
        assert.deepStrictEqual(readMk(pl), mkDay({ thsCond: null, levelNumTradeBounds: null }))
        await pl.buildOhlc() //再次同口徑
        await pl.buildParams({ only })
        await pl.solve({ ...quick, mode: 'short', maxRounds: 1 })
        assert.strictEqual(path.basename(fpBasisOf(pl.cfg)), BASIS_FILE)
        assert.ok(!fs.existsSync(`${fpBasisOf(pl.cfg)}.lock`))
    })

    it('同一工作根口徑不一即throw(先於任何寫檔): 求解選項、timeBasis(含sweepPairs)、每根秒數、時區不同(訊息固定, 不含輸入值); 策略庫、因子夾、普測輸出與K線檔不變', async function() {
        this.timeout(120000)
        let pl = mkPl('d1')
        let lib0 = snap(pl.cfg.fds.strategies)
        let par0 = snap(pl.cfg.fds.param)
        let p20 = snap(pl.cfg.fds.strategiesP2)
        let fpOhlc = path.resolve(pl.cfg.fds.ohlc, `${pl.cfg.keyOhlc}.json`)
        let ohlc0 = fs.readFileSync(fpOhlc, 'utf8')
        assert.throws(() => pl.createSolver({ ...quick, thsCond: [-1, 1] }), (e) => e.message === msgSolve('thsCond'))
        assert.throws(() => pl.createSolver({ ...quick, levelNumTradeBounds: [1, 5] }), (e) => e.message === msgSolve('levelNumTradeBounds'))
        let plSpan = createPipeline(normalizeCfg({ ...pl.cfg, timeBasis: 'span' }))
        let mSpan = 'invalid cfg.timeBasis: must match the basis recorded in the work root (meta/basis.json)'
        await assert.rejects(plSpan.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1 }), (e) => e.message === mSpan)
        await assert.rejects(plSpan.sweepPairs({ numTradeFinMin: 3, eqYrMin: -1e9, limit: 3, takeLimit: 1 }), (e) => e.message === mSpan)
        assert.throws(() => plSpan.createSolver({ ...quick }), (e) => e.message === mSpan)
        let pl12 = createPipeline(normalizeCfg({ ...pl.cfg, interval: '12hr', intervalSec: null, keyOhlc: undefined, keyIndex: undefined }))
        await assert.rejects(pl12.buildParams({ only }), (e) => e.message === 'invalid cfg.intervalSec: must match the basis recorded in the work root (meta/basis.json)')
        let plTz = createPipeline(normalizeCfg({ ...pl.cfg, timeZone: 'Asia/Tokyo' }))
        let mTz = 'invalid cfg.timeZone: must match the basis recorded in the work root (meta/basis.json)'
        await assert.rejects(plTz.buildOhlc(), (e) => e.message === mTz) //K線檔於寫出前即擋
        await assert.rejects(plTz.buildParams({ only }), (e) => e.message === mTz)
        assert.strictEqual(snap(pl.cfg.fds.strategies), lib0)
        assert.strictEqual(snap(pl.cfg.fds.param), par0)
        assert.strictEqual(snap(pl.cfg.fds.strategiesP2), p20)
        assert.strictEqual(fs.readFileSync(fpOhlc, 'utf8'), ohlc0)
    })

    it('無標記之舊語意工作根(非4hr、已有meta/params.json或因子序列): buildParams、sweepSingle、solve皆throw且不寫標記、不動既有檔', async function() {
        this.timeout(120000)
        let pl = mkPl('old')
        await pl.buildOhlc()
        //模擬舊版所建: 有meta/params.json與因子序列檔, 無meta/basis.json
        fs.mkdirSync(pl.cfg.fds.param, { recursive: true })
        fs.writeFileSync(path.resolve(pl.cfg.fds.param, 'price_ohlc_Close_param_maNorm_30day.json'), '[]', 'utf8')
        fs.writeFileSync(path.resolve(pl.cfg.fds.meta, 'params.json'), JSON.stringify({ nm: {}, optMethod: {}, interval: '1day' }), 'utf8')
        let par0 = snap(pl.cfg.fds.param)
        let meta0 = fs.readFileSync(path.resolve(pl.cfg.fds.meta, 'params.json'), 'utf8')
        //buildOhlc亦於寫任何K線檔之前即拒(檢測先於副作用): K線檔與meta/ohlc.json逐檔不變
        let ohlc0 = snap(pl.cfg.fds.ohlc)
        let fpMetaOhlc = path.resolve(pl.cfg.fds.meta, 'ohlc.json')
        let metaOhlc0 = fs.readFileSync(fpMetaOhlc, 'utf8')
        let ohlcBytes0 = fs.readdirSync(pl.cfg.fds.ohlc).map((f) => fs.readFileSync(path.resolve(pl.cfg.fds.ohlc, f), 'utf8'))
        await assert.rejects(pl.buildOhlc(), (e) => e.message === 'invalid cfg.root: must not contain param built without a recorded basis (meta/basis.json); use a new work root')
        assert.strictEqual(snap(pl.cfg.fds.ohlc), ohlc0)
        assert.deepStrictEqual(fs.readdirSync(pl.cfg.fds.ohlc).map((f) => fs.readFileSync(path.resolve(pl.cfg.fds.ohlc, f), 'utf8')), ohlcBytes0)
        assert.strictEqual(fs.readFileSync(fpMetaOhlc, 'utf8'), metaOhlc0)
        await assert.rejects(pl.buildParams({ only }), (e) => e.message === 'invalid cfg.root: must not contain param built without a recorded basis (meta/basis.json); use a new work root')
        fs.rmSync(path.resolve(pl.cfg.fds.param, 'price_ohlc_Close_param_maNorm_30day.json'))
        await assert.rejects(pl.buildParams({ only }), (e) => e.message === 'invalid cfg.root: must not contain meta/params.json built without a recorded basis (meta/basis.json); use a new work root')
        fs.writeFileSync(path.resolve(pl.cfg.fds.param, 'price_ohlc_Close_param_maNorm_30day.json'), '[]', 'utf8')
        assert.throws(() => pl.createSolver({ ...quick }), /invalid cfg\.root: must not contain param built without a recorded basis/)
        assert.strictEqual(hasMk(pl), false)
        assert.strictEqual(snap(pl.cfg.fds.param), par0)
        assert.strictEqual(fs.readFileSync(path.resolve(pl.cfg.fds.meta, 'params.json'), 'utf8'), meta0)
    })

    it('4hr之既有工作根改給新選項: 策略庫已有策略時加timeBasis或求解選項即throw; 策略庫為空時求解選項於首個策略存檔之前記入標記(其餘口徑為預設)', async function() {
        this.timeout(120000)
        let pl = createPipeline(normalizeCfg(cfgOf(fdTmp, 400, { root: path.resolve(fdTmp, 'h4') }).cfg)) //第1案之4hr工作根(已有策略庫)
        assert.ok(nJson(pl.cfg.fds.strategies) > 0)
        assert.throws(() => pl.createSolver({ ...quick, levelNumTradeBounds: [1, 3] }), /invalid cfg\.root: must not contain the strategy library built without a recorded basis/)
        let plSpan = createPipeline(normalizeCfg({ ...pl.cfg, timeBasis: 'span' }))
        await assert.rejects(plSpan.buildParams({ only }), /invalid cfg\.root: must not contain strategiesP1 built without a recorded basis/)
        assert.strictEqual(hasMk(pl), false)
        //策略庫另指空夾(fdStrategies)時: 求解選項可記入, 寫入於首個策略存檔之前
        let fdLib = path.resolve(fdTmp, 'h4', 'libB')
        let fdL = path.resolve(fdTmp, 'h4', 'libC')
        let pl2 = createPipeline(normalizeCfg({ ...pl.cfg, fds: { strategies: fdLib, strategiesP1: path.resolve(fdTmp, 'h4', 'p1x'), strategiesP2: path.resolve(fdTmp, 'h4', 'p2x') } }))
        let sv = pl2.createSolver({ ...quick, mode: 'long', ...untilOne, levelNumTradeBounds: [1, 3], fdStrategies: fdL })
        assert.strictEqual(hasMk(pl2), false) //建立求解器時不寫
        await sv.start()
        assert.ok(nJson(fdL) > 0)
        assert.deepStrictEqual(readMk(pl2), { periodBasis: 'bars', intervalSec: 14400, timeBasis: null, solve: { thsCond: null, levelNumTradeBounds: [1, 3] } })
        fs.rmSync(fpBasisOf(pl2.cfg))
    })

    it('標記已有而尚未記求解選項(首次求解前)時, 指向已有策略之策略庫(口徑不明)即throw, 且不補記標記', async function() {
        this.timeout(120000)
        let pl = mkPl('d3')
        await pl.buildOhlc()
        await pl.buildParams({ only })
        assert.strictEqual(readMk(pl).solve, null)
        let fdOther = path.resolve(fdTmp, 'd3', 'otherLib')
        fs.mkdirSync(fdOther, { recursive: true })
        fs.writeFileSync(path.resolve(fdOther, 'long_1_0123456789abcdef.json'), '{}', 'utf8')
        assert.throws(() => pl.createSolver({ ...quick, fdStrategies: fdOther }), (e) => e.message === 'invalid cfg.root: must not contain the strategy library built without a recorded basis (meta/basis.json); use a new work root')
        assert.strictEqual(readMk(pl).solve, null)
        assert.strictEqual(nJson(fdOther), 1)
    })

    it('求解選項無效(由w-trade-solve拋錯)時不留標記: 新日線工作根之首次求解以無效thsCond失敗後, solve仍為null, 改給有效值可照常求解', async function() {
        this.timeout(120000)
        let pl = mkPl('d2')
        await pl.buildOhlc()
        await pl.buildParams({ only })
        await assert.rejects(pl.solve({ ...quick, mode: 'long', maxRounds: 1, thsCond: [1, -1] }), /invalid opt\.thsCond/)
        assert.deepStrictEqual(readMk(pl), mkDay())
        assert.strictEqual(nJson(pl.cfg.fds.strategies), 0)
        await pl.solve({ ...quick, mode: 'long', ...untilOne, thsCond: [-1, 1] })
        assert.deepStrictEqual(readMk(pl).solve, { thsCond: [-1, 1], levelNumTradeBounds: null })
    })

    it('首輪中途中止(已存策略)後, 同一版、同一設定再建求解器不被拒且可續跑; 標記於首個策略存檔之前即已記solve', async function() {
        this.timeout(300000)
        let want = { thsCond: null, levelNumTradeBounds: [1, 2, 4] }
        let opt = { ...quick, mode: 'long', maxRounds: 30, levelNumTradeBounds: [1, 2, 4] }
        //情境之前提: 首輪之內即有第2個候選(中止時首輪尚未完成、庫已有1隻)。各輪之候選數依隨機搜尋而定(本程序之亂數來源不固定),
        //  故以有上限之新工作根迴圈取得一次合於前提者; 取不到即以明確訊息失敗。斷言不因此放寬: 每個候選之回呼內當場記下輪數、標記之solve與庫之檔數
        let MAX_TRY = 8
        let got = null
        let tries = []
        for (let k = 0; k < MAX_TRY && got === null; k++) {
            let pl = mkPl(`d4_${k}`)
            await pl.buildOhlc()
            await pl.buildParams({ only })
            let nRound = 0
            let seen = []
            let sv = pl.createSolver({
                ...opt,
                onRound: () => {
                    nRound++
                },
                onCandidate: () => {
                    seen.push({ nRound, solve: hasMk(pl) ? readMk(pl).solve : null, nLib: nJson(pl.cfg.fds.strategies) })
                    if (seen.length >= 2) {
                        throw new Error('simulated abort') //第2個候選存檔前中止(第1個已存)
                    }
                },
            })
            let end = await sv.start().then(() => 'done', (err) => err)
            tries.push(seen.map((v) => v.nRound).join('/') || 'none')
            if (end === 'done') {
                continue //30輪內不足2個候選: 換新工作根
            }
            assert.ok(/simulated abort/.test(String(end && end.message)), String(end && end.message))
            if (seen[1].nRound === 0) {
                got = { pl, seen }
            }
        }
        assert.ok(got !== null, `precondition not met in ${MAX_TRY} fresh work roots (rounds of the first two candidates: ${tries.join(', ')})`)
        let { pl, seen } = got
        //第1個候選之回呼時(首輪之內、首個策略存檔之前)標記即已記solve; 第2個時庫已有1隻
        assert.deepStrictEqual(seen[0], { nRound: 0, solve: want, nLib: 0 })
        assert.deepStrictEqual(seen[1], { nRound: 0, solve: want, nLib: 1 })
        assert.strictEqual(nJson(pl.cfg.fds.strategies), 1)
        assert.deepStrictEqual(readMk(pl).solve, want)
        let sv2 = pl.createSolver({ ...opt, maxRounds: 1 }) //同設定再建: 不被拒
        await sv2.start()
        assert.ok(nJson(pl.cfg.fds.strategies) >= 1)
    })

    it('兩個求解器交錯(皆於他者寫入標記前建立): 先存檔者記入標記, 後到者於存檔前即throw, 策略庫只有一種口徑', async function() {
        this.timeout(120000)
        let pl = mkPl('d5')
        await pl.buildOhlc()
        await pl.buildParams({ only })
        let svA = pl.createSolver({ ...quick, mode: 'long', ...untilOne, thsCond: [-1, 1] })
        let svB = pl.createSolver({ ...quick, mode: 'long', ...untilOne, thsCond: [-1, 0, 1] })
        await svA.start()
        let libA = listJson(pl.cfg.fds.strategies)
        assert.ok(libA.length > 0)
        await assert.rejects(svB.start(), (e) => e.message === msgSolve('thsCond'))
        assert.deepStrictEqual(listJson(pl.cfg.fds.strategies), libA)
        assert.deepStrictEqual(readMk(pl).solve, { thsCond: [-1, 1], levelNumTradeBounds: null })
        for (let f of libA) {
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.resolve(pl.cfg.fds.strategies, f), 'utf8')).solve.thsCond, [-1, 1])
        }
    })

    it('標記檔存在而無法解析即throw(任何階段, 含4hr預設口徑; 訊息指出meta/basis.json): 不覆寫任何產物', async function() {
        this.timeout(120000)
        //日線工作根: 標記被截斷
        let pl = mkPl('d1')
        let fp = fpBasisOf(pl.cfg)
        let raw0 = fs.readFileSync(fp, 'utf8')
        fs.writeFileSync(fp, raw0.slice(0, 20), 'utf8')
        let par0 = snap(pl.cfg.fds.param)
        await assert.rejects(pl.buildOhlc(), (e) => e.message === MSG_UNREADABLE)
        await assert.rejects(pl.buildParams({ only }), (e) => e.message === MSG_UNREADABLE)
        assert.throws(() => pl.createSolver({ ...quick }), (e) => e.message === MSG_UNREADABLE)
        assert.strictEqual(snap(pl.cfg.fds.param), par0)
        fs.writeFileSync(fp, raw0, 'utf8')
        //4hr預設口徑之工作根: 標記(他口徑所寫)損毀後, 預設口徑之階段亦拋, 不覆寫普測產物
        let plH = mkPl('h4c', { interval: '4hr' })
        await plH.buildOhlc()
        await plH.buildParams({ only })
        await plH.buildCache({ tps: [3, 5] })
        await plH.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1 })
        let p10 = snap(plH.cfg.fds.strategiesP1)
        assert.ok(p10.length > 0)
        for (let bad of ['{"periodBasis":"bars","intervalSec":144', '[1,2]', 'null']) {
            fs.writeFileSync(fpBasisOf(plH.cfg), bad, 'utf8')
            await assert.rejects(plH.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1, cleanFdOut: false }), (e) => e.message === MSG_UNREADABLE)
            await assert.rejects(plH.sweepPairs({ numTradeFinMin: 3, eqYrMin: -1e9, limit: 3, takeLimit: 1 }), (e) => e.message === MSG_UNREADABLE)
            await assert.rejects(plH.buildOhlc(), (e) => e.message === MSG_UNREADABLE)
            assert.throws(() => plH.createSolver({ ...quick }), (e) => e.message === MSG_UNREADABLE)
            assert.strictEqual(snap(plH.cfg.fds.strategiesP1), p10)
        }
        fs.rmSync(fpBasisOf(plH.cfg))
    })

    it('標記之periodBasis不為bars(不支援之因子語意)即throw(各階段)', async function() {
        this.timeout(120000)
        let pl = mkPl('d6')
        await pl.buildOhlc()
        await pl.buildParams({ only })
        let mk = readMk(pl)
        fs.writeFileSync(fpBasisOf(pl.cfg), JSON.stringify({ ...mk, periodBasis: 'time' }), 'utf8')
        let m = 'invalid cfg.root: must have a supported period basis in meta/basis.json; use a new work root'
        await assert.rejects(pl.buildOhlc(), (e) => e.message === m)
        await assert.rejects(pl.buildParams({ only }), (e) => e.message === m)
        assert.throws(() => pl.createSolver({ ...quick }), (e) => e.message === m)
        let noPb = { ...mk }
        delete noPb.periodBasis
        fs.writeFileSync(fpBasisOf(pl.cfg), JSON.stringify(noPb), 'utf8')
        await assert.rejects(pl.buildParams({ only }), (e) => e.message === m)
    })

    it('普測即將清空之輸出夾不擋: 只有單因子普測產物之4hr工作根改給timeBasis後重跑sweepSingle(預設清空輸出夾)可照常, 並記入標記; 不清空(cleanFdOut false)即throw', async function() {
        this.timeout(120000)
        let pl = mkPl('h4b', { interval: '4hr' })
        await pl.buildOhlc()
        await pl.buildParams({ only })
        await pl.buildCache({ tps: [3, 5] })
        await pl.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1 })
        assert.ok(nJson(pl.cfg.fds.strategiesP1) > 0)
        assert.strictEqual(hasMk(pl), false)
        let plSpan = createPipeline(normalizeCfg({ ...pl.cfg, timeBasis: 'span' }))
        await assert.rejects(plSpan.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1, cleanFdOut: false }), /invalid cfg\.root: must not contain strategiesP1 built without a recorded basis/)
        assert.strictEqual(hasMk(pl), false)
        await plSpan.sweepSingle({ numTradeFinMin: 3, limit: 4, takeLimit: 1 })
        assert.deepStrictEqual(readMk(pl), { periodBasis: 'bars', intervalSec: 14400, timeBasis: 'span', solve: null })
        let files = fs.readdirSync(pl.cfg.fds.strategiesP1).filter((f) => f.endsWith('.json'))
        assert.ok(files.length > 0)
        for (let f of files) {
            assert.strictEqual(JSON.parse(fs.readFileSync(path.resolve(pl.cfg.fds.strategiesP1, f), 'utf8')).settings.timeBasis, 'span')
        }
    })

    it('checkBasis之判定(單元): 預設口徑回null; 本階段即將清空之夾不擋; basisOf之數字字串轉為數值; 幣安來源之日線另記合併之基底與dayStart, 不同即throw', function() {
        let root = path.resolve(fdTmp, 'unit')
        let cfg4 = normalizeCfg({ root, name: 'T', symbol: 'T', interval: '4hr' })
        let cfgD = normalizeCfg({ root, name: 'T', symbol: 'T', interval: '1day', timeZone: 'Asia/Taipei', dayStart: '2021-03-04' })
        assert.strictEqual(checkBasis(cfg4, 'params'), null)
        assert.strictEqual(checkBasis(cfg4, 'solve', { optSolve: {} }), null)
        assert.strictEqual(checkBasis(cfg4, 'ohlc'), null)
        assert.strictEqual(basisPendingOf(cfg4, {}), null)
        let want = { periodBasis: 'bars', intervalSec: 86400, timeBasis: null, utcOffsets: [480], aggregateBase: '8hr', dayStart: '2021-03-04', solve: null }
        assert.deepStrictEqual(checkBasis(cfgD, 'params'), want)
        assert.strictEqual(checkBasis(cfgD, 'ohlc'), null) //buildOhlc只比對不寫
        fs.mkdirSync(cfgD.fds.strategiesP1, { recursive: true })
        fs.writeFileSync(path.resolve(cfgD.fds.strategiesP1, 'x.json'), '{}', 'utf8')
        assert.throws(() => checkBasis(cfgD, 'params'), /must not contain strategiesP1/)
        assert.deepStrictEqual(checkBasis(cfgD, 'sweepSingle', { fdTar: cfgD.fds.strategiesP1, fdsCleared: [cfgD.fds.strategiesP1] }).intervalSec, 86400)
        assert.deepStrictEqual(basisOf(cfgD, { thsCond: ['-1', '1.5'], levelNumTradeBounds: ['2', 5] }).solve, { thsCond: [-1, 1.5], levelNumTradeBounds: [2, 5] })
        assert.strictEqual(basisOf(cfg4).solve, undefined)
        assert.strictEqual(basisOf(cfg4).utcOffsets, undefined) //4hr(直接下載)不記數據口徑
        //合併之基底與dayStart: 標記寫入後改之即throw
        commitBasis(cfgD, want)
        assert.deepStrictEqual(readBasis(cfgD), want)
        assert.throws(() => checkBasis(normalizeCfg({ ...cfgD, dayStart: '2021-03-05', timeBegin: undefined }), 'ohlc'), (e) => e.message === 'invalid cfg.dayStart: must match the basis recorded in the work root (meta/basis.json)')
        assert.throws(() => checkBasis(normalizeCfg({ ...cfgD, aggregateFrom: '4hr' }), 'params'), (e) => e.message === 'invalid cfg.aggregateFrom: must match the basis recorded in the work root (meta/basis.json)')
        assert.throws(() => checkBasis(normalizeCfg({ ...cfgD, timeZone: 'Etc/GMT-9' }), 'params'), (e) => e.message === 'invalid cfg.timeZone: must match the basis recorded in the work root (meta/basis.json)')
        assert.strictEqual(checkBasis(normalizeCfg({ ...cfgD, timeZone: 'Etc/GMT-8' }), 'params'), null) //同一偏移之別名: 口徑相同
        fs.rmSync(fpBasisOf(cfgD))
        //4hr而明給aggregateFrom且由下載套件合併者(東京): 非預設口徑, 另記數據口徑; 4hr直接下載者(明給none)為預設
        let cfg4a = normalizeCfg({ root: path.resolve(fdTmp, 'unit4a'), name: 'T', symbol: 'T', interval: '4hr', timeZone: 'Asia/Tokyo', aggregateFrom: 'auto', dayStart: '2021-03-04' })
        assert.deepStrictEqual(checkBasis(cfg4a, 'params'), { periodBasis: 'bars', intervalSec: 14400, timeBasis: null, utcOffsets: [540], aggregateBase: '1hr', dayStart: '2021-03-04', solve: null })
        assert.strictEqual(checkBasis(normalizeCfg({ ...cfg4a, aggregateFrom: 'none' }), 'params'), null)
    })

    it('commitBasis(重讀 → 比對 → 寫入): 無標記即寫入; 同口徑不寫; 不同即throw且不改檔; 已有標記而尚無solve者補記solve; 互斥檔用畢即刪', function() {
        let root = path.resolve(fdTmp, 'cas')
        let cfgD = normalizeCfg({ root, name: 'T', symbol: 'T', interval: '1day', source: { price: [] }, timeZone: 'UTC', timeBegin: '2023-01-01T00:00:00' })
        let fp = fpBasisOf(cfgD)
        let base = checkBasis(cfgD, 'params')
        assert.deepStrictEqual(base, mkDay())
        commitBasis(cfgD, null) //null不做任何事
        assert.ok(!fs.existsSync(fp))
        commitBasis(cfgD, base)
        let raw1 = fs.readFileSync(fp, 'utf8')
        assert.deepStrictEqual(JSON.parse(raw1), base)
        let mt1 = fs.statSync(fp).mtimeMs
        commitBasis(cfgD, base) //同口徑: 不寫
        assert.strictEqual(fs.statSync(fp).mtimeMs, mt1)
        assert.throws(() => commitBasis(cfgD, { ...base, timeBasis: 'span' }), (e) => e.message === 'invalid cfg.timeBasis: must match the basis recorded in the work root (meta/basis.json)')
        assert.strictEqual(fs.readFileSync(fp, 'utf8'), raw1)
        let pend = basisPendingOf(cfgD, { levelNumTradeBounds: [1, 3] })
        assert.deepStrictEqual(pend, mkDay({ thsCond: null, levelNumTradeBounds: [1, 3] }))
        commitBasis(cfgD, pend) //補記solve
        assert.deepStrictEqual(readBasis(cfgD), pend)
        assert.throws(() => commitBasis(cfgD, basisPendingOf(cfgD, { levelNumTradeBounds: [1, 4] })), (e) => e.message === msgSolve('levelNumTradeBounds'))
        commitBasis(cfgD, base) //不帶solve之同口徑(普測等): 不比對solve、不改檔
        assert.deepStrictEqual(readBasis(cfgD), pend)
        assert.deepStrictEqual(fs.readdirSync(cfgD.fds.meta).sort(), [BASIS_FILE])
        fs.writeFileSync(fp, '{', 'utf8')
        assert.throws(() => commitBasis(cfgD, base), (e) => e.message === MSG_UNREADABLE)
        assert.throws(() => readBasis(cfgD), (e) => e.message === MSG_UNREADABLE)
        assert.ok(!fs.existsSync(`${fp}.lock`))
    })

    it('commitBasis之互斥檔(同口徑並行): 他者持有時等候, 釋放後寫入(無標記)或比對通過(他者已寫同一口徑); 他者已寫不同口徑者於重讀後即throw且不覆寫', async function() {
        this.timeout(60000)
        let lockOf = (c) => {
            let fp = fpBasisOf(c)
            fs.mkdirSync(path.dirname(fp), { recursive: true })
            fs.writeFileSync(`${fp}.lock`, JSON.stringify({ pid: 1, at: new Date().toISOString() }), 'utf8') //他者持有(新)
            return { fp, fg: `${fp}.lock` }
        }
        //①無標記: 等候他者釋放後寫入
        let c1 = cfgDayOf('wait1')
        let l1 = lockOf(c1)
        let h1 = await holder({ fg: l1.fg, delayMs: 400 })
        let t0 = Date.now()
        commitBasis(c1, mkDay())
        let dt = Date.now() - t0
        await h1.exited
        assert.ok(dt >= 300, `${dt}`) //確有等候
        assert.deepStrictEqual(readBasis(c1), mkDay())
        assert.ok(!fs.existsSync(l1.fg))
        //②他者於持有期間寫入同一口徑: 等候後重讀比對通過, 不改檔
        let c2 = cfgDayOf('wait2')
        let l2 = lockOf(c2)
        let h2 = await holder({ fg: l2.fg, fp: l2.fp, marker: mkDay(), delayMs: 400 })
        commitBasis(c2, mkDay())
        await h2.exited
        assert.deepStrictEqual(readBasis(c2), mkDay())
        //③他者於持有期間寫入不同口徑: 等候後重讀即throw, 標記仍為他者所寫
        let c3 = cfgDayOf('wait3')
        let l3 = lockOf(c3)
        let other = { ...mkDay(), timeBasis: 'span' }
        let h3 = await holder({ fg: l3.fg, fp: l3.fp, marker: other, delayMs: 400 })
        assert.throws(() => commitBasis(c3, mkDay()), (e) => e.message === 'invalid cfg.timeBasis: must match the basis recorded in the work root (meta/basis.json)')
        await h3.exited
        assert.deepStrictEqual(readBasis(c3), other)
        assert.ok(!fs.existsSync(l3.fg))
    })

    it('commitBasis之穩態(標記已存在且一致、無須寫入)不取互斥檔: 互斥檔被占用(新)時亦立即返回; 已有一致標記之工作根上, 持鎖行程被強制結束而遺留新互斥檔後, 2個worker之求解照常且不動該互斥檔', async function() {
        this.timeout(180000)
        let pl = mkPl('steady')
        await pl.buildOhlc()
        await pl.buildParams({ only })
        let optS = { ...quick, mode: 'long', thsCond: [-1, 1] }
        await pl.solve({ ...optS, ...untilOne })
        assert.deepStrictEqual(readMk(pl).solve, { thsCond: [-1, 1], levelNumTradeBounds: null })
        let fg = `${fpBasisOf(pl.cfg)}.lock`
        fs.writeFileSync(fg, JSON.stringify({ pid: 1, at: new Date().toISOString() }), 'utf8') //持鎖行程被強制結束而遺留(新)
        await withGuardScale({ staleMs: 3000, waitMs: 4000 }, () => {
            let t0 = Date.now()
            commitBasis(pl.cfg, basisPendingOf(pl.cfg, optS))
            commitBasis(pl.cfg, { ...readMk(pl), solve: null }) //普測、buildParams之同口徑(不帶solve)
            assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}`)
        })
        let n0 = nJson(pl.cfg.fds.strategies)
        let t1 = Date.now()
        let st = await pl.solve({ ...optS, workers: 2, maxRounds: 2 })
        let dt = Date.now() - t1
        assert.strictEqual(st.errors.length, 0, JSON.stringify(st.errors).slice(0, 300))
        assert.ok(dt < 25000, `${dt}`) //不等候互斥檔(預設之殘留判定為30秒)
        assert.ok(nJson(pl.cfg.fds.strategies) >= n0)
        assert.ok(fs.existsSync(fg)) //穩態不取、不動他者之互斥檔
        fs.rmSync(fg)
    })

    it('commitBasis之互斥檔之時限: 等候上限大於殘留判定(預設35秒 > 30秒); 未再更新之互斥檔於等候中逾殘留判定即被移除而照常寫入; 持有者持續更新者逾等候上限即throw且不改標記', async function() {
        this.timeout(60000)
        assert.deepStrictEqual({ staleMs: BASIS_GUARD.staleMs, waitMs: BASIS_GUARD.waitMs }, { staleMs: 30000, waitMs: 35000 })
        assert.ok(BASIS_GUARD.waitMs > BASIS_GUARD.staleMs)
        await withGuardScale({ staleMs: 1000, waitMs: 2000 }, async () => {
            //①遺留之新互斥檔(持有者已不在、不再更新): 等候約1秒後移除而寫入
            let c1 = cfgDayOf('tl1')
            let fp1 = fpBasisOf(c1)
            fs.mkdirSync(path.dirname(fp1), { recursive: true })
            fs.writeFileSync(`${fp1}.lock`, '{}', 'utf8')
            let t0 = Date.now()
            commitBasis(c1, mkDay())
            let dt = Date.now() - t0
            assert.ok(dt >= 900 && dt < 2000, `${dt}`)
            assert.deepStrictEqual(readBasis(c1), mkDay())
            assert.ok(!fs.existsSync(`${fp1}.lock`))
            //②持有者持續更新(仍在臨界區): 逾等候上限即throw, 不寫標記、不動他者之互斥檔
            let c2 = cfgDayOf('tl2')
            let fp2 = fpBasisOf(c2)
            fs.mkdirSync(path.dirname(fp2), { recursive: true })
            fs.writeFileSync(`${fp2}.lock`, '{}', 'utf8')
            let h = await holder({ fg: `${fp2}.lock`, delayMs: 3500, touchMs: 100 })
            assert.throws(() => commitBasis(c2, mkDay()), (e) => e.message === MSG_BUSY)
            assert.ok(!fs.existsSync(fp2))
            assert.ok(fs.existsSync(`${fp2}.lock`))
            await h.exited
        })
    })

    it('commitBasis之互斥檔殘留而無法移除時視為占用而續等, 逾時以固定訊息throw(不外漏原生訊息與路徑)', async function() {
        this.timeout(30000)
        let c = cfgDayOf('unremovable')
        let fp = fpBasisOf(c)
        let fg = `${fp}.lock`
        fs.mkdirSync(fg, { recursive: true }) //以資料夾佔住互斥檔之路徑(檔案之移除必失敗)
        let old = new Date(Date.now() - 60000)
        fs.utimesSync(fg, old, old)
        await withGuardScale({ staleMs: 100, waitMs: 600 }, () => {
            assert.throws(() => commitBasis(c, mkDay()), (e) => e.message === MSG_BUSY && !e.message.includes(fdTmp))
        })
        assert.ok(!fs.existsSync(fp))
        fs.rmSync(fg, { recursive: true, force: true })
    })

    it('commitBasis之建立互斥檔與寫入標記失敗(主控裁定之V19/V20): 訊息為`invalid cfg.root: must allow creating meta/basis.json.lock (<錯誤碼>)`、`invalid cfg.root: must allow writing meta/basis.json (<錯誤碼>)`, 只帶錯誤碼, 不外漏原生訊息與路徑; 不留互斥檔、暫存檔與標記', function() {
        this.timeout(30000)
        let c = cfgDayOf('ioerr')
        let fp = fpBasisOf(c)
        let wf = fs.writeFileSync
        let rn = fs.renameSync
        let lk = fs.linkSync
        let errOf = (code) => Object.assign(new Error(`${code}: native message with path ${fdTmp}`), { code })
        let msgLock = (code) => `invalid cfg.root: must allow creating meta/basis.json.lock (${code})`
        let msgWrite = (code) => `invalid cfg.root: must allow writing meta/basis.json (${code})`
        let clean = (e, want) => e.message === want && !e.message.includes(fdTmp) && !e.message.includes('native')
        let isLockTmp = (p) => String(p).includes('basis.json.lock.') && String(p).endsWith('.tmp')
        let isMarkTmp = (p) => String(p).includes('basis.json.') && !String(p).includes('basis.json.lock') && String(p).endsWith('.tmp')
        let failWhen = (isTarget, code) => (p, ...a) => {
            if (isTarget(p)) {
                throw errOf(code)
            }
            return wf(p, ...a)
        }
        try {
            //互斥檔之暫存檔寫不出
            fs.writeFileSync = failWhen(isLockTmp, 'EACCES')
            assert.throws(() => commitBasis(c, mkDay()), (e) => clean(e, msgLock('EACCES')))
            fs.writeFileSync = wf
            //互斥檔之建立遇非占用類錯誤(占用類EEXIST、EPERM、EBUSY、EACCES則續等, 見上案)
            fs.linkSync = () => {
                throw errOf('EXDEV')
            }
            assert.throws(() => commitBasis(c, mkDay()), (e) => clean(e, msgLock('EXDEV')))
            fs.linkSync = lk
            //標記之暫存檔寫不出
            fs.writeFileSync = failWhen(isMarkTmp, 'ENOSPC')
            assert.throws(() => commitBasis(c, mkDay()), (e) => clean(e, msgWrite('ENOSPC')))
            fs.writeFileSync = wf
            //標記之改名遇非占用類錯誤: 立即throw; 占用類(EPERM)重試數次後仍失敗亦同訊息
            fs.renameSync = () => {
                throw errOf('EXDEV')
            }
            assert.throws(() => commitBasis(c, mkDay()), (e) => clean(e, msgWrite('EXDEV')))
            fs.renameSync = () => {
                throw errOf('EPERM')
            }
            assert.throws(() => commitBasis(c, mkDay()), (e) => clean(e, msgWrite('EPERM')))
        }
        finally {
            fs.writeFileSync = wf
            fs.renameSync = rn
            fs.linkSync = lk
        }
        assert.ok(!fs.existsSync(fp)) //未寫入標記
        assert.deepStrictEqual(fs.readdirSync(c.fds.meta), []) //不留互斥檔與暫存檔
        commitBasis(c, mkDay()) //還原後照常
        assert.deepStrictEqual(readBasis(c), mkDay())
    })

    it('readBasis之讀取失敗(非不存在): 訊息為`invalid cfg.root: must allow reading meta/basis.json (<錯誤碼>)`, 只帶錯誤碼、不外漏原生訊息與路徑; EPERM、EBUSY、EACCES之暫時性失敗短暫重試後照常讀到', function() {
        this.timeout(30000)
        let c = cfgDayOf('readerr')
        let fp = fpBasisOf(c)
        commitBasis(c, mkDay())
        let rf = fs.readFileSync
        let errOf = (code) => Object.assign(new Error(`${code}: native message with path ${fdTmp}`), { code })
        let isMark = (p) => path.resolve(String(p)) === path.resolve(fp)
        try {
            //非暫時性之錯誤(如EISDIR): 立即以固定訊息拋
            fs.readFileSync = (p, ...a) => {
                if (isMark(p)) {
                    throw errOf('EISDIR')
                }
                return rf(p, ...a)
            }
            assert.throws(() => readBasis(c), (e) => e.message === 'invalid cfg.root: must allow reading meta/basis.json (EISDIR)' && !e.message.includes(fdTmp) && !e.message.includes('native'))
            //暫時性之錯誤(改名覆蓋之瞬間): 前2次EPERM、EBUSY後讀到
            let n = 0
            fs.readFileSync = (p, ...a) => {
                if (isMark(p) && n++ < 2) {
                    throw errOf(n === 1 ? 'EPERM' : 'EBUSY')
                }
                return rf(p, ...a)
            }
            assert.deepStrictEqual(readBasis(c), mkDay())
            assert.strictEqual(n, 3)
            //暫時性之錯誤持續: 重試有限次(6次)後以固定訊息拋
            let m = 0
            fs.readFileSync = (p, ...a) => {
                if (isMark(p)) {
                    m++
                    throw errOf('EACCES')
                }
                return rf(p, ...a)
            }
            assert.throws(() => readBasis(c), (e) => e.message === 'invalid cfg.root: must allow reading meta/basis.json (EACCES)')
            assert.strictEqual(m, 6)
            //不存在(ENOENT)仍為無標記
            fs.readFileSync = (p, ...a) => {
                if (isMark(p)) {
                    throw errOf('ENOENT')
                }
                return rf(p, ...a)
            }
            assert.strictEqual(readBasis(c), null)
        }
        finally {
            fs.readFileSync = rf
        }
        assert.deepStrictEqual(readBasis(c), mkDay())
    })

    it('src/util/basis.mjs之全部錯誤訊息皆為`invalid <名稱>: must …`(V19), 內插只限固定之名稱、鍵名、夾名與錯誤碼(V20: 不含輸入值)', function() {
        let text = fs.readFileSync(path.resolve('src/util/basis.mjs'), 'utf8')
        let msgs = [...text.matchAll(/new Error\(`([^`]*)`\)/g)].map((m) => m[1])
        assert.ok(msgs.length >= 8, `${msgs.length}`)
        let okVars = ['codeOf(err)', 'name', 'k', 'MSG_SOLVE_HINT', 'label'] //內插之允許集合: 錯誤碼、設定鍵名、求解選項鍵名、復原途徑之固定句、產物名
        for (let m of msgs) {
            assert.ok(/^invalid [A-Za-z0-9_.]+(?:\$\{[a-z]+\})?: must /.test(m) || /^invalid cfg\.\$\{name\}: must /.test(m) || /^invalid opt\.\$\{k\}: must /.test(m), m)
            for (let v of m.matchAll(/\$\{([^}]*)\}/g)) {
                assert.ok(okVars.includes(v[1]), `${m} → ${v[1]}`)
            }
        }
    })

    it('已記之求解口徑與本次不同即throw, 訊息附復原途徑(策略庫尚無策略檔時把meta/basis.json之solve改為null, 或另建工作根); 依此復原後可以新口徑求解', async function() {
        this.timeout(120000)
        let pl = mkPl('d7')
        await pl.buildOhlc()
        await pl.buildParams({ only })
        commitBasis(pl.cfg, basisPendingOf(pl.cfg, { thsCond: [-1, 1] })) //模擬: 已寫標記、尚未存第一隻策略即中止
        assert.strictEqual(nJson(pl.cfg.fds.strategies), 0)
        assert.throws(() => pl.createSolver({ ...quick, thsCond: [-1, 0, 1] }), (e) => e.message === msgSolve('thsCond'))
        let fp = fpBasisOf(pl.cfg)
        fs.writeFileSync(fp, JSON.stringify({ ...readMk(pl), solve: null }), 'utf8') //依訊息復原
        await pl.solve({ ...quick, mode: 'long', ...untilOne, thsCond: [-1, 0, 1] })
        assert.deepStrictEqual(readMk(pl).solve, { thsCond: [-1, 0, 1], levelNumTradeBounds: null })
    })

})
