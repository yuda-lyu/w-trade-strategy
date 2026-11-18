import assert from 'assert'
import fs from 'fs'
import path from 'path'
import isnum from 'wsemi/src/isnum.mjs'
import dataProvide from 'w-data-tdprovide/src/WDataTdprovide.mjs'
import loadKLinesTpSl from 'w-trade-backtest/src/loadKLinesTpSl.mjs'
import calcOrdersSummarySimple from 'w-trade-backtest/src/calcOrdersSummarySimple.mjs'
import runStrategy from 'w-trade-backtest/src/runStrategy.mjs'
import buildBaseUnitNotional from 'w-trade-backtest/src/buildBaseUnitNotional.mjs'
import readStrategies from 'w-trade-solve/src/readStrategies.mjs'
import normalizeCfg, { normalizeUnit, serializableCfg } from '../src/cfg.mjs'
import createPipeline from '../src/createPipeline.mjs'
import { sweepCfgOf } from '../src/sweep/common.mjs'
import makeFastEngine from '../src/solve/fastEngine.mjs'
import sweepSingle from '../src/sweep/sweepSingle.mjs'
import sweepPairs from '../src/sweep/sweepPairs.mjs'
import { makeOtt } from '../src/util/ott.mjs'
import { buildFdTmp, cfgOf } from './tools/synthKit.mjs'


//規格來源: src/cfg.mjs(normalizeUnit、normalizeCfg之settings.unit)、src/sweep/*.mjs、src/solve/*.mjs 之 JSDoc
//  B1 settings.unit為基礎單位{rule,buffer,units}: rule須記asOf與source; 補齊buffer 0.1與units 1(null或未給皆補, 不寫入null); 有效性由回測套件之buildBaseUnitNotional判定(須為一般物件; 錯誤訊息以`invalid <名稱>`起頭、V19格式、不含輸入值V20); 數字字串於檢測通過後轉為數值落地(K4、K7; rule三欄與buffer為Number、units為整數, asOf與source原樣; 轉換前後buildBaseUnitNotional之key相同; 各欄只讀取一次, 檢測之值即使用之值); 給unit時uIni須為有效正數(數字或數字字串, 轉為數值); unit為null視同未給(原樣保留); 未給unit時settings原樣(uIni等不轉型)
//  B2 給unit時普測(sweepSingle/sweepPairs)與求解(solve)之每單名義依基礎單位, 策略檔之settings記錄unit(鍵序: 既有五鍵後接unit)與uIni
//  B3 單一策略不設持倉門檻: 最大持倉名義是否超過uIni不檢、不剔除、不中止, 只隨summary落地; 普測之挑選與求解之入庫不因uIni而變; 回傳、事件與status不帶新鍵
//  B4 未給unit時行為不變: 策略之settings無unit(求解照舊不讀cfg.settings)
//  B2(加速核心) src/solve/fastEngine.mjs: 以策略之settings(含unit)評估, 其摘要與官方runStrategy之對應欄相同


let fdTmp = buildFdTmp('baseUnit')
let n = 500

//ruleT, 交易規則之例(步長0.001、最小數量0.001、最小名義價值20; 合成價格約100 ⇒ 每單名義約22且隨進場價而異)
let ruleT = { stepSize: 0.001, minQty: 0.001, minNotional: 20, asOf: '2026-01-01T00:00:00', source: 'exchangeInfo' }
let unitT = { rule: ruleT, buffer: 0.1, units: 1 }

//unitStrT, 同unitT之數字字串寫法(數字字串收受; 落地須為數值, 與unitT逐位相同)
let unitStrT = { rule: { ...ruleT, stepSize: '0.001', minQty: ' 0.001 ', minNotional: '2e1' }, buffer: '0.1', units: '1' }

//quick, 求解之快速設定(合成數據下門檻放寬)
let quick = {
    thNumTrade: 1,
    thRWin: 0,
    thEqYr: -1e9,
    thsTp: [3, 5],
    thsSl: [3, 5],
    oml: { Np: 6, NContiguous: 3, Ng: 15 },
}

let noTimeTest = (sm) => {
    let { timeTest, ...rest } = sm
    return rest
}

//STATUS_KEYS, 求解器status之鍵(1.0.14; 給unit不加鍵)
let STATUS_KEYS = 'elapsedMs,engine,errors,fdStrategies,nCandidates,nNew,nRounds,nStrategies,nStrategiesStart,state,stopReason,workers'
let ROUND_KEYS = 'candidates,comps,elapsedMs,engine,errors,fdStrategies,mode,nCandidates,nNew,nRounds,nStrategies,nStrategiesStart,state,stopReason,timeEnd,timeStart,workerId,workers'
let keysOf = (o) => Object.keys(o).sort().join(',')


describe('基礎單位(settings.unit)', function() {

    this.timeout(300000)

    let base = null //未給unit之cfg(已建數據、參數與快取)
    let withUnit = (uIni, extra = {}) => normalizeCfg({ ...base, settings: { ...base.settings, uIni, unit: unitT }, ...extra })

    before(async function() {
        let { cfg } = cfgOf(fdTmp, n)
        let pl = createPipeline(cfg)
        await pl.buildOhlc()
        await pl.buildParams({ only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd', 'index_ohlc_close'] })
        await pl.buildCache()
        base = pl.cfg
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    describe('設定', function() {

        it('B1 normalizeUnit: 補齊buffer與units, 其他欄原樣複製, 不改呼叫端物件', function() {
            let inp = { rule: { ...ruleT, note: 'x' }, extra: 1 }
            let u = normalizeUnit(inp)
            assert.deepStrictEqual(u, { rule: { ...ruleT, note: 'x' }, extra: 1, buffer: 0.1, units: 1 }) //B1 補齊
            assert.deepStrictEqual(inp, { rule: { ...ruleT, note: 'x' }, extra: 1 }) //B1 不改呼叫端
            u.rule.minNotional = 99
            assert.strictEqual(inp.rule.minNotional, 20) //B1 為副本
            assert.deepStrictEqual(normalizeUnit({ rule: ruleT, buffer: 0.25, units: 3 }), { rule: ruleT, buffer: 0.25, units: 3 })
        })

        it('B1 normalizeUnit: 非物件、缺asOf或source、數值無效時throw(V19格式; 回測套件之檢測只比對前綴)', function() {
            assert.throws(() => normalizeUnit('x'), (e) => e.message === 'invalid unit: must be an object')
            assert.throws(() => normalizeUnit({}), (e) => e.message === 'invalid unit.rule: must be an object')
            assert.throws(() => normalizeUnit({ rule: null }), (e) => e.message === 'invalid unit.rule: must be an object')
            let { asOf, ...noAsOf } = ruleT
            let { source, ...noSource } = ruleT
            assert.throws(() => normalizeUnit({ rule: noAsOf }), (e) => e.message === 'invalid unit.rule.asOf: must be a non-empty string')
            assert.throws(() => normalizeUnit({ rule: { ...ruleT, asOf: '' } }), (e) => e.message === 'invalid unit.rule.asOf: must be a non-empty string')
            assert.throws(() => normalizeUnit({ rule: { ...ruleT, asOf: 20260101 } }), (e) => e.message === 'invalid unit.rule.asOf: must be a non-empty string')
            assert.throws(() => normalizeUnit({ rule: noSource }), (e) => e.message === 'invalid unit.rule.source: must be a non-empty string')
            assert.throws(() => normalizeUnit({ rule: { ...ruleT, source: null } }), (e) => e.message === 'invalid unit.rule.source: must be a non-empty string')
            class UnitBox {
                constructor() {
                    this.rule = ruleT
                }
            }
            let bads = [
                { rule: { ...ruleT, stepSize: 0 } },
                { rule: { ...ruleT, minNotional: -1 } },
                { rule: { asOf, source, stepSize: 0.001, minQty: 0.001 } },
                { rule: { ...ruleT, stepSize: '0x10' } },
                { rule: { ...ruleT, minQty: Infinity } },
                { rule: { ...ruleT, minNotional: '' } },
                { rule: ruleT, buffer: -0.1 },
                { rule: ruleT, buffer: true },
                { rule: ruleT, units: 1.5 },
                { rule: ruleT, units: 0 },
                new UnitBox(), //類別實例非一般物件
            ]
            for (let bad of bads) {
                assert.throws(() => normalizeUnit(bad, 'cfg.settings.unit'), /^Error: invalid cfg\.settings\.unit[.:]/, JSON.stringify(bad)) //B1 由回測套件之buildBaseUnitNotional判定, 只比對前綴
            }
        })

        it('B1/V20 normalizeUnit之錯誤訊息不含輸入值(以辨識字串與數字為值)', function() {
            let secret = 'ZZ-secret-9731'
            let cases = [
                { rule: { ...ruleT, stepSize: secret } },
                { rule: { ...ruleT, minQty: secret } },
                { rule: { ...ruleT, minNotional: secret } },
                { rule: ruleT, buffer: secret },
                { rule: ruleT, units: secret },
                { rule: { ...ruleT, asOf: 9731011 } },
                { rule: { ...ruleT, source: 9731012 } },
                { rule: secret },
                secret,
            ]
            for (let c of cases) {
                assert.throws(() => normalizeUnit(c, 'cfg.settings.unit'), (e) => /^invalid cfg\.settings\.unit[.:]/.test(e.message) && /: must be /.test(e.message) && !e.message.includes('ZZ-secret') && !e.message.includes('9731'), JSON.stringify(c)) //V19格式且不含值
            }
        })

        it('B1/K4 normalizeUnit: buffer與units為null時補預設(不寫入null); 數字字串轉為數值(asOf、source原樣); 回傳為一般物件(含null原型之輸入)', function() {
            assert.deepStrictEqual(normalizeUnit({ rule: ruleT, buffer: null, units: null }), { rule: ruleT, buffer: 0.1, units: 1 }) //B1 null補預設
            let recS = { asOf: ' 2026-01-01T00:00:00 ', source: ' 20 ', note: '1' } //記錄欄(含看似數字與帶空白者)原樣
            let ruleS = { ...recS, stepSize: '0.001', minQty: ' 0.001 ', minNotional: '2e1' }
            let inpS = { rule: ruleS, buffer: '0.2', units: '2' }
            let u = normalizeUnit(inpS)
            assert.deepStrictEqual(u, { rule: { ...recS, stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.2, units: 2 }) //K4 數字字串轉為數值落地
            assert.deepStrictEqual([u.rule.stepSize, u.rule.minQty, u.rule.minNotional, u.buffer, u.units].map((v) => typeof v), ['number', 'number', 'number', 'number', 'number'])
            assert.deepStrictEqual([u.rule.asOf, u.rule.source, u.rule.note], [recS.asOf, recS.source, recS.note]) //asOf、source與其他欄原樣(不轉型、不去空白)
            assert.deepStrictEqual(inpS, { rule: { ...recS, stepSize: '0.001', minQty: ' 0.001 ', minNotional: '2e1' }, buffer: '0.2', units: '2' }) //不改呼叫端
            let np = Object.create(null)
            np.rule = ruleT
            let un = normalizeUnit(np)
            assert.strictEqual(Object.getPrototypeOf(un), Object.prototype)
            assert.deepStrictEqual(un, { rule: ruleT, buffer: 0.1, units: 1 })
            assert.deepStrictEqual(normalizeCfg({ ...base, settings: { uIni: 10000, unit: { rule: ruleT, buffer: null, units: null } } }).settings.unit, unitT) //B1 cfg亦不寫入null
            assert.deepStrictEqual(normalizeCfg({ ...base, settings: { uIni: 10000, unit: inpS } }).settings.unit, u) //K4 cfg亦轉為數值
            assert.strictEqual(inpS.rule.stepSize, '0.001') //不改呼叫端
        })

        it('B1/K4 normalizeUnit: 轉換前後buildBaseUnitNotional之key與各價位之每單名義皆相同(不偏離回測套件之解析)', function() {
            let forms = {
                stepSize: ['0.001', ' 0.001 ', '1e-3', '+0.001', '.001', 0.001],
                minQty: ['0.001', ' 0.001 ', '1e-3', '+0.001', '.001', 0.001],
                minNotional: ['20', ' 20 ', '2e1', '20.0', '+20', 20],
                buffer: ['0.1', '.1', '1e-1', ' 0.1 ', 0.1, '0', 0, '+0.25', null, undefined],
                units: ['3', ' 3 ', '3.0', '3e0', '+3', 3, null, undefined, '1e1'],
            }
            let n = 0
            for (let [field, vs] of Object.entries(forms)) {
                for (let v of vs) {
                    let raw = field === 'buffer' || field === 'units' ? { rule: ruleT, [field]: v } : { rule: { ...ruleT, [field]: v } }
                    let u = normalizeUnit(raw)
                    let b = buildBaseUnitNotional(raw)
                    let a = buildBaseUnitNotional(u)
                    assert.strictEqual(a.key, b.key, `${field}=${JSON.stringify(v)}`) //K4 key相同
                    for (let price of [99.37, 100.5, 2000.123, 1]) {
                        assert.strictEqual(a.getNotional(price), b.getNotional(price), `${field}=${JSON.stringify(v)} @${price}`)
                    }
                    assert.deepStrictEqual([u.rule.stepSize, u.rule.minQty, u.rule.minNotional, u.buffer, u.units].map((x) => typeof x), ['number', 'number', 'number', 'number', 'number'])
                    assert.ok(Number.isInteger(u.units))
                    n++
                }
            }
            assert.ok(n >= 35, `鑑別前提: 形式數 ${n}`)
        })

        it('B1/K4 normalizeUnit: 各欄只讀取一次(檢測之值即使用之值): getter於第2次起回無效值, 結果仍為第1次之值', function() {
            let reads = {}
            let acc = (obj, k, vals) => {
                reads[k] = 0
                Object.defineProperty(obj, k, {
                    enumerable: true,
                    configurable: true,
                    get() {
                        reads[k]++
                        return vals[Math.min(reads[k] - 1, vals.length - 1)]
                    },
                })
            }
            let rule = { asOf: ruleT.asOf, source: ruleT.source }
            acc(rule, 'stepSize', ['0.001', 'bad'])
            acc(rule, 'minQty', ['0.001', -1])
            acc(rule, 'minNotional', ['20', 'x'])
            let unit = {}
            acc(unit, 'rule', [rule, null])
            acc(unit, 'buffer', ['0.2', -5])
            acc(unit, 'units', ['2', 0])
            let u = normalizeUnit(unit)
            assert.deepStrictEqual(u, { rule: { asOf: ruleT.asOf, source: ruleT.source, stepSize: 0.001, minQty: 0.001, minNotional: 20 }, buffer: 0.2, units: 2 }) //K4 用第1次之值
            for (let [k, v] of Object.entries(reads)) {
                assert.ok(v <= 1, `${k} 讀取 ${v} 次`)
            }
        })

        it('B1 normalizeCfg: settings.unit正規化、給unit時uIni須為有效正數(數字字串轉為數值)、unit為null視同未給、可重入', function() {
            let c = withUnit(10000)
            assert.deepStrictEqual(c.settings, { uIni: 10000, uTrade: 1, rFee: 0.0005, unit: unitT })
            assert.deepStrictEqual(normalizeCfg(c).settings, c.settings) //B1 可重入
            assert.deepStrictEqual(serializableCfg(c).settings, c.settings)
            for (let uIni of [0, -1, NaN, Infinity, '', ' ', '10000x', '0x10', '-5', '0', true, null, {}, [], undefined]) {
                assert.throws(() => normalizeCfg({ ...base, settings: { uIni, unit: unitT } }), (e) => e.message === 'invalid cfg.settings.uIni: must be a positive number', String(uIni)) //V19、不含輸入值
            }
            for (let uIni of ['10000', ' 1e4 ', '10000.0', '+10000']) {
                let cs = normalizeCfg({ ...base, settings: { uIni, unit: unitT } })
                assert.strictEqual(cs.settings.uIni, 10000, JSON.stringify(uIni)) //K4 數字字串轉為數值
            }
            assert.strictEqual(normalizeCfg({ ...base, settings: { uIni: '0.5', unit: unitT } }).settings.uIni, 0.5) //uIni不限整數
            assert.strictEqual(normalizeCfg({ ...base, settings: { uIni: 'abc' } }).settings.uIni, 'abc') //B4 未給unit時settings原樣(不轉型、不檢測)
            assert.throws(() => normalizeCfg({ ...base, settings: { unit: { rule: ruleT, units: 0 } } }), /^Error: invalid cfg\.settings\.unit[.:]/)
            let c0 = normalizeCfg({ ...base, settings: { unit: null } })
            assert.deepStrictEqual(c0.settings, { uIni: 1000, uTrade: 1, rFee: 0.0005, unit: null }) //B1 null原樣保留(同既有)
            assert.strictEqual('unit' in sweepCfgOf(c0), false) //B1 null視同未給
        })

        it('B2/B4 sweepCfgOf: 給unit時含unit鍵, 未給時無此鍵', function() {
            assert.deepStrictEqual(sweepCfgOf(withUnit(10000)).unit, unitT)
            assert.strictEqual('unit' in sweepCfgOf(base), false) //B4
        })

    })

    describe('普測', function() {

        let fdP1 = null
        let r1 = null

        //oracleSingle, 以同一回測函數(ordersFromBars、calcOrdersSummarySimple)重建之接線檢查(非獨立計算): 依單因子策略檔之條件以快取重建訂單並算摘要(訓練窗與出場裁切同普測), 驗普測確把unit等設定傳入回測函數
        let oracleSingle = async (c, s) => {
            let sc = sweepCfgOf(c)
            let tbl = loadKLinesTpSl(sc.fpCache)
            let arr = await dataProvide(c.fds.ohlc, c.fds.param).getTimeSeriesByTimeRange(s.conds[0].key, sc.tr.ts, sc.tr.te)
            let cd = s.conds[0]
            let ent = arr.filter((r) => isnum(r.param) && (cd.sym === '>' ? r.param > cd.th : r.param < cd.th)).map((r) => r.time)
            let opt = { uTrade: sc.uTrade, uIni: sc.uIni, rFee: sc.rFee, maxExitTime: sc.exitCut }
            if (sc.unit) {
                opt.unit = sc.unit
            }
            let orders = tbl.ordersFromBars(s.mode, Math.round(s.settings.rTakeProfit * 100), ent, opt)
            return { orders, summary: calcOrdersSummarySimple(makeOtt(c.timeZone), sc.uIni, orders, sc.tr.ts, sc.tr.te) }
        }

        //picksOf, 策略檔之識別(檔名、條件、止盈止損)與與本金無關之摘要欄
        let picksOf = (fd) => readStrategies(fd, { readContent: true }).map((x) => JSON.stringify([x.name, x.data.conds, x.data.settings.rTakeProfit, x.data.summary.numTradeFin, x.data.summary.rWin, x.data.summary.uTradeAllMax, x.data.summary.rEquivalentCumuProfitOrLossFinalNormYear]))

        before(async function() {
            fdP1 = path.resolve(fdTmp, 'p1u')
            r1 = await sweepSingle(withUnit(10000), { fdTar: fdP1, numTradeFinMin: 3, limit: 10, takeLimit: 2 })
        })

        it('B2 sweepSingle: 策略檔之settings記錄uIni與unit(鍵序既有五鍵後接unit), 摘要依基礎單位(與以快取重建者相同, 各單名義相異且不低於門檻)', async function() {
            let ss = readStrategies(fdP1, { readContent: true })
            assert.ok(ss.length > 0 && ss.length === r1.nOut)
            let nDiff = 0
            for (let x of ss) {
                let s = x.data
                assert.deepStrictEqual(Object.keys(s.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee', 'unit']) //B2 鍵序
                assert.strictEqual(s.settings.uIni, 10000)
                assert.deepStrictEqual(s.settings.unit, unitT) //B2 記錄交易規則與緩衝
                let o = await oracleSingle(withUnit(10000), s)
                assert.deepStrictEqual(s.summary, o.summary) //B2 摘要依基礎單位
                let us = o.orders.map((v) => v.uTrade)
                assert.ok(us.every((u) => u >= 22), '每單名義不低於最小名義價值×1.1')
                if (new Set(us).size >= 2) {
                    nDiff++
                }
            }
            assert.ok(nDiff >= 1, `鑑別前提: 至少一隻之各單名義相異, 實得 ${nDiff}`)
            assert.deepStrictEqual(Object.keys(r1), ['nFactors', 'nOut', 'fdTar', 'elapsedMs']) //B3 回傳不帶新鍵
        })

        it('B3 sweepSingle: 研究用本金30(小於多數策略之最大持倉名義)時挑出之策略與本金10000者相同(不剔除), 進度與回傳不帶新鍵', async function() {
            let big = readStrategies(fdP1, { readContent: true }).filter((x) => x.data.summary.uTradeAllMax > 30)
            assert.ok(big.length > 0, '鑑別前提: 有最大持倉名義大於30之策略')
            let prog = []
            let fdTar = path.resolve(fdTmp, 'p1u-30')
            let r = await sweepSingle(withUnit(30), { fdTar, numTradeFinMin: 3, limit: 10, takeLimit: 2, onProgress: (p) => prog.push(p) })
            assert.strictEqual(r.nOut, r1.nOut)
            assert.deepStrictEqual(picksOf(fdTar), picksOf(fdP1)) //B3 不剔除、挑選不因uIni而變
            assert.deepStrictEqual(Object.keys(r), ['nFactors', 'nOut', 'fdTar', 'elapsedMs'])
            assert.ok(prog.every((p) => keysOf(p) === 'elapsedMs,i,n,nOut'))
        })

        it('B2/K4 sweepSingle: cfg之unit與uIni給數字字串時, 策略檔與給數值者逐位相同(落地皆為數值)', async function() {
            let cs = normalizeCfg({ ...base, settings: { ...base.settings, uIni: '10000', unit: unitStrT } })
            let fdTar = path.resolve(fdTmp, 'p1s')
            await sweepSingle(cs, { fdTar, numTradeFinMin: 3, limit: 10, takeLimit: 2 })
            let bytesOf = (fd) => Object.fromEntries(fs.readdirSync(fd).sort().map((f) => [f, fs.readFileSync(path.resolve(fd, f), 'utf8')]))
            let a = bytesOf(fdTar)
            assert.ok(Object.keys(a).length > 0)
            assert.deepStrictEqual(a, bytesOf(fdP1)) //K4 與數值寫法逐位相同
            let s = JSON.parse(Object.values(a)[0])
            assert.deepStrictEqual(s.settings.unit, unitT)
            assert.strictEqual(s.settings.uIni, 10000)
            assert.strictEqual(typeof s.settings.unit.rule.stepSize, 'number')
        })

        it('B4 sweepSingle: 未給unit時策略之settings無unit', async function() {
            let fdTar = path.resolve(fdTmp, 'p1n')
            await sweepSingle(base, { fdTar, numTradeFinMin: 3, limit: 4, takeLimit: 2 })
            let ss = readStrategies(fdTar, { readContent: true })
            assert.ok(ss.length > 0)
            assert.ok(ss.every((x) => Object.keys(x.data.settings).join() === 'uIni,uTrade,rTakeProfit,rStopLoss,rFee'))
        })

        it('B2/B3 sweepPairs: 給unit時settings記錄unit; 研究用本金30與10000之輸出相同(不剔除), 回傳不帶新鍵', async function() {
            let fdA = path.resolve(fdTmp, 'p2u')
            let a = await sweepPairs(withUnit(10000), { fdF1: fdP1, fdTar: fdA, numTradeFinMin: 3, eqYrMin: -1e9, limit: 4, takeLimit: 2 })
            let sa = readStrategies(fdA, { readContent: true })
            assert.ok(a.nOut > 0 && sa.length > 0)
            assert.ok(sa.every((x) => x.data.settings.uIni === 10000 && JSON.stringify(x.data.settings.unit) === JSON.stringify(unitT))) //B2
            assert.ok(sa.every((x) => x.data.summary.uTradeAllMax >= 22))
            assert.ok(sa.some((x) => x.data.summary.uTradeAllMax > 30), '鑑別前提: 有最大持倉名義大於30者')
            let fdB = path.resolve(fdTmp, 'p2u-30')
            let b = await sweepPairs(withUnit(30), { fdF1: fdP1, fdTar: fdB, numTradeFinMin: 3, eqYrMin: -1e9, limit: 4, takeLimit: 2 })
            assert.strictEqual(b.nOut, a.nOut)
            let idOf = (fd) => readStrategies(fd, { readContent: true }).map((x) => JSON.stringify([x.name, x.data.conds, x.data.summary.uTradeAllMax, x.data.summary.rEquivalentCumuProfitOrLossFinalNormYear]))
            assert.deepStrictEqual(idOf(fdB), idOf(fdA)) //B3 不剔除
            assert.deepStrictEqual(Object.keys(b), ['nJobs', 'nOut', 'nDrop', 'fdTar', 'elapsedMs'])
            //K4 cfg之unit與uIni給數字字串時, 輸出與給數值者逐位相同(落地皆為數值)
            let fdS = path.resolve(fdTmp, 'p2s')
            await sweepPairs(normalizeCfg({ ...base, settings: { ...base.settings, uIni: '10000', unit: unitStrT } }), { fdF1: fdP1, fdTar: fdS, numTradeFinMin: 3, eqYrMin: -1e9, limit: 4, takeLimit: 2 })
            let bytesOf = (fd) => Object.fromEntries(fs.readdirSync(fd).sort().map((f) => [f, fs.readFileSync(path.resolve(fd, f), 'utf8')]))
            assert.deepStrictEqual(bytesOf(fdS), bytesOf(fdA))
        })

    })

    describe('求解', function() {

        let replay = async (c, s) => {
            let fgs = await dataProvide(c.fds.ohlc, c.fds.param).buildGetTimeSeriesByTimeRange(s.solve.timeStart, s.solve.timeEnd)
            return runStrategy(makeOtt(c.timeZone), s, fgs)
        }

        it('B2 in-process: 策略檔之settings記錄uIni與unit, 摘要依基礎單位(以檔內settings重放相同); status與onRound不帶新鍵', async function() {
            let c = withUnit(10000, { fds: { ...base.fds, strategies: path.resolve(fdTmp, 'libU') } })
            let pl = createPipeline(c)
            let rounds = []
            let st = await pl.solve({ ...quick, maxRounds: 2, onRound: (ev) => rounds.push(ev) })
            let ss = pl.readStrategies(null, { readContent: true })
            assert.ok(ss.length > 0)
            for (let x of ss) {
                let s = x.data
                assert.deepStrictEqual(Object.keys(s.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee', 'unit']) //B2
                assert.strictEqual(s.settings.uIni, 10000)
                assert.deepStrictEqual(s.settings.unit, unitT)
                let r = await replay(c, s)
                assert.deepStrictEqual(noTimeTest(r.summary), noTimeTest(s.summary)) //B2 摘要依settings.unit
                assert.ok(s.summary.uTradeAllMax >= 22)
            }
            assert.strictEqual(keysOf(st), STATUS_KEYS) //B3 不帶新鍵
            assert.ok(rounds.length === 2 && rounds.every((ev) => keysOf(ev) === ROUND_KEYS))
        })

        it('B2/K4 in-process: cfg之unit與uIni給數字字串時, 策略檔之settings.uIni與unit為數值(同數值寫法), 摘要依基礎單位', async function() {
            let c = normalizeCfg({ ...base, settings: { ...base.settings, uIni: '10000', unit: unitStrT }, fds: { ...base.fds, strategies: path.resolve(fdTmp, 'libS') } })
            let pl = createPipeline(c)
            await pl.solve({ ...quick, maxRounds: 2 })
            let ss = pl.readStrategies(null, { readContent: true })
            assert.ok(ss.length > 0)
            for (let x of ss) {
                let s = x.data
                assert.deepStrictEqual(Object.keys(s.settings), ['uIni', 'uTrade', 'rTakeProfit', 'rStopLoss', 'rFee', 'unit'])
                assert.strictEqual(s.settings.uIni, 10000) //K4 數值
                assert.deepStrictEqual(s.settings.unit, unitT) //K4 rule三欄、buffer、units為數值
                let r = await replay(c, s)
                assert.deepStrictEqual(noTimeTest(r.summary), noTimeTest(s.summary))
            }
        })

        it('B2 加速核心(makeFastEngine): 同一含unit之策略, 其摘要與runStrategy之對應欄相同; 拿掉unit即不同(證加速核心依settings評估)', async function() {
            //本案自建策略庫(不依賴他案)
            let c = withUnit(10000, { fds: { ...base.fds, strategies: path.resolve(fdTmp, 'libFast') } })
            await createPipeline(c).solve({ ...quick, maxRounds: 2 })
            let ss = readStrategies(path.resolve(fdTmp, 'libFast'), { readContent: true })
            assert.ok(ss.length > 0, '前提: 有含unit之策略')
            let ott = makeOtt(c.timeZone)
            let nCmp = 0
            for (let x of ss) {
                let s = x.data
                let fgs = await dataProvide(c.fds.ohlc, c.fds.param).buildGetTimeSeriesByTimeRange(s.solve.timeStart, s.solve.timeEnd)
                let fast = makeFastEngine()
                let rf = await fast({ ott, strategy: s, funGetSeries: fgs })
                let ro = await runStrategy(ott, s, fgs)
                let ks = Object.keys(rf.summary).filter((k) => k !== 'timeTest' && Object.prototype.hasOwnProperty.call(ro.summary, k))
                assert.ok(ks.includes('uTradeAllMax') && ks.includes('rEquivalentCumuProfitOrLossFinalNormYear') && ks.includes('numTrade'), `對應欄: ${ks.join(',')}`)
                for (let k of ks) {
                    assert.deepStrictEqual(rf.summary[k], ro.summary[k], `${x.name} ${k}`) //B2 加速核心依unit評估
                }
                let { unit, ...settingsNoUnit } = s.settings
                let rn = await makeFastEngine()({ ott, strategy: { ...s, settings: settingsNoUnit }, funGetSeries: fgs })
                assert.notStrictEqual(rn.summary.uTradeAllMax, rf.summary.uTradeAllMax, '鑑別: 未帶unit時每單名義為固定金額')
                nCmp++
            }
            assert.ok(nCmp > 0)
        })

        it('B3 in-process: uIni 1(小於任一單之名義)時照常入庫且算候選, 不中止', async function() {
            let c = withUnit(1, { fds: { ...base.fds, strategies: path.resolve(fdTmp, 'libTiny') } })
            let pl = createPipeline(c)
            let cands = []
            let st = await pl.solve({ ...quick, maxRounds: 2, onCandidate: (ev) => cands.push(ev) })
            assert.strictEqual(st.stopReason, 'maxRounds') //B3 不中止
            assert.ok(st.nStrategies > 0) //B3 不剔除
            assert.ok(cands.length > 0)
            let ss = pl.readStrategies(null, { readContent: true })
            assert.ok(ss.every((x) => x.data.summary.uTradeAllMax > 1 && x.data.settings.uIni === 1), '前提: 最大持倉名義皆大於uIni')
            assert.ok(cands.some((ev) => ev.summary.uTradeAllMax > 1))
        })

        it('B2 workers 1: worker內之求解同樣以unit落地', async function() {
            let c = withUnit(10000, { fds: { ...base.fds, strategies: path.resolve(fdTmp, 'libW') } })
            let pl = createPipeline(c)
            let st = await pl.solve({ ...quick, workers: 1, maxRounds: 1 })
            assert.deepStrictEqual(st.errors, [])
            let ss = pl.readStrategies(null, { readContent: true })
            assert.ok(ss.length > 0)
            assert.ok(ss.every((x) => JSON.stringify(x.data.settings.unit) === JSON.stringify(unitT) && x.data.settings.uIni === 10000)) //B2
        })

        it('B4: 未給unit時策略之settings無unit且uIni為1000(求解不讀cfg.settings, 同既有)', async function() {
            let c = normalizeCfg({ ...base, settings: { uIni: 10000 }, fds: { ...base.fds, strategies: path.resolve(fdTmp, 'libN') } })
            let pl = createPipeline(c)
            let rounds = []
            let st = await pl.solve({ ...quick, maxRounds: 1, onRound: (ev) => rounds.push(ev) })
            assert.strictEqual(keysOf(st), STATUS_KEYS)
            let ss = pl.readStrategies(null, { readContent: true })
            assert.ok(ss.length > 0)
            assert.ok(ss.every((x) => Object.keys(x.data.settings).join() === 'uIni,uTrade,rTakeProfit,rStopLoss,rFee' && x.data.settings.uIni === 1000)) //B4
        })

    })

})
