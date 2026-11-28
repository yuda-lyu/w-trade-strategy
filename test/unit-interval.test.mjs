import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { spanLabelOf } from 'w-data-trade/src/resolvePeriods.mjs'
import periodInfo from 'w-data-trade/src/periodInfo.mjs'
import dataProvide from 'w-data-tdprovide/src/WDataTdprovide.mjs'
import genStrategyFileName from 'w-trade-solve/src/genStrategyFileName.mjs'
import calcLevelNumTrade from 'w-trade-solve/src/calcLevelNumTrade.mjs'
import createPipeline from '../src/createPipeline.mjs'
import normalizeCfg from '../src/cfg.mjs'
import makeFastEngine from '../src/solve/fastEngine.mjs'
import { solveFwdOf, chkOml, prepareSolve, runRound } from '../src/solve/solveRound.mjs'
import { checkInvariant, optFnOf } from '../src/recompute/recomputeStrategies_core.mjs'
import { makeOtt } from '../src/util/ott.mjs'
import { buildFdTmp, cfgOf } from './tools/synthKit.mjs'


//規格來源: 規則帳本TS-20(時間口徑)、TS-21(求解新選項)、TS-11(根數為本)與README之〈2. 設定〉、〈4. 參數〉
//  時間口徑: cfg.timeBasis('open'/'span')與intervalSec一致地轉傳至每一處呼叫回測或求解者 —— 普測兩核心(策略settings與calcOrdersSummarySimple之opt)、求解(estimFinder之opt ⇒ 策略settings; 加速核心與存檔前官方重跑皆讀strategy.settings)、
//    策略庫重算(目標口徑); 未給 ≡ 現行; 接縫不用替身(以真實回測套件之輸出驗證)
//  求解新選項: thsCond、levelNumTradeBounds放行並轉傳; 重算以檔內之級距設定組檔名
//  根數為本: 同一串K線以4hr與1day計, 鍵數相同(內建目錄全算1160 = 依根數之期別874 + 方向改變法之門檻鍵16 + 動能、波動延伸、下跌統計、主動買賣量流之期別鍵270)、期別標籤依「根數 × 每根時長」對應(方向改變法之門檻標籤`${門檻}pct`不隨週期改變)、各序列值逐值相同
//  驗證之鑑別: 日線之訓練窗為首根至末根(n根), 'open'之回測天數 = n − 1, 'span' = n(計至末根收盤)


let fdTmp = buildFdTmp('interval')
let n = 420
let DAY = 86400 * 1000

//快速求解設定(合成數據下門檻放寬; 單輪仍可能0隻, 須有策略之案以untilOne求解至至少1隻)
let quick = { thNumTrade: 1, thRWin: 0, thEqYr: -1e9, thsTp: [3, 5], thsSl: [3, 5], oml: { Np: 6, NContiguous: 3, Ng: 15 } }
let untilOne = { maxStrategies: 1, maxRounds: 30 } //求解至策略庫至少1隻(各輪之存檔數依隨機搜尋而定)

//only, 因子子集(含價格與溢價指數, 使各組成皆可用)
let only = ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd', 'index_ohlc_close']

//readLib, 讀資料夾內全部策略檔
let readLib = (fd) => fs.readdirSync(fd).filter((f) => f.endsWith('.json')).sort().map((f) => ({ fn: f, data: JSON.parse(fs.readFileSync(path.resolve(fd, f), 'utf8')) }))

//mkRoot, 建一個日線(每根1day)之工作根並備妥K線、因子與先觸快取
let mkRoot = async (name, ov = {}) => {
    let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, name), interval: '1day', stepMs: DAY, ...ov })
    let pl = createPipeline(cfg)
    await pl.buildOhlc()
    await pl.buildParams({ only })
    await pl.buildCache({ tps: [3, 5] })
    return pl
}


describe('interval(每根時長、時間口徑與求解新選項之接線)', function() {

    let plOpen = null
    let plSpan = null

    before(async function() {
        this.timeout(180000)
        plOpen = await mkRoot('open')
        plSpan = await mkRoot('span', { timeBasis: 'span' })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('前提: 日線之訓練窗為n根; 未給timeBasis之cfg無timeBasis鍵, 給span者有', function() {
        assert.strictEqual(plOpen.cfg.intervalSec, 86400)
        assert.ok(!('timeBasis' in plOpen.cfg))
        assert.strictEqual(plSpan.cfg.timeBasis, 'span')
        let ott = makeOtt('UTC')
        assert.strictEqual(ott(plSpan.cfg.train.timeEnd).diff(ott(plSpan.cfg.train.timeStart), 'day'), n - 1)
    })

    it('時間口徑 普測(sweepSingle): span時策略settings於末另記intervalSec與timeBasis, 摘要之回測天數計至末根收盤(n); 未給時無此二鍵且為n − 1', async function() {
        this.timeout(120000)
        let rO = await plOpen.sweepSingle({ numTradeFinMin: 3, limit: 6, takeLimit: 1 })
        let rS = await plSpan.sweepSingle({ numTradeFinMin: 3, limit: 6, takeLimit: 1 })
        assert.ok(rO.nOut > 0 && rS.nOut > 0, `${rO.nOut} ${rS.nOut}`)
        for (let { data } of readLib(plSpan.cfg.fds.strategiesP1)) {
            assert.deepStrictEqual(Object.keys(data.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee', 'intervalSec', 'timeBasis'])
            assert.strictEqual(data.settings.intervalSec, 86400)
            assert.strictEqual(data.settings.timeBasis, 'span')
            assert.strictEqual(data.summary.btDays, n) //摘要經calcOrdersSummarySimple之opt依span計
        }
        for (let { data } of readLib(plOpen.cfg.fds.strategiesP1)) {
            assert.deepStrictEqual(Object.keys(data.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee'])
            assert.strictEqual(data.summary.btDays, n - 1)
        }
    })

    it('時間口徑 普測(sweepPairs): span時策略settings另記intervalSec與timeBasis, 摘要之回測天數為n; 未給時為n − 1', async function() {
        this.timeout(120000)
        let rO = await plOpen.sweepPairs({ numTradeFinMin: 3, eqYrMin: -1e9, limit: 4, takeLimit: 1 })
        let rS = await plSpan.sweepPairs({ numTradeFinMin: 3, eqYrMin: -1e9, limit: 4, takeLimit: 1 })
        assert.ok(rO.nOut > 0 && rS.nOut > 0, `${rO.nOut} ${rS.nOut}`)
        for (let { data } of readLib(plSpan.cfg.fds.strategiesP2)) {
            assert.strictEqual(data.settings.intervalSec, 86400)
            assert.strictEqual(data.settings.timeBasis, 'span')
            assert.strictEqual(data.summary.btDays, n)
        }
        for (let { data } of readLib(plOpen.cfg.fds.strategiesP2)) {
            assert.ok(!('timeBasis' in data.settings) && !('intervalSec' in data.settings))
            assert.strictEqual(data.summary.btDays, n - 1)
        }
    })

    it('時間口徑 求解(in-process, 加速核心＋存檔前官方重跑): span時策略settings於unit位置之後記intervalSec與timeBasis, 摘要之回測天數為n; 未給時為n − 1', async function() {
        this.timeout(120000)
        await plOpen.solve({ ...quick, mode: 'long', ...untilOne })
        await plSpan.solve({ ...quick, mode: 'long', ...untilOne })
        let libS = readLib(plSpan.cfg.fds.strategies)
        let libO = readLib(plOpen.cfg.fds.strategies)
        assert.ok(libS.length > 0 && libO.length > 0)
        for (let { data } of libS) {
            assert.deepStrictEqual(Object.keys(data.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee', 'intervalSec', 'timeBasis'])
            assert.strictEqual(data.settings.intervalSec, 86400)
            assert.strictEqual(data.settings.timeBasis, 'span')
            assert.strictEqual(data.summary.btDays, n)
        }
        for (let { data } of libO) {
            assert.deepStrictEqual(Object.keys(data.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee'])
            assert.strictEqual(data.summary.btDays, n - 1)
        }
    })

    it('時間口徑 求解(workers 1與engine full): span時策略settings與摘要依span(worker經序列化之cfg取得timeBasis)', async function() {
        this.timeout(120000)
        let fdW = path.resolve(fdTmp, 'span', 'libW')
        let fdF = path.resolve(fdTmp, 'span', 'libF')
        await plSpan.solve({ ...quick, mode: 'short', ...untilOne, workers: 1, fdStrategies: fdW })
        await plSpan.solve({ ...quick, mode: 'long', ...untilOne, engine: 'full', fdStrategies: fdF })
        for (let fd of [fdW, fdF]) {
            let lib = readLib(fd)
            assert.ok(lib.length > 0, fd)
            for (let { data } of lib) {
                assert.strictEqual(data.settings.timeBasis, 'span')
                assert.strictEqual(data.settings.intervalSec, 86400)
                assert.strictEqual(data.summary.btDays, n)
            }
        }
    })

    it('時間口徑 加速核心(makeFastEngine): 依strategy.settings之timeBasis評估(span為n、去掉時間欄為n − 1), 與官方重放之摘要對應欄相同', async function() {
        this.timeout(60000)
        let { data } = readLib(plSpan.cfg.fds.strategies)[0]
        let ott = makeOtt(plSpan.cfg.timeZone)
        let pd = dataProvide(plSpan.cfg.fds.ohlc, plSpan.cfg.fds.param)
        let fgs = await pd.buildGetTimeSeriesByTimeRange(data.solve.timeStart, data.solve.timeEnd)
        let fast = makeFastEngine()
        let r1 = await fast({ ott, strategy: data, funGetSeries: fgs })
        assert.strictEqual(r1.summary.btDays, n)
        assert.strictEqual(r1.summary.rEquivalentCumuProfitOrLossFinalNormYear, data.summary.rEquivalentCumuProfitOrLossFinalNormYear)
        let { intervalSec, timeBasis, ...st0 } = data.settings
        let fgs2 = await pd.buildGetTimeSeriesByTimeRange(data.solve.timeStart, data.solve.timeEnd)
        let r0 = await fast({ ott, strategy: { ...data, settings: st0 }, funGetSeries: fgs2 })
        assert.strictEqual(r0.summary.btDays, n - 1)
        assert.ok(intervalSec === 86400 && timeBasis === 'span')
    })

    it('時間口徑 策略庫重算: span之庫以檔內settings忠實重放全符; 未給timeBasis之庫以cfg.timeBasis為span重算 ⇒ 新settings記時間欄、摘要依span, 交易筆數與檔名不變', async function() {
        this.timeout(120000)
        let unit = { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 5, asOf: '2026-01-01T00:00:00', source: 'test' } }
        let v = await plSpan.recomputeStrategies({ mode: 'verify', takeLimit: 1, fdReport: path.resolve(fdTmp, 'rep-span-verify') })
        assert.strictEqual(v.counts.ok, readLib(plSpan.cfg.fds.strategies).length, JSON.stringify(v.counts))
        let cfgS = normalizeCfg({ ...plOpen.cfg, timeBasis: 'span' })
        let plR = createPipeline(cfgS)
        let fdOut = path.resolve(fdTmp, 'open-to-span')
        let w = await plR.recomputeStrategies({ mode: 'write', fdOut, uIni: 10000, unit, takeLimit: 1, fdReport: path.resolve(fdTmp, 'rep-open-span') })
        assert.strictEqual(w.ok, true, JSON.stringify(w.counts))
        let src = new Map(readLib(plOpen.cfg.fds.strategies).map((v) => [v.fn, v.data]))
        let out = readLib(fdOut)
        assert.strictEqual(out.length, src.size)
        for (let { fn, data } of out) {
            let d0 = src.get(fn)
            assert.ok(d0, fn)
            assert.deepStrictEqual(Object.keys(data.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee', 'unit', 'intervalSec', 'timeBasis'])
            assert.strictEqual(data.settings.timeBasis, 'span')
            assert.strictEqual(data.summary.btDays, n)
            assert.strictEqual(d0.summary.btDays, n - 1)
            assert.strictEqual(data.summary.numTrade, d0.summary.numTrade)
        }
    })

    it('求解新選項(in-process與workers 1): thsCond之格點與levelNumTradeBounds之級距放行並轉傳 ⇒ 門檻皆為格點之一、級距與tkid帶設定、solve區塊記錄、檔名以同一級距組成', async function() {
        this.timeout(120000)
        let pl = await mkRoot('grid')
        let thsCond = [-1.5, -0.5, 0.5, 1.5]
        let levelNumTradeBounds = [1, 4, 9]
        await pl.solve({ ...quick, mode: 'long', ...untilOne, thsCond, levelNumTradeBounds })
        let n1 = readLib(pl.cfg.fds.strategies).length
        await pl.solve({ ...quick, mode: 'short', maxStrategies: n1 + 1, maxRounds: 30, workers: 1, thsCond: thsCond.map(String), levelNumTradeBounds: levelNumTradeBounds.map(String) }) //數字字串同值(口徑相同); 求解至多出至少1隻(做空)
        let lib = readLib(pl.cfg.fds.strategies)
        assert.ok(lib.length > 0)
        assert.ok(lib.some((v) => v.data.mode === 'long') && lib.some((v) => v.data.mode === 'short'))
        for (let { fn, data } of lib) {
            for (let c of data.conds) {
                assert.ok(thsCond.includes(c.th), `${c.th}`)
            }
            assert.deepStrictEqual(data.solve.thsCond, thsCond)
            assert.deepStrictEqual(data.solve.levelNumTradeBounds, levelNumTradeBounds)
            assert.ok(data.tkid.endsWith(`@${levelNumTradeBounds.join(',')}`), data.tkid)
            assert.strictEqual(data.levelNumTrade, calcLevelNumTrade(data.numTrade, { levelNumTradeBounds }))
            assert.strictEqual(fn, genStrategyFileName(data.name, data.interval, data.mode, data.keys, data.settings, data.summary, { levelNumTradeBounds }))
        }
    })

    it('重算以檔內之級距設定組檔名: 自訂級距之庫verify與dry全為ok且無nameMismatch(以預設級距組檔名則全庫皆不符, 故此斷言有鑑別力); checkInvariant以同一設定比對', async function() {
        this.timeout(120000)
        let pl = createPipeline(normalizeCfg({ ...cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'grid'), interval: '1day', stepMs: DAY }).cfg }))
        let unit = { rule: { stepSize: 0.001, minQty: 0.001, minNotional: 5, asOf: '2026-01-01T00:00:00', source: 'test' } }
        let lib = readLib(pl.cfg.fds.strategies)
        //前提: 每隻之實際檔名 = 以檔內級距設定所組者, 且 ≠ 以預設級距所組者(級距設定進入雜湊)
        for (let { fn, data } of lib) {
            assert.deepStrictEqual(optFnOf(data), { levelNumTradeBounds: [1, 4, 9] })
            assert.strictEqual(fn, genStrategyFileName(data.name, data.interval, data.mode, data.keys, data.settings, data.summary, optFnOf(data)))
            assert.notStrictEqual(fn, genStrategyFileName(data.name, data.interval, data.mode, data.keys, data.settings, data.summary))
            assert.deepStrictEqual(checkInvariant(data, data.settings, data.summary), [])
        }
        let v = await pl.recomputeStrategies({ mode: 'verify', takeLimit: 1, fdReport: path.resolve(fdTmp, 'rep-grid-v') })
        assert.strictEqual(v.counts.ok, lib.length, JSON.stringify(v.counts))
        assert.strictEqual(v.nameMismatch.n, 0)
        let d = await pl.recomputeStrategies({ mode: 'dry', uIni: 10000, unit, takeLimit: 1, fdReport: path.resolve(fdTmp, 'rep-grid-d') })
        assert.strictEqual(d.counts.ok, lib.length, JSON.stringify(d.counts))
        assert.strictEqual(d.nameMismatch.n, 0)
    })

    it('求解之止盈止損候選給了而無效(含0): 錯誤原樣上拋(不吞掉、不改用預設), 不寫入策略', async function() {
        this.timeout(60000)
        let pl = await mkRoot('badtp')
        await assert.rejects(pl.solve({ ...quick, thsTp: [0], thsSl: [3], mode: 'long', maxRounds: 1 }), /invalid/)
        await assert.rejects(pl.solve({ ...quick, thsTp: [0, 3], thsSl: [3], mode: 'long', maxRounds: 1 }), /opt\.thsTp/) //有效與無效混雜: 不得濾掉無效者後續跑
        assert.strictEqual(readLib(pl.cfg.fds.strategies).length, 0)
    })

    it('求解之thsTp、thsSl、thsCond、levelNumTradeBounds給了(非null與undefined)即原樣轉傳(含非陣列與空陣列; 不改為「非空陣列才轉傳」): 求解套件對無效值拋錯而原樣上拋, 不寫入策略', async function() {
        this.timeout(60000)
        assert.deepStrictEqual(solveFwdOf({ thsTp: 'x', thsSl: [], thsCond: [-1, 1], levelNumTradeBounds: null, thEqYr: 0.1 }), { thsTp: 'x', thsSl: [], thsCond: [-1, 1] })
        assert.deepStrictEqual(solveFwdOf({ thsTp: 0, thsSl: undefined }), { thsTp: 0 })
        assert.deepStrictEqual(solveFwdOf({}), {})
        let pl = await mkRoot('badtp2')
        let base = { ...quick, mode: 'long', maxRounds: 1 }
        await assert.rejects(pl.solve({ ...base, thsTp: '3' }), /opt\.thsTp/) //非陣列
        await assert.rejects(pl.solve({ ...base, thsSl: [] }), /opt\.thsSl/) //空陣列
        await assert.rejects(pl.solve({ ...base, thsTp: 5 }), /opt\.thsTp/)
        assert.strictEqual(readLib(pl.cfg.fds.strategies).length, 0)
    })

    it('oml不得覆寫口徑鍵(主控裁定): oml含thsCond、levelNumTradeBounds、intervalSec、timeBasis者(含值為undefined者)於建立求解器時即throw固定訊息(不含輸入值), 先於任何建夾與寫檔(策略庫夾不出現、meta/basis.json不變); in-process、workers 1與直接呼叫runRound皆同; 其餘oml鍵(Np等)、null、未給照常', async function() {
        this.timeout(120000)
        let pl = await mkRoot('oml')
        let fpBasis = path.resolve(pl.cfg.fds.meta, 'basis.json')
        let basis0 = fs.readFileSync(fpBasis, 'utf8')
        let probe = 7.7701
        let msgOf = (k) => `invalid opt.oml.${k}: must be given as opt.${k}`
        let guard = (e, k) => e.message === msgOf(k) && !e.message.includes(String(probe))
        let bad = { thsCond: [probe, 1], levelNumTradeBounds: [1, 3, probe], intervalSec: probe, timeBasis: 'span' }
        for (let k of ['thsCond', 'levelNumTradeBounds', 'intervalSec', 'timeBasis']) {
            let o = { ...quick, mode: 'long', maxRounds: 1, oml: { ...quick.oml, [k]: bad[k] } }
            assert.throws(() => pl.createSolver(o), (e) => guard(e, k), k) //同步throw
            assert.throws(() => pl.solve(o), (e) => guard(e, k), k) //solve為createSolver(...).start()之包裝, 求解器建立時之檢測同步throw(同不認得之opt鍵)
            assert.throws(() => pl.solve({ ...o, workers: 1 }), (e) => guard(e, k), `${k} workers`)
            assert.throws(() => pl.createSolver({ ...quick, oml: { ...quick.oml, [k]: undefined } }), (e) => e.message === msgOf(k), `${k} undefined`) //鍵存在即拒(攤平時undefined亦會覆寫轉傳之值)
        }
        //求解器保留之鍵(存檔前官方重跑之開關與回呼; 覆寫者使策略於無標記且未經官方重跑下存檔): 同樣拒(訊息不同: 無對應之opt.<鍵>可給)
        for (let k of ['useRunStrategyBeforeSave', 'funRunStrategyCustomBeforeSave']) {
            let oml = { ...quick.oml, [k]: k === 'useRunStrategyBeforeSave' ? false : () => null }
            let o = { ...quick, mode: 'long', maxRounds: 1, oml }
            let ok = (e) => e.message === `invalid opt.oml.${k}: must not be given (reserved by the solver)`
            assert.throws(() => pl.createSolver(o), ok, k)
            assert.throws(() => pl.solve(o), ok, k)
        }
        assert.throws(() => pl.createSolver({ ...quick, workers: 1, oml: { ...quick.oml, useRunStrategyBeforeSave: false } }), (e) => e.message === 'invalid opt.oml.useRunStrategyBeforeSave: must not be given (reserved by the solver)') //workers亦同(序列化前即拒)
        //同時含多個口徑鍵: 依固定次序拋第1個
        assert.throws(() => pl.createSolver({ ...quick, oml: { timeBasis: 'span', thsCond: [1] } }), (e) => e.message === msgOf('thsCond'))
        assert.ok(!fs.existsSync(pl.cfg.fds.strategies), '先於建夾: 策略庫夾不出現')
        assert.strictEqual(fs.readFileSync(fpBasis, 'utf8'), basis0) //標記不變
        //直接呼叫runRound亦拒(不經createSolver者)
        let prep = await prepareSolve(pl.cfg, { ...quick })
        await assert.rejects(runRound(pl.cfg, { ...quick, mode: 'long', oml: { ...quick.oml, thsCond: bad.thsCond } }, prep), (e) => guard(e, 'thsCond'))
        assert.strictEqual(readLib(pl.cfg.fds.strategies).length, 0)
        assert.strictEqual(fs.readFileSync(fpBasis, 'utf8'), basis0)
        //其餘oml鍵、null、未給、非物件: 照常(不誤傷)
        for (let oml of [{ Np: 6, NContiguous: 3, Ng: 15 }, null, undefined, {}]) {
            pl.createSolver({ ...quick, oml })
        }
        assert.doesNotThrow(() => chkOml({}))
        //口徑鍵一律以opt.<鍵>給: 同一口徑鍵改以opt.thsCond給可求解(標記記入thsCond; 門檻皆為所給格點之一)
        let st = await pl.solve({ ...quick, ...untilOne, mode: 'long', thsCond: [0.5, 1, 1.5] })
        assert.ok(st.nStrategies >= 1)
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(fpBasis, 'utf8')).solve.thsCond, [0.5, 1, 1.5])
    })

    it('根數為本(端到端): 同一串K線以4hr與1day計, 內建目錄全算之鍵數同為1160(874 + 方向改變法16 + 動能、波動延伸、下跌統計、主動買賣量流270)、標籤依根數 × 每根時長一一對應(門檻標籤不變)、各序列逐值相同', async function() {
        this.timeout(180000)
        let mk = async (name, interval, stepMs) => {
            //750根: 不少於內建目錄各期別皆有值之721根(volx根數180之期), 全算1160鍵無無值之期(無值之期不寫出, TS-33)
            let { cfg } = cfgOf(fdTmp, 750, { root: path.resolve(fdTmp, name), interval, stepMs })
            let pl = createPipeline(cfg)
            await pl.buildOhlc()
            let r = await pl.buildParams()
            return { pl, r }
        }
        let a = await mk('e2e4', '4hr', 4 * 3600 * 1000)
        let b = await mk('e2e1d', '1day', DAY)
        assert.strictEqual(a.r.nKeys, 1160)
        assert.strictEqual(b.r.nKeys, 1160)
        assert.ok(!('emptyKeys' in a.r) && !('emptyKeys' in b.r)) //各期別皆有值: 回傳無emptyKeys
        //動能(momz)、波動延伸(volx)、下跌統計(down)、主動買賣量流(flow): 預設納入; 各為 輸出 × 9期 = 45、90、27、108鍵, 期別標籤 = 根數(3、4、5、6、12、24、42、90、180) × 每根時長
        let labelsOf = (keys, method) => [...new Set(keys.filter((k) => k.split('_')[4] === method).map((k) => k.split('_')[5]))]
        for (let [method, nKeys] of [['momz', 45], ['volx', 90], ['down', 27], ['flow', 108]]) {
            assert.strictEqual(a.r.keys.filter((k) => k.split('_')[4] === method).length, nKeys, method)
            assert.strictEqual(b.r.keys.filter((k) => k.split('_')[4] === method).length, nKeys, method)
            assert.deepStrictEqual(labelsOf(a.r.keys, method).sort(), ['12hr', '16hr', '20hr', '1day', '2day', '4day', '7day', '15day', '30day'].sort(), method)
            assert.deepStrictEqual(labelsOf(b.r.keys, method).sort(), ['3day', '4day', '5day', '6day', '12day', '24day', '42day', '90day', '180day'].sort(), method)
        }
        let keysB = new Set(b.r.keys)
        let reDir = /^price_ohlc_none_(dirState|dirRetrace|dirRun|dirAge)_dirChange_(4|6|8|10)pct$/
        assert.strictEqual(a.r.keys.filter((k) => reDir.test(k)).length, 16)
        let nCmp = 0
        let nDir = 0
        for (let k4 of a.r.keys) {
            let ps = k4.split('_')
            let label4 = ps[ps.length - 1]
            if (reDir.test(k4)) {
                //方向改變法: 門檻標籤不是時間跨度, w-data-trade(>= 1.0.58)之periodInfo回無根數視窗{ bars: 0, spanSec: 0 }(同'none', 不隨intervalSec改變); 其鍵於1day為同名, 故不可套用下方「bars為0即映為'none'」之換算(須保持原標籤)
                assert.deepStrictEqual(periodInfo(label4, { intervalSec: 14400 }), { period: label4, bars: 0, spanSec: 0 })
                assert.deepStrictEqual(periodInfo(label4, { intervalSec: 86400 }), { period: label4, bars: 0, spanSec: 0 })
                nDir++
            }
            let bars = reDir.test(k4) ? null : periodInfo(label4, { intervalSec: 14400 }).bars
            let label1 = bars === null ? label4 : (bars === 0 ? 'none' : spanLabelOf(bars * 86400))
            let k1 = [...ps.slice(0, -1), label1].join('_')
            assert.ok(keysB.has(k1), `${k4} → ${k1}`)
            let v4 = JSON.parse(fs.readFileSync(path.resolve(a.pl.cfg.fds.param, `${k4}.json`), 'utf8'))
            let v1 = JSON.parse(fs.readFileSync(path.resolve(b.pl.cfg.fds.param, `${k1}.json`), 'utf8'))
            assert.strictEqual(v1.length, v4.length, k4)
            assert.deepStrictEqual(v1.map((x) => x.param), v4.map((x) => x.param), k4)
            nCmp++
        }
        assert.strictEqual(nCmp, 1160)
        assert.strictEqual(nDir, 16)
        assert.ok(b.r.keys.some((k) => k.endsWith('_180day')))
    })

})
