import assert from 'assert'
import fs from 'fs'
import path from 'path'
import normalizeCfg from '../src/cfg.mjs'
import buildOhlc from '../src/data/buildOhlc.mjs'
import buildParams, { buildKp, nmKeyOf } from '../src/params/buildParams.mjs'
import CATALOG from '../src/params/catalog.mjs'
import wdt from 'w-data-trade/src/WDataTrade.mjs'
import { buildFdTmp, cfgOf, genArrPrice } from './tools/synthKit.mjs'


//規格來源: src/params/buildParams.mjs、src/params/catalog.mjs
//  內建目錄35個定義(price 21、index 14; 含方向改變法price_ohlc_dirchange), 輸出key命名`${cointpe}_${keyKind}_${keyIn}_${keyOut}_${method}_${period}`
//  方向改變法(method dirChange, w-data-trade calcDirChange): 只在價格側; 4個輸出 × 4個門檻(4、6、8、10%) = 16鍵; 期別段為門檻標籤`${門檻}pct`, 不隨K線週期改變; nm同其他定義(凍結, 新定義於既有工作根以凍結之nm期間自算, 不須recalibrate)
//  K線週期(根數為本; w-data-trade >= 1.0.50): 各calc內建週期表之值為根數, 標籤以每根4hr寫定(label = 根數 × 4hr); 給opt.intervalSec(每根秒數)時根數不變、標籤改為 根數 × 每根秒數
//    maNorm等之根數 6、12、24、42、90、180: 4hr為 1day、2day、4day、7day、15day、30day; 1hr為 6hr、12hr、1day、42hr、90hr、180hr; 1day為 6day、12day、24day、42day、90day、180day
//    rsi之根數 3、4、5、6、12、24、42: 4hr為 12hr、16hr、20hr、1day、2day、4day、7day; 1hr為 3hr、4hr、5hr、6hr、12hr、1day、42hr; 1day為 3day、4day、5day、6day、12day、24day、42day
//    單根型態(candle)之標籤為該週期本身(1hr、1day)
//    標籤規則: 時間跨度為整日數者寫Nday, 否則整小時數者寫Nhr; 第1筆輸出於第 根數 根(索引 根數-1)
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

    it('內建目錄: price 21個、index 14個定義, 140個輸出', function() {
        assert.strictEqual(CATALOG.length, 35)
        assert.strictEqual(CATALOG.filter((d) => d.cointpe === 'price').length, 21)
        assert.strictEqual(CATALOG.filter((d) => d.cointpe === 'index').length, 14)
        let nDeals = 0
        for (let d of CATALOG) {
            for (let m of d.methods) {
                nDeals += m.deals.length
            }
        }
        assert.strictEqual(nDeals, 140)
        //慣例: 定義id皆小寫(底線分段), 目錄依id字母序(新增定義依序插入; 方向改變法price_ohlc_dirchange位於price_ohlc_cvd之後、price_ohlc_donchian之前)
        let ids = CATALOG.map((d) => d.id)
        assert.ok(ids.every((id) => /^[a-z]+(_[a-z]+)+$/.test(id)), 'id須皆小寫')
        assert.deepStrictEqual(ids, [...ids].sort())
        assert.strictEqual(ids[ids.indexOf('price_ohlc_dirchange') - 1], 'price_ohlc_cvd')
        assert.strictEqual(ids[ids.indexOf('price_ohlc_dirchange') + 1], 'price_ohlc_donchian')
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
        assert.ok(r.dropped.length === 32)
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

    //checkPeriods, 依手寫之[標籤, 根數, 第1筆時間]表驗證maNorm之key集合(恰為該表, 不多不少)與各序列之長度及第1筆時間, 並驗證rsi與candle之key
    let checkPeriods = (c, r, nBar, tbMa, labelsRsi, labelCandle) => {
        let pre = 'price_ohlc_Close_param_maNorm_'
        let keysMa = r.keys.filter((k) => k.startsWith(pre)).sort()
        assert.deepStrictEqual(keysMa, tbMa.map((v) => `${pre}${v[0]}`).sort(), keysMa.join(','))
        for (let [label, bars, t0] of tbMa) {
            let arr = JSON.parse(fs.readFileSync(path.resolve(c.fds.param, `${pre}${label}.json`), 'utf8'))
            assert.strictEqual(arr.length, nBar - bars + 1, `${label}: 根數${bars}之均線第1筆於索引${bars - 1}`)
            assert.strictEqual(arr[0].time, t0, label)
        }
        let keysRsi = r.keys.filter((k) => k.startsWith('price_ohlc_none_RSI_rsi_')).sort()
        assert.deepStrictEqual(keysRsi, labelsRsi.map((v) => `price_ohlc_none_RSI_rsi_${v}`).sort(), keysRsi.join(','))
        let keysCandle = r.keys.filter((k) => k.includes('_candle_')).sort()
        assert.ok(keysCandle.length > 0)
        assert.ok(keysCandle.every((k) => k.endsWith(`_candle_${labelCandle}`)), keysCandle.join(','))
    }

    it('4hr K線: 期別標籤 = 根數 × 4hr(1day為6根 … 30day為180根)', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, 500, { root: path.resolve(fdTmp, 'r9') })
        let c = normalizeCfg(cfg)
        assert.strictEqual(c.intervalSec, 14400)
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['price_ohlc_close', 'price_ohlc_candle', 'price_ohlc_rsi'] })
        checkPeriods(c, r, 500, [
            ['1day', 6, '2023-01-01T20:00:00'],
            ['2day', 12, '2023-01-02T20:00:00'],
            ['4day', 24, '2023-01-04T20:00:00'],
            ['7day', 42, '2023-01-07T20:00:00'],
            ['15day', 90, '2023-01-15T20:00:00'],
            ['30day', 180, '2023-01-30T20:00:00'],
        ], ['12hr', '16hr', '20hr', '1day', '2day', '4day', '7day'], '4hr')
    })

    it('1hr K線: 根數不變, 期別標籤 = 根數 × 1hr(均線 6hr、12hr、1day、42hr、90hr、180hr), 單根型態標籤為1hr', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, 1200, { root: path.resolve(fdTmp, 'r7'), interval: '1hr', stepMs: 3600 * 1000 })
        let c = normalizeCfg(cfg)
        assert.strictEqual(c.intervalSec, 3600)
        assert.ok(!('barsPerDay' in c))
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['price_ohlc_close', 'price_ohlc_candle', 'price_ohlc_rsi'] })
        checkPeriods(c, r, 1200, [
            ['6hr', 6, '2023-01-01T05:00:00'],
            ['12hr', 12, '2023-01-01T11:00:00'],
            ['1day', 24, '2023-01-01T23:00:00'],
            ['42hr', 42, '2023-01-02T17:00:00'],
            ['90hr', 90, '2023-01-04T17:00:00'],
            ['180hr', 180, '2023-01-08T11:00:00'],
        ], ['3hr', '4hr', '5hr', '6hr', '12hr', '1day', '42hr'], '1hr')
        //舊語意(依時間換算, 2day於1hr為48根)之標籤不存在
        assert.ok(!r.keys.includes('price_ohlc_Close_param_maNorm_2day'))
        assert.ok(!r.keys.includes('price_ohlc_Close_param_maNorm_30day'))
    })

    it('1day K線(intervalSec 86400): 根數不變, 期別標籤 = 根數 × 1day(均線 6day … 180day), 單根型態標籤為1day', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, 1200, { root: path.resolve(fdTmp, 'r10'), interval: '1day', intervalSec: 86400, stepMs: 86400 * 1000 })
        let c = normalizeCfg(cfg)
        assert.strictEqual(c.intervalSec, 86400)
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['price_ohlc_close', 'price_ohlc_candle', 'price_ohlc_rsi'] })
        checkPeriods(c, r, 1200, [
            ['6day', 6, '2023-01-06T00:00:00'],
            ['12day', 12, '2023-01-12T00:00:00'],
            ['24day', 24, '2023-01-24T00:00:00'],
            ['42day', 42, '2023-02-11T00:00:00'],
            ['90day', 90, '2023-03-31T00:00:00'],
            ['180day', 180, '2023-06-29T00:00:00'],
        ], ['3day', '4day', '5day', '6day', '12day', '24day', '42day'], '1day')
        //根數不因週期而剔除(舊語意下日K線之1day以下週期被剔除): 1day標籤於日K線即單根, 不在均線之週期內
        assert.ok(!r.keys.includes('price_ohlc_Close_param_maNorm_1day'))
    })

    it('buildKp: opt.intervalSec(預設14400)併入每次calc呼叫之opt, optMethod可覆寫, 數字字串轉為數值, 無效即throw, 已移除之barsPerDay不收', async function() {
        let seen = []
        let cap = async (arr, keyIn, o) => {
            seen.push(o)
            return []
        }
        let callOpt = async (optKp, om) => {
            seen.length = 0
            await buildKp({ cap }, optKp).cap([], 'Close', om)
            assert.strictEqual(seen.length, 1)
            return seen[0]
        }
        assert.deepStrictEqual(await callOpt(undefined, undefined), { intervalSec: 14400 })
        assert.deepStrictEqual(await callOpt({}, {}), { intervalSec: 14400 })
        assert.deepStrictEqual(await callOpt({ intervalSec: null }, {}), { intervalSec: 14400 }) //null視為未給
        assert.deepStrictEqual(await callOpt({ intervalSec: 3600 }, {}), { intervalSec: 3600 })
        assert.deepStrictEqual(await callOpt({ intervalSec: '86400' }, {}), { intervalSec: 86400 }) //數字字串轉為數值(K4、K7)
        assert.strictEqual(typeof (await callOpt({ intervalSec: '86400' }, {})).intervalSec, 'number')
        assert.deepStrictEqual(await callOpt({ intervalSec: 3600 }, { plusClose: 0.5 }), { intervalSec: 3600, plusClose: 0.5 }) //optMethod之其他鍵原樣保留
        assert.deepStrictEqual(await callOpt({ intervalSec: 3600 }, { intervalSec: 900, plusClose: 0.5 }), { intervalSec: 900, plusClose: 0.5 }) //optMethod之intervalSec可覆寫
        assert.deepStrictEqual(await callOpt({ barsPerDay: 24 }, {}), { intervalSec: 14400 }) //barsPerDay已移除: 視為未知鍵, 不換算、不傳入
        assert.ok(!('barsPerDay' in (await callOpt({ barsPerDay: 24, intervalSec: 3600 }, {}))))
        //無效即throw(V19、V20), 於建立時(非呼叫時)
        let msg = 'invalid opt.intervalSec: must be a positive integer multiple of 60 up to 31536000'
        for (let v of [0, -3600, 59, 90, 3600.5, 31536060, '', 'abc', '3600x', 'sk-secret-7q9', NaN, Infinity, true, [], {}, () => 3600]) {
            assert.throws(() => buildKp({ cap }, { intervalSec: v }), (e) => e.message === msg, String(typeof v))
        }
    })

    it('buildKp: 各內建calc之期別標籤與根數(手寫期望值; 1hr與1day), 根數不隨週期改變', async function() {
        let arr = genArrPrice(400)
        let lab = (rs) => rs.map((v) => `${v.period}:${v.len}`)
        let kp1h = buildKp({}, { intervalSec: 3600 })
        let kp1d = buildKp({}, { intervalSec: 86400 })
        let kp4h = buildKp({})
        assert.deepStrictEqual(lab(await kp4h.ma(arr, 'Close')), ['1day:6', '2day:12', '4day:24', '7day:42', '15day:90', '30day:180'])
        assert.deepStrictEqual(lab(await kp1h.ma(arr, 'Close')), ['6hr:6', '12hr:12', '1day:24', '42hr:42', '90hr:90', '180hr:180'])
        assert.deepStrictEqual(lab(await kp1d.ma(arr, 'Close')), ['6day:6', '12day:12', '24day:24', '42day:42', '90day:90', '180day:180'])
        assert.deepStrictEqual(lab(await kp4h.rsi(arr, 'Close')), ['12hr:3', '16hr:4', '20hr:5', '1day:6', '2day:12', '4day:24', '7day:42'])
        assert.deepStrictEqual(lab(await kp1h.rsi(arr, 'Close')), ['3hr:3', '4hr:4', '5hr:5', '6hr:6', '12hr:12', '1day:24', '42hr:42'])
        assert.deepStrictEqual(lab(await kp1d.rsi(arr, 'Close')), ['3day:3', '4day:4', '5day:5', '6day:6', '12day:12', '24day:24', '42day:42'])
        assert.deepStrictEqual((await kp1h.candle(arr, 'Close')).map((v) => v.period), ['1hr'])
        assert.deepStrictEqual((await kp1d.candle(arr, 'Close')).map((v) => v.period), ['1day'])
        assert.deepStrictEqual((await kp4h.candle(arr, 'Close')).map((v) => v.period), ['4hr'])
        //orig無期別表, 不受週期影響
        assert.deepStrictEqual((await kp1d.orig(arr, 'Close')).map((v) => v.period), (await kp4h.orig(arr, 'Close')).map((v) => v.period))
    })

    it('buildKp預設(4hr)之輸出與直接呼叫w-data-trade(不給intervalSec)逐位相同', async function() {
        //spec: 給14400(4hr)時標籤與輸出與未給者完全相同(w-data-trade 1.0.50 README); 注入不得改變4hr之結果
        let arr = genArrPrice(400)
        let kp = buildKp({})
        let kpExp = buildKp({}, { intervalSec: 14400 })
        let pairs = [
            ['ma', () => wdt.calcMa(arr, 'Close', { norm: false })],
            ['maNorm', () => wdt.calcMa(arr, 'Close', { norm: true })],
            ['ema', () => wdt.calcEma(arr, 'Close', { norm: false })],
            ['rsi', () => wdt.calcRsi(arr, 'Close', {})],
            ['candle', () => wdt.calcCandle(arr, 'Close', {})],
        ]
        for (let [m, fRaw] of pairs) {
            let raw = await fRaw()
            assert.ok(raw.length > 0 && raw.some((v) => v.vs.length > 0), m)
            assert.deepStrictEqual(await kp[m](arr, 'Close'), raw, m)
            assert.deepStrictEqual(await kpExp[m](arr, 'Close'), raw, m)
        }
    })

    it('buildKp: 方向改變法(dirChange)亦併入intervalSec(w-data-trade只檢核之), optMethod之intervalSec可覆寫, 其餘optMethod鍵原樣保留(逐點接線: 暫以記錄用之替身取代wdt.calcDirChange後還原)', async function() {
        let arr = genArrPrice(60)
        let real = wdt.calcDirChange
        let seen = []
        wdt.calcDirChange = async (a, key, o) => {
            seen.push([key, o])
            return real(a, key, o)
        }
        try {
            await buildKp({}, { intervalSec: 3600 }).dirChange(arr, 'Close', {})
            await buildKp({}).dirChange(arr, 'Close')
            await buildKp({}, { intervalSec: '86400' }).dirChange(arr, 'Close', { intervalSec: 900, keep: 1 })
        }
        finally {
            wdt.calcDirChange = real
        }
        assert.strictEqual(wdt.calcDirChange, real, '替身須已還原')
        assert.deepStrictEqual(seen, [['Close', { intervalSec: 3600 }], ['Close', { intervalSec: 14400 }], ['Close', { intervalSec: 900, keep: 1 }]])
    })

    it('1hr K線: index側之校正(dataCalibrate)與寫出皆以intervalSec 3600呼叫calc, 單根型態之index key標籤為1hr', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, 600, { root: path.resolve(fdTmp, 'r11'), interval: '1hr', stepMs: 3600 * 1000 })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        let seen = []
        let klr = async (arr, key, om) => {
            seen.push(om.intervalSec)
            return wdt.calcKlr(arr, key, om)
        }
        let r = await buildParams(c, { only: ['index_ohlc_klr', 'price_ohlc_klr'], calcs: { klr } })
        assert.strictEqual(r.calibrated.length, 1) //index側有校正(多次呼叫calc)
        assert.strictEqual(r.calibrated[0].id, 'index_ohlc_klr')
        assert.ok(seen.length > 2, String(seen.length))
        assert.ok(seen.every((v) => v === 3600), seen.join(',')) //校正與寫出之每次呼叫皆併入每根秒數
        let keysKlr = r.keys.filter((k) => k.includes('_klr_'))
        assert.ok(keysKlr.some((k) => k.startsWith('index_ohlc_none_ho_klr_')) && keysKlr.some((k) => k.startsWith('price_ohlc_none_')))
        assert.ok(keysKlr.every((k) => k.endsWith('_klr_1hr')), keysKlr.join(',')) //單根型態標籤為每根時長
    })

    it('尚無K線序列時throw', async function() {
        let { cfg } = cfgOf(fdTmp, 50, { root: path.resolve(fdTmp, 'r6') })
        await assert.rejects(buildParams(normalizeCfg(cfg)), /buildOhlc/)
    })

    it('dataCalibrate不把intervalSec當搜尋參數: 定義之optMethod內有intervalSec時亦去除, 校正期間calc恆收到cfg.intervalSec; 凍結於meta之optMethod不含intervalSec', async function() {
        this.timeout(120000)
        //spec(規則帳本TS-11): w-data-trade之dataCalibrate預設opt.params為optMethodInit全部鍵, 須排除intervalSec(每根時長為固定值, 不是校正參數)
        let { cfg } = cfgOf(fdTmp, 300, { root: path.resolve(fdTmp, 'cal-iv') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        let seen = new Set()
        let calcX = async (arr, keyIn, om) => {
            seen.add(om.intervalSec)
            let plus = Number(om.plusClose || 0)
            return [{ period: '1bar', len: 1, vs: arr.map((v, i) => ({ time: v.time, X: v.Close + plus + Math.sin(i * 0.37), XMod: v.Close * 1000 + plus * 1000 + Math.cos(i * 0.29) })) }]
        }
        let defs = [
            { id: 'price_ohlc_x', cointpe: 'price', keyKind: 'ohlc', fields: ['Close'], keysIn: [], methods: [{ method: 'myx', deals: [{ keyOut: 'X' }] }] },
            { id: 'index_ohlc_x', cointpe: 'index', keyKind: 'ohlc', fields: ['Close'], keysIn: [], methods: [{ method: 'myx', optMethod: { plusClose: 0.01, intervalSec: 3600 }, deals: [{ keyOut: 'XMod' }] }] },
        ]
        let r = await buildParams(c, { defs, calcs: { myx: calcX } })
        assert.deepStrictEqual([...seen], [14400]) //校正(參考側與搜尋各點)與寫出皆為cfg.intervalSec
        assert.strictEqual(r.calibrated.length, 1)
        assert.ok(!('intervalSec' in r.calibrated[0].optMethod))
        assert.ok(!('intervalSec' in r.calibrated[0].optMethodInit))
        let meta = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        assert.ok(!('intervalSec' in meta.optMethod['index_ohlc_x:myx']), JSON.stringify(meta.optMethod))
        assert.ok(r.keys.includes('index_ohlc_none_XMod_myx_1bar') && r.keys.includes('price_ohlc_none_X_myx_1bar'))
    })

    it('dataConvert之各method同一intervalSec(含不讀選項之orig): 定義中某method之optMethod另給不同之intervalSec時, 一律以cfg.intervalSec寫出(標籤依cfg之每根時長)', async function() {
        this.timeout(120000)
        //spec(w-data-trade 1.0.50): 同一次dataConvert之各method之optMethod.intervalSec須相同, 否則拒絕且輸出夾為空; 本套件以cfg.intervalSec統一
        let { cfg } = cfgOf(fdTmp, 300, { root: path.resolve(fdTmp, 'conv-iv') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        let defs = [{ id: 'price_ohlc_mix', cointpe: 'price', keyKind: 'ohlc', fields: ['Close'], keysIn: ['Close'], methods: [{ method: 'orig', deals: [{ keyOut: 'param' }] }, { method: 'ma', deals: [{ keyOut: 'param' }] }, { method: 'ema', optMethod: { intervalSec: 3600 }, deals: [{ keyOut: 'param' }] }] }]
        let r = await buildParams(c, { defs })
        assert.ok(r.keys.includes('price_ohlc_Close_param_ma_1day'), r.keys.join(','))
        assert.ok(r.keys.includes('price_ohlc_Close_param_ema_1day'), r.keys.join(','))
        assert.ok(!r.keys.some((k) => k.endsWith('_6hr')), r.keys.join(','))
        assert.ok(r.keys.includes('price_ohlc_Close_param_orig_none'), r.keys.join(','))
    })

    //方向改變法之16個鍵(4個輸出 × 4個門檻)
    let DIR_OUTS = ['dirState', 'dirRetrace', 'dirRun', 'dirAge']
    let DIR_LABELS = ['4pct', '6pct', '8pct', '10pct']
    let DIR_KEYS = DIR_OUTS.flatMap((o) => DIR_LABELS.map((l) => `price_ohlc_none_${o}_dirChange_${l}`)).sort()
    let DIR_NM = DIR_OUTS.map((o) => nmKeyOf({ id: 'price_ohlc_dirchange' }, 'dirChange', 'none', o))
    let readParam = (c, k) => JSON.parse(fs.readFileSync(path.resolve(c.fds.param, `${k}.json`), 'utf8'))
    let near = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b))

    it('方向改變法(price_ohlc_dirchange): 只在價格側、只需Close; 16鍵; 序列 = (w-data-trade calcDirChange之原值 − nm.avg) / nm.std, nm.avg為nm期間內各門檻攤平之均值', async function() {
        this.timeout(120000)
        //目錄
        let def = CATALOG.find((d) => d.id === 'price_ohlc_dirchange')
        assert.deepStrictEqual({ cointpe: def.cointpe, keyKind: def.keyKind, fields: def.fields, keysIn: def.keysIn, funAddKeysIn: def.funAddKeysIn }, { cointpe: 'price', keyKind: 'ohlc', fields: ['Close'], keysIn: [], funAddKeysIn: null })
        assert.deepStrictEqual(def.methods.map((m) => [m.method, m.optMethod, m.deals.map((d) => d.keyOut)]), [['dirChange', null, DIR_OUTS]])
        assert.ok(!CATALOG.some((d) => d.cointpe === 'index' && d.methods.some((m) => m.method === 'dirChange')), '溢價指數側不列')
        //建立
        let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'dir4') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        let r = await buildParams(c, { only: ['price_ohlc_dirchange'] })
        assert.deepStrictEqual(r.defs, ['price_ohlc_dirchange'])
        assert.deepStrictEqual([...r.keys].sort(), DIR_KEYS)
        //期望值: 直接以w-data-trade calcDirChange對K線序列檔計原值(訓練期 = 全部數據), nm.avg為各門檻攤平之均值
        let ohlc = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, `${c.keyOhlc}.json`), 'utf8'))
        assert.strictEqual(ohlc.length, n)
        let raw = await wdt.calcDirChange(ohlc, 'Close', { intervalSec: 14400 })
        assert.deepStrictEqual(raw.map((rr) => rr.period), DIR_LABELS)
        let meta = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        DIR_OUTS.forEach((o, j) => {
            let all = raw.flatMap((rr) => rr.vs.map((v) => v[o]))
            let nm = meta.nm[DIR_NM[j]]
            assert.ok(near(nm.avg, all.reduce((a, b) => a + b, 0) / all.length), `${o} nm.avg`)
            assert.ok(nm.std > 0, `${o} nm.std`)
            for (let rr of raw) {
                let ser = readParam(c, `price_ohlc_none_${o}_dirChange_${rr.period}`)
                assert.ok(rr.vs.length > 0, `${o} ${rr.period} 須有確認`)
                assert.deepStrictEqual(ser.map((v) => v.time), rr.vs.map((v) => v.time), `${o} ${rr.period} time`)
                ser.forEach((v, i) => {
                    assert.ok(near(v.param, (rr.vs[i][o] - nm.avg) / nm.std), `${o} ${rr.period} 第${i}筆`)
                })
            }
        })
    })

    it('方向改變法: 期別段為門檻標籤, 與K線週期無關(4hr、1hr、1day之鍵相同, 同一串收盤之序列值逐值相同)', async function() {
        this.timeout(120000)
        let mk = async (name, interval, stepMs) => {
            let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, name), interval, stepMs })
            let c = normalizeCfg(cfg)
            await buildOhlc(c)
            let r = await buildParams(c, { only: ['price_ohlc_dirchange'] })
            return { c, r }
        }
        let a = await mk('dirI4', '4hr', 4 * 3600 * 1000)
        let b = await mk('dirI1h', '1hr', 3600 * 1000)
        let d = await mk('dirI1d', '1day', 86400 * 1000)
        assert.deepStrictEqual([b.c.intervalSec, d.c.intervalSec], [3600, 86400])
        for (let x of [a, b, d]) {
            assert.deepStrictEqual([...x.r.keys].sort(), DIR_KEYS)
        }
        for (let k of DIR_KEYS) {
            let pa = readParam(a.c, k).map((v) => v.param)
            assert.ok(pa.length > 0, k)
            assert.deepStrictEqual(readParam(b.c, k).map((v) => v.param), pa, k)
            assert.deepStrictEqual(readParam(d.c, k).map((v) => v.param), pa, k)
        }
    })

    it('方向改變法之dirState: z分數只有兩個值(z− < 0 < z+); 求解之預設門檻格點(−2～2、步長0.1)中, 以「>」分開兩值者(含0)皆恰為dirState = +1之根', async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'dirZ') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        await buildParams(c, { only: ['price_ohlc_dirchange'] })
        let ohlc = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, `${c.keyOhlc}.json`), 'utf8'))
        let raw = await wdt.calcDirChange(ohlc, 'Close', { intervalSec: 14400 })
        let grid = Array.from({ length: 41 }, (v, i) => (i - 20) / 10)
        DIR_LABELS.forEach((l, j) => {
            let ps = readParam(c, `price_ohlc_none_dirState_dirChange_${l}`).map((v) => v.param)
            let ups = raw[j].vs.map((v) => v.dirState === 1)
            assert.ok(ups.some((x) => x) && ups.some((x) => !x), `${l}: 前提: 兩種狀態皆出現`)
            let u = [...new Set(ps)].sort((x, y) => x - y)
            assert.strictEqual(u.length, 2, l)
            assert.ok(u[0] < 0 && u[1] > 0, `${l}: ${u}`)
            let sep = grid.filter((th) => ps.some((p) => p > th) && ps.some((p) => !(p > th)))
            assert.ok(sep.includes(0), `${l}: 0分開兩值`)
            for (let th of sep) {
                assert.deepStrictEqual(ps.map((p) => p > th), ups, `${l}: > ${th}`)
            }
        })
    })

    it('既有工作根之升版: 已凍結nm而未含price_ohlc_dirchange之工作根加入此定義重跑(不recalibrate) ⇒ 不拋錯; 既有序列檔與nm逐位不變; 新增16檔與4個nm(以凍結之nm期間自算); nmComputed為4', async function() {
        this.timeout(180000)
        let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, 'dirUpg') })
        let c = normalizeCfg(cfg)
        await buildOhlc(c)
        let half = { timeStart: c.train.timeStart, timeEnd: '2023-02-15T00:00:00' }
        let only0 = ['price_ohlc_close', 'price_ohlc_rsi', 'index_ohlc_close']
        let r0 = await buildParams(c, { only: only0, nmPeriod: half }) //nm期間凍結為前段
        let fpMeta = path.resolve(c.fds.meta, 'params.json')
        let meta0 = JSON.parse(fs.readFileSync(fpMeta, 'utf8'))
        let snap0 = r0.keys.map((k) => [k, fs.readFileSync(path.resolve(c.fds.param, `${k}.json`))])
        assert.ok(snap0.length > 50 && !r0.keys.some((k) => DIR_KEYS.includes(k)))
        //升版: 加入price_ohlc_dirchange(未給nmPeriod、未recalibrate)
        let r1 = await buildParams(c, { only: [...only0, 'price_ohlc_dirchange'] })
        let meta1 = JSON.parse(fs.readFileSync(fpMeta, 'utf8'))
        assert.strictEqual(r1.nmComputed, 4)
        assert.deepStrictEqual(r1.keys.filter((k) => !DIR_KEYS.includes(k)), r0.keys)
        assert.deepStrictEqual(r1.keys.filter((k) => DIR_KEYS.includes(k)).sort(), DIR_KEYS)
        for (let [k, buf] of snap0) {
            assert.ok(fs.readFileSync(path.resolve(c.fds.param, `${k}.json`)).equals(buf), `既有序列檔逐位不變: ${k}`)
        }
        for (let [k, v] of Object.entries(meta0.nm)) {
            assert.deepStrictEqual(meta1.nm[k], v, `既有nm不變: ${k}`)
        }
        assert.deepStrictEqual(Object.keys(meta1.nm).filter((k) => !(k in meta0.nm)), DIR_NM)
        assert.deepStrictEqual(meta1.nmPeriod, half)
        assert.deepStrictEqual(meta1.optMethod, meta0.optMethod)
        //新nm以凍結之nm期間(前段)自算: 同另一工作根以nmPeriod: half全新建立者; 鑑別前提: 前段與全期之nm不同
        let fresh = async (name, nmPeriod) => {
            let { cfg: cfg2 } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, name) })
            let c2 = normalizeCfg(cfg2)
            await buildOhlc(c2)
            await buildParams(c2, { only: ['price_ohlc_dirchange'], nmPeriod })
            return JSON.parse(fs.readFileSync(path.resolve(c2.fds.meta, 'params.json'), 'utf8')).nm
        }
        let nmHalf = await fresh('dirHalf', half)
        let nmFull = await fresh('dirFull', undefined)
        for (let k of DIR_NM) {
            assert.deepStrictEqual(meta1.nm[k], nmHalf[k], k)
        }
        assert.ok(DIR_NM.some((k) => meta1.nm[k].avg !== nmFull[k].avg), '鑑別前提: 前段與全期之nm須不同')
        //再跑一次(穩態): nmComputed 0, 全部序列檔不變
        let snap1 = r1.keys.map((k) => [k, fs.readFileSync(path.resolve(c.fds.param, `${k}.json`))])
        let r2 = await buildParams(c, { only: [...only0, 'price_ohlc_dirchange'] })
        assert.strictEqual(r2.nmComputed, 0)
        for (let [k, buf] of snap1) {
            assert.ok(fs.readFileSync(path.resolve(c.fds.param, `${k}.json`)).equals(buf), `穩態: ${k}`)
        }
    })

})
