import assert from 'assert'
import fs from 'fs'
import path from 'path'
import normalizeCfg from '../src/cfg.mjs'
import buildOhlc from '../src/data/buildOhlc.mjs'
import buildParams, { nmKeyOf } from '../src/params/buildParams.mjs'
import CATALOG from '../src/params/catalog.mjs'
import { buildFdTmp, cfgOf, genArrPrice } from './tools/synthKit.mjs'


//規格來源: src/params/buildParams.mjs、src/params/catalog.mjs
//  內建目錄34個定義(price 20、index 14), 輸出key命名`${cointpe}_${keyKind}_${keyIn}_${keyOut}_${method}_${period}`
//  過濾: useIndex false剔除index定義; 數據缺fields欄位者剔除; only/exclude
//  nm由nmPeriod(預設train)自算並凍結於meta/params.json, 再次呼叫沿用; recalibrate重算
//  index側optMethod校正結果凍結於meta.optMethod
//  extraDefs+calcs可擴充自訂method; series直接寫入


let fdTmp = buildFdTmp('buildParams')
let n = 500 //500根4hr=83天, 涵蓋30day(180根)週期


describe('buildParams', function() {

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('內建目錄: price 20個、index 14個定義, 136個輸出', function() {
        assert.strictEqual(CATALOG.length, 34)
        assert.strictEqual(CATALOG.filter((d) => d.cointpe === 'price').length, 20)
        assert.strictEqual(CATALOG.filter((d) => d.cointpe === 'index').length, 14)
        let nDeals = 0
        for (let d of CATALOG) {
            for (let m of d.methods) {
                nDeals += m.deals.length
            }
        }
        assert.strictEqual(nDeals, 136)
        let vbs = CATALOG.find((d) => d.id === 'price_vbs')
        assert.strictEqual(typeof vbs.funAddKeysIn, 'function')
        assert.deepStrictEqual(vbs.fields, ['Volumn', 'TakerBuyBaseAssetVolume'])
    })

    it('only子集: key命名與檔數, nm凍結於meta且第二次沿用', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'r1') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['price_ohlc_close', 'price_ohlc_rsi', 'index_ohlc_close'] })
        assert.deepStrictEqual(r.defs.sort(), ['index_ohlc_close', 'price_ohlc_close', 'price_ohlc_rsi'])
        //price_ohlc_close: maNorm/emaNorm/vecNorm × 6期 = 18; price_ohlc_rsi: 5 keyOut × 期數; index_ohlc_close: orig(1期)+ma/ema/vec(各6期)
        assert.ok(r.keys.includes('price_ohlc_Close_param_maNorm_1day'), r.keys.join(','))
        assert.ok(r.keys.includes('index_ohlc_Close_param_orig_4hr') || r.keys.some((k) => k.startsWith('index_ohlc_Close_param_orig_')), r.keys.filter((k) => k.startsWith('index_')).join(','))
        assert.ok(r.keys.some((k) => k.startsWith('price_ohlc_none_RSI_rsi_')))
        assert.ok(r.dropped.length === 31)
        //序列檔內容為[{time,param}]且param為z-score
        let arr = JSON.parse(fs.readFileSync(path.resolve(c.fds.param, 'price_ohlc_Close_param_maNorm_1day.json'), 'utf8'))
        assert.ok(arr.length > 100)
        assert.ok(typeof arr[0].time === 'string' && typeof arr[0].param === 'number')
        //meta
        let meta = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        let nk = nmKeyOf({ id: 'price_ohlc_rsi' }, 'rsi', 'none', 'RSI')
        assert.ok(meta.nm[nk], `meta.nm缺${nk}`)
        assert.ok(Math.abs(meta.nm[nk].avg - 50) < 15, `RSI均值應近50, 實得${meta.nm[nk].avg}`)
        assert.deepStrictEqual(meta.nmPeriod, { timeStart: c.train.timeStart, timeEnd: c.train.timeEnd })
        assert.ok(r.nmComputed > 0)
        //第二次(nmPeriod改成前半段)仍沿用凍結之nm
        let half = { timeStart: c.train.timeStart, timeEnd: '2023-02-01T00:00:00' }
        let r2 = await buildParams(c, { only: ['price_ohlc_rsi'], nmPeriod: half })
        let meta2 = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        assert.strictEqual(meta2.nm[nk].avg, meta.nm[nk].avg)
        assert.strictEqual(r2.nmComputed, 0)
        assert.deepStrictEqual(meta2.nmPeriod, meta.nmPeriod)
        //recalibrate: 以前半段重算 → nm值改變
        let r3 = await buildParams(c, { only: ['price_ohlc_rsi'], nmPeriod: half, recalibrate: true })
        let meta3 = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        assert.ok(r3.nmComputed > 0)
        assert.notStrictEqual(meta3.nm[nk].avg, meta.nm[nk].avg)
        assert.deepStrictEqual(meta3.nmPeriod, half)
    })

    it('useIndex false剔除index定義; 數據缺成交量欄位時剔除依賴之定義', async function() {
        this.timeout(120000)
        let arrP = genArrPrice(n).map((v) => ({ time: v.time, Open: v.Open, High: v.High, Low: v.Low, Close: v.Close })) //僅OHLC(股價型)
        let cfg = {
            root: path.resolve(fdTmp, 'r2'),
            name: 'STK',
            symbol: 'STK',
            interval: '4hr',
            timeZone: 'UTC',
            timeBegin: arrP[0].time,
            source: { price: arrP },
            train: { timeStart: arrP[0].time, timeEnd: arrP[n - 1].time },
        }
        let c = normalizeCfg(cfg)
        assert.strictEqual(c.useIndex, false)
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['price_ohlc_close', 'price_ohlc_mfi', 'price_vbs', 'price_ohlc_cvd', 'price_ohlc_ats', 'index_ohlc_close', 'index_ohlc_rsi'] })
        assert.deepStrictEqual(r.defs, ['price_ohlc_close'])
        let reasons = {}
        for (let d of r.dropped) {
            reasons[d.id] = d.reason
        }
        assert.match(reasons.index_ohlc_close, /useIndex/)
        assert.match(reasons.price_ohlc_mfi, /Volumn/)
        assert.match(reasons.price_vbs, /Volumn/)
        assert.match(reasons.price_ohlc_cvd, /TakerBuyBaseAssetVolume/)
        assert.match(reasons.price_ohlc_ats, /QuoteAssetVolume/)
        assert.ok(r.keys.every((k) => k.startsWith('price_ohlc_Close_')))
    })

    it('index側optMethod校正結果凍結於meta; calibrateIndex false時採定義值', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'r3') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['index_ohlc_klr', 'price_ohlc_klr'] })
        assert.strictEqual(r.calibrated.length, 1)
        assert.strictEqual(r.calibrated[0].id, 'index_ohlc_klr')
        assert.deepStrictEqual(r.calibrated[0].optMethodInit, { plusClose: 0.5 })
        let meta = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        assert.ok(meta.optMethod['index_ohlc_klr:klr'])
        assert.ok(r.keys.some((k) => k.startsWith('index_ohlc_none_ho_klr_')))
        //另一root不校正
        let { cfg: cfg2 } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'r4') })
        let c2 = normalizeCfg(cfg2)
        await buildOhlc(c2)
        let r2 = await buildParams(c2, { only: ['index_ohlc_klr'], calibrateIndex: false })
        assert.strictEqual(r2.calibrated.length, 0)
        let meta2 = JSON.parse(fs.readFileSync(path.resolve(c2.fds.meta, 'params.json'), 'utf8'))
        assert.deepStrictEqual(meta2.optMethod['index_ohlc_klr:klr'], { plusClose: 0.5 })
    })

    it('extraDefs+calcs自訂method; series直接寫入; 定義自帶nm直接採用', async function() {
        this.timeout(120000)
        let { cfg, arrP } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'r5') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        //自訂method: 收盤價之對數報酬, 單一期'1bar'
        let calcLogRet = async (arr, keyIn, optMethod = {}) => {
            let vs = []
            for (let i = 1; i < arr.length; i++) {
                vs.push({ time: arr[i].time, lr: Math.log(arr[i].Close / arr[i - 1].Close) })
            }
            return [{ period: '1bar', len: 1, vs }]
        }
        let extraDefs = [{
            id: 'price_ohlc_logret',
            cointpe: 'price',
            keyKind: 'ohlc',
            fields: ['Close'],
            keysIn: [],
            methods: [{ method: 'logret', deals: [{ keyOut: 'lr' }] }],
        }, {
            id: 'price_ohlc_fixednm',
            cointpe: 'price',
            keyKind: 'ohlc',
            fields: ['Close'],
            keysIn: ['Close'],
            methods: [{ method: 'ma', deals: [{ keyOut: 'param', nm: { avg: 100, std: 10 } }] }],
        }]
        let series = {
            ext_signal: arrP.map((v, i) => ({ time: v.time, param: i % 2 })),
        }
        let r = await buildParams(c, { only: [], extraDefs, calcs: { logret: calcLogRet }, series })
        assert.ok(r.keys.includes('price_ohlc_none_lr_logret_1bar'), r.keys.join(','))
        assert.ok(r.keys.includes('ext_signal'))
        assert.ok(r.keys.includes('price_ohlc_Close_param_ma_1day'))
        let meta = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        assert.deepStrictEqual(meta.nm[nmKeyOf({ id: 'price_ohlc_fixednm' }, 'ma', 'Close', 'param')], { avg: 100, std: 10 })
        assert.deepStrictEqual(meta.seriesKeys, ['ext_signal'])
        //自訂method未提供計算函數時throw
        await assert.rejects(buildParams(c, { only: [], extraDefs: [extraDefs[0]] }), /無對應之計算函數/)
    })

    it('1hr K線: 各calc之週期表依barsPerDay換算, 週期標籤不變(1day於1hr為24根)而單根型態標籤為1hr', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, 1200, { root: path.resolve(fdTmp, 'r7'), interval: '1hr', stepMs: 3600 * 1000 })
        let c = normalizeCfg(cfg)
        assert.strictEqual(c.barsPerDay, 24)
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['price_ohlc_close', 'price_ohlc_candle', 'price_ohlc_rsi'] })
        assert.ok(r.keys.includes('price_ohlc_Close_param_maNorm_1day'), r.keys.join(','))
        assert.ok(r.keys.includes('price_ohlc_none_bodyRatio_candle_1hr'), r.keys.filter((k) => k.includes('candle')).join(','))
        assert.ok(!r.keys.some((k) => k.endsWith('_candle_4hr')))
        //1day均線於1hr K線為24根 → 第1筆於第24根(索引23)
        let arr = JSON.parse(fs.readFileSync(path.resolve(c.fds.param, 'price_ohlc_Close_param_maNorm_1day.json'), 'utf8'))
        assert.strictEqual(arr.length, 1200 - 23)
        assert.strictEqual(arr[0].time, '2023-01-01T23:00:00')
        //對照: 同數據以4hr設定(錯誤週期)計算時1day只取6根
        let { cfg: cfg4 } = cfgOf(fdTmp, 1200, { root: path.resolve(fdTmp, 'r8'), stepMs: 3600 * 1000 })
        let c4 = normalizeCfg(cfg4)
        await buildOhlc(c4)
        let r4 = await buildParams(c4, { only: ['price_ohlc_close'] })
        let arr4 = JSON.parse(fs.readFileSync(path.resolve(c4.fds.param, 'price_ohlc_Close_param_maNorm_1day.json'), 'utf8'))
        assert.strictEqual(arr4.length, 1200 - 5)
        assert.ok(r4.nKeys > 0)
    })

    it('尚無K線序列時throw', async function() {
        let { cfg } = cfgOf(fdTmp, 50, { root: path.resolve(fdTmp, 'r6') })
        await assert.rejects(buildParams(normalizeCfg(cfg)), /buildOhlc/)
    })

})
