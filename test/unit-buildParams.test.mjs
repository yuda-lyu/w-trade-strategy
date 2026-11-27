import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import normalizeCfg from '../src/cfg.mjs'
import buildOhlc from '../src/data/buildOhlc.mjs'
import createPipeline from '../src/createPipeline.mjs'
import buildParams, { buildKp, nmKeyOf, resolveNmOpt, nmOfStat, nmByPeriodOf } from '../src/params/buildParams.mjs'
import CATALOG from '../src/params/catalog.mjs'
import wdt from 'w-data-trade/src/WDataTrade.mjs'
import periodInfo from 'w-data-trade/src/periodInfo.mjs'
import { buildFdTmp, cfgOf, genArrPrice } from './tools/synthKit.mjs'
import { SCENARIOS, runScenario } from './tools/bpParity.mjs'


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
//  nm之取法(opt.nmScope: 'key'為同一輸出欄各期別共用一組(預設)、'period'為各期別各自一組; opt.nmStat: 'meanStd'為平均與標準差(預設)、'medianIqr'為中位數與(q75 − q25) ÷ 1.349): 兩者皆為預設時與1.0.39逐位元組相同(meta/params.json不含此二欄); 非預設時凍結於meta.nmScope與meta.nmStat, byPeriod只收n(該期別於nm期間內之有效值個數)至少50(固定下限, 不設選項)且尺度大於0之期別, 其餘沿用鍵層; 已凍結者沿用(須recalibrate才改); 給了而無效即throw固定訊息(不含輸入值, 先於任何建夾與寫檔); meta內凍結之值無效亦throw固定訊息; 鍵層尺度不可用時之警告log寫實際採用之avg與std
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

    describe('nm之取法(opt.nmScope、opt.nmStat)', function() {

        //訊息依跨套件規格〈輸入參數之檢測機制〉V19(invalid <名稱>: must …)、V20(不回顯輸入值)與S3(列舉類寫允許之集合 one of …); meta內凍結值無效屬工作根之狀態, 名稱為cfg.root(同src/util/basis.mjs之作法)
        let MSG_SCOPE = `invalid opt.nmScope: must be one of 'key', 'period'`
        let MSG_STAT = `invalid opt.nmStat: must be one of 'meanStd', 'medianIqr'`
        let MSG_META_SCOPE = `invalid cfg.root: must have a valid nmScope in meta/params.json, one of 'key', 'period'; use opt.recalibrate or a new work root`
        let MSG_META_STAT = `invalid cfg.root: must have a valid nmStat in meta/params.json, one of 'meanStd', 'medianIqr'; use opt.recalibrate or a new work root`
        let MSG_OLD = `nmScope 'period' and nmStat 'medianIqr' need a newer w-data-trade whose dataConvert returns periods, median, q25 and q75`
        let MSG_BY_PERIOD = 'invalid deal.nm.byPeriod: must be an object of { avg, std } with a finite avg and a finite std > 0'
        let NEW_COLS = ['n', 'median', 'q25', 'q75', 'periods']

        //SNAP_BP, 改動前(w-trade-strategy 1.0.39 搭配 w-data-trade 1.0.66)之對拍快照: 以原版 buildParams 對 test/tools/bpParity.mjs 各案(各次執行)產生之 param/ 整夾清單雜湊、meta/params.json(遮蔽 at)雜湊與回傳值雜湊; 快照不得以現行程式碼重產
        let SNAP_BP = {
            cat4hr: [
                { nFiles: 292, manifest: '4a72a800c042abd2abe48d5f99bfec95267a71a682ffaec1012613ef6e7c248c', meta: '22c34bf056d4fd2763bc850f20a4abdb2fbfd001a810d05c12d078f13387964b', ret: '9cc9418d65f150345f256d4fa3ad6569a69b103fc2eacc1dee6e95cf88136413' },
                { nFiles: 292, manifest: '4a72a800c042abd2abe48d5f99bfec95267a71a682ffaec1012613ef6e7c248c', meta: '22c34bf056d4fd2763bc850f20a4abdb2fbfd001a810d05c12d078f13387964b', ret: '9dce152a9f2f6f2f2a24464455147ea47b436d5035483f1786cd4e8ee86f3ecd' },
                { nFiles: 310, manifest: '2752a1f3c52c3159b3cb21d56233425dea3626d8f2cf4619da2d0af08e641f75', meta: 'f78a1d119dd6e6daa4f35cde304e76976754f3df2628057ad94a5baca683fe19', ret: '852b050ea9355a15c5d51576e97212c456a17cab3d76bb389ddd55de453cb872' },
                { nFiles: 310, manifest: '8be9dd1e8a5a96fa85ea917f034ed633eb63f081d0c3b7e075dfaf133c26df63', meta: 'c778ecba5b40c7fdcf1327fb11f3fa3698dd611a851e21a5b3d8919312262c53', ret: '4ea77e49a2d79112984e9e815c1bd5e8c733c0171b548947ed040671cd1cc596' },
            ],
            cat1day: [
                { nFiles: 292, manifest: 'bb7a8b56a94b94e2b007a10f10f9222c15ac04a1743c571758ea67cf499be1b3', meta: 'b5a8c61eca27c2d83ee3256099fa37481a849d8bbefbb37abd46d047948c8541', ret: '025e50c17d2251048f99525baee5ace4456c9aa2147a243e8835505ca06e7c5d' },
                { nFiles: 292, manifest: 'bb7a8b56a94b94e2b007a10f10f9222c15ac04a1743c571758ea67cf499be1b3', meta: '32ea0bb632203c3fcdccf72e7e09a5b556a60a06e03ffc174cd0df925ccae372', ret: 'f6328a7580c555ceaa28c9d3e89e0b84e37c76d144edcc85d204c6301a5276ab' },
            ],
            selfNm: [
                { nFiles: 896, manifest: 'b0c3fdc36f6d37cf6c2d0e2f54fad5a5d87301c1c5e719c37a05dba4b75788d2', meta: '46aff792e9f8398357cf9df50416314fafa759c6258cc257280aa65818fbef91', ret: '4c7b5b5f0975c37d4af2bec3dad7378d52915f47e1b6636500279ef0da3278d9' },
            ],
        }

        //MIN_N, byPeriod收錄一個期別所需之最少筆數(規格: 固定50, 不設選項; 依據見src/params/buildParams.mjs之NM_MIN_N); 手寫於此, 不取自src, 使src之改動被測試攔下
        let MIN_N = 50
        //SCALE_PERIODS, 合成之自訂method(myx)之各期: 尺度(mul)相差逾100倍且含重尾(每7筆一個遠離值)、p4只有最後1筆(n為1)、p5為常數(尺度0)、p6九成為同一值(四分位距0而標準差大於0)、p7只有最後49筆(MIN_N − 1, 不收)、p8只有最後50筆(MIN_N, 收); tail為該期別只有最後幾筆
        let SCALE_PERIODS = [
            { period: 'p1', len: 1, mul: 1, off: 3 },
            { period: 'p2', len: 2, mul: 25, off: -2 },
            { period: 'p3', len: 3, mul: 700, off: 5 },
            { period: 'p4', len: 4, mul: 9, off: 1, tail: 1 },
            { period: 'p5', len: 5, mul: 0, off: 7 },
            { period: 'p6', len: 6, mul: 40, off: 5, sparse: true },
            { period: 'p7', len: 7, mul: 12, off: -4, tail: MIN_N - 1 },
            { period: 'p8', len: 8, mul: 3, off: 2, tail: MIN_N },
        ]
        let PERIODS_ALL = SCALE_PERIODS.map((p) => p.period)
        let PERIODS_IN = ['p1', 'p2', 'p3', 'p6', 'p8'] //byPeriod收入之期別(次序同輸入): p4(1筆)、p5(常數)、p7(49筆)不收
        let PERIODS_OUT = ['p4', 'p5', 'p7']
        let calcMyx = async (arr, keyIn, optMethod = {}) => {
            return SCALE_PERIODS.map((p, k) => {
                let vs = []
                for (let i = p.tail ? arr.length - p.tail : 0; i < arr.length; i++) {
                    let x = p.mul * (p.off + Math.sin(i * 1.37 + k) + (i % 7 === 0 ? 6 : 0) + i * 0.001)
                    if (p.mul === 0) {
                        x = p.off
                    }
                    if (p.sparse) {
                        x = p.mul * (p.off + (i % 10 === 0 ? i * 0.01 + 1 : 0))
                    }
                    vs.push({ time: arr[i].time, X: x, Z: x * 0.5 + p.mul * Math.cos(i * 0.91 + k) })
                }
                return { period: p.period, len: p.len, vs }
            })
        }
        let defMyx = (id = 'price_ohlc_myx', nm = undefined) => ({ id, cointpe: 'price', keyKind: 'ohlc', fields: ['Close'], keysIn: [], methods: [{ method: 'myx', deals: [{ keyOut: 'X', nm }, { keyOut: 'Z' }] }] })
        let nkX = nmKeyOf({ id: 'price_ohlc_myx' }, 'myx', 'none', 'X')
        let nkZ = nmKeyOf({ id: 'price_ohlc_myx' }, 'myx', 'none', 'Z')

        let mkRoot = async (name, n = 400) => {
            let { cfg } = cfgOf(fdTmp, n, { root: path.resolve(fdTmp, name) })
            let c = normalizeCfg(cfg)
            await buildOhlc(c)
            return c
        }
        let bp = (c, opt = {}) => buildParams(c, { defs: [defMyx()], calcs: { myx: calcMyx }, ...opt })
        let readMeta = (c) => JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8'))
        let readMetaRaw = (c) => fs.readFileSync(path.resolve(c.fds.meta, 'params.json'), 'utf8').replace(/"at":\s*"[^"]*"/, '"at":"MASK"')
        let readSer = (c, period, keyOut = 'X', id = 'myx') => JSON.parse(fs.readFileSync(path.resolve(c.fds.param, `price_ohlc_none_${keyOut}_${id}_${period}.json`), 'utf8')).map((v) => v.param)
        let paramShas = (c) => {
            let o = {}
            for (let fn of fs.readdirSync(c.fds.param).sort()) {
                o[fn] = createHash('sha256').update(fs.readFileSync(path.resolve(c.fds.param, fn))).digest('hex')
            }
            return o
        }
        //rawOf, 以另行呼叫calcMyx取得nm期間(測試之train為全部數據)內各期之原值序列{ period: [x, ...] }
        let rawOf = async (c, keyOut = 'X') => {
            let ohlc = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, `${c.keyOhlc}.json`), 'utf8'))
            let o = {}
            for (let rr of await calcMyx(ohlc, 'none', {})) {
                o[rr.period] = rr.vs.map((m) => m[keyOut])
            }
            return o
        }
        //brute, 另寫之暴力統計(不與src共用程式): n、avg、樣本std(n − 1)、第7型分位數(排序後分數位置線性內插)
        let brute = (xs) => {
            let n = xs.length
            let s = [...xs].sort((a, b) => a - b)
            let q = (p) => {
                let pos = (n - 1) * p
                let lo = Math.floor(pos)
                let hi = Math.ceil(pos)
                return s[lo] + (pos - lo) * (s[hi] - s[lo])
            }
            let avg = xs.reduce((a, b) => a + b, 0) / n
            let std = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - avg) * (b - avg), 0) / (n - 1)) : null
            return { n, avg, std, median: q(0.5), q25: q(0.25), q75: q(0.75) }
        }
        let viaJson = (v) => JSON.parse(JSON.stringify(v))
        //assertNearRel, 相對誤差斷言(分母取1與兩值絕對值之最大者); 訊息只含標籤
        let assertNearRel = (a, b, tol, msg) => {
            assert.ok(Number.isFinite(a) && Number.isFinite(b), `${msg} 須為有限數`)
            assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)), `${msg} 實得與期望之差超過容差`)
        }

        it('前提: 合成資料各期尺度相差逾100倍且含重尾、p4為1筆、p5為常數、p6之四分位距為0而標準差大於0、p7為49筆而p8為50筆(兩者尺度皆大於0, 僅筆數不同)、各期之值逐筆相異', async function() {
            let c = await mkRoot('nm-premise')
            let raw = await rawOf(c)
            let stds = ['p1', 'p2', 'p3'].map((p) => brute(raw[p]).std)
            assert.ok(Math.max(...stds) / Math.min(...stds) > 100)
            assert.strictEqual(raw.p4.length, 1)
            assert.strictEqual(brute(raw.p5).std, 0)
            let b6 = brute(raw.p6)
            assert.strictEqual(b6.q75 - b6.q25, 0)
            assert.ok(b6.std > 0)
            assert.strictEqual(raw.p7.length, MIN_N - 1)
            assert.strictEqual(raw.p8.length, MIN_N)
            for (let p of ['p7', 'p8']) {
                let b = brute(raw[p])
                assert.ok(b.std > 0 && b.q75 - b.q25 > 0, `期別${p}之標準差與四分位距須大於0(只因筆數而收或不收)`)
                assert.strictEqual(new Set(raw[p]).size, raw[p].length, `期別${p}之值須逐筆相異`)
            }
            for (let p of ['p1', 'p2', 'p3']) {
                assert.strictEqual(new Set(raw[p]).size, raw[p].length, `期別${p}之值須逐筆相異`)
                let b = brute(raw[p])
                assert.ok(Math.max(...raw[p]) - b.median > 3 * (b.q75 - b.q25), `期別${p}須含重尾`)
            }
        })

        describe('預設(未給或給預設值)與1.0.39逐位元組相同', function() {

            for (let id of Object.keys(SCENARIOS)) {
                for (let [tag, extra] of [['未給', {}], ['給預設值', { nmScope: 'key', nmStat: 'meanStd' }], ['給null與undefined', { nmScope: null, nmStat: undefined }]]) {
                    it(`對拍快照[${id}、${tag}]: param/整夾、meta/params.json(遮蔽at)與回傳值(去除nmScope與nmStat)皆同改動前`, async function() {
                        this.timeout(180000)
                        let fd = path.resolve(fdTmp, `bp-${id}-${tag.length}-${Math.random().toString(36).slice(2, 6)}`)
                        fs.mkdirSync(fd, { recursive: true })
                        let outs = await runScenario({ normalizeCfg, buildOhlc, buildParams, cfgOf }, fd, id, extra)
                        assert.deepStrictEqual(outs, SNAP_BP[id])
                    })
                }
            }

            it('自訂method之工作根: 未給與給預設值之meta/params.json逐位元組相同且不含nmScope與nmStat; 回傳之nmScope與nmStat為預設值', async function() {
                let c0 = await mkRoot('nm-def0')
                let c1 = await mkRoot('nm-def1')
                let r0 = await bp(c0)
                let r1 = await bp(c1, { nmScope: 'key', nmStat: 'meanStd' })
                assert.strictEqual(readMetaRaw(c0), readMetaRaw(c1))
                assert.ok(!('nmScope' in readMeta(c0)) && !('nmStat' in readMeta(c0)))
                assert.deepStrictEqual(paramShas(c0), paramShas(c1))
                assert.deepStrictEqual([r0.nmScope, r0.nmStat, r1.nmScope, r1.nmStat], ['key', 'meanStd', 'key', 'meanStd'])
                assert.ok(!('byPeriod' in readMeta(c0).nm[nkX]))
                assert.deepStrictEqual(Object.keys(readMeta(c0).nm[nkX]), ['avg', 'std'])
            })

            it('預設(key)下各期別輸出之標準差相差逾100倍(此為依期別各自正規化之動機)', async function() {
                let c = await mkRoot('nm-def2')
                await bp(c)
                let stds = ['p1', 'p2', 'p3'].map((p) => brute(readSer(c, p)).std)
                assert.ok(Math.max(...stds) / Math.min(...stds) > 100)
            })

        })

        describe('nmScope、nmStat之各組合', function() {

            it('period + meanStd: byPeriod只收n至少50且尺度大於0之期別(p4為1筆、p7為49筆、p5為常數不收; p8恰50筆收); 各收入期別之輸出平均約0、標準差約1; 未收入者沿用鍵層; 頂層為各期別攤平之值', async function() {
                let c = await mkRoot('nm-p-ms')
                let r = await bp(c, { nmScope: 'period', nmStat: 'meanStd' })
                assert.deepStrictEqual([r.nmScope, r.nmStat], ['period', 'meanStd'])
                let meta = readMeta(c)
                assert.deepStrictEqual([meta.nmScope, meta.nmStat], ['period', 'meanStd'])
                let raw = await rawOf(c)
                let flat = Object.values(raw).flat()
                let nm = meta.nm[nkX]
                assert.deepStrictEqual(Object.keys(nm), ['avg', 'std', 'byPeriod'])
                assertNearRel(nm.avg, brute(flat).avg, 1e-9, '頂層avg')
                assertNearRel(nm.std, brute(flat).std, 1e-9, '頂層std')
                assert.deepStrictEqual(Object.keys(nm.byPeriod), PERIODS_IN)
                for (let p of PERIODS_IN) {
                    let b = brute(raw[p])
                    assertNearRel(nm.byPeriod[p].avg, b.avg, 1e-9, `${p} avg`)
                    assertNearRel(nm.byPeriod[p].std, b.std, 1e-9, `${p} std`)
                    let o = brute(readSer(c, p))
                    assert.ok(Math.abs(o.avg) < 1e-9, `${p} 輸出平均`)
                    assert.ok(Math.abs(o.std - 1) < 1e-9, `${p} 輸出標準差`)
                }
                for (let p of PERIODS_OUT) {
                    assert.deepStrictEqual(readSer(c, p), viaJson(raw[p].map((x) => (x - nm.avg) / nm.std)), `${p} 沿用鍵層`)
                }
                //另一輸出欄(Z)亦各自凍結
                assert.ok(Object.keys(meta.nm[nkZ].byPeriod).length >= 3)
            })

            it('key + medianIqr: nm為攤平序列之中位數與(q75 − q25) ÷ 1.349; 輸出(各期攤平)之中位數約0、四分位距約1.349; 不含byPeriod', async function() {
                let c = await mkRoot('nm-k-mi')
                let r = await bp(c, { nmScope: 'key', nmStat: 'medianIqr' })
                assert.deepStrictEqual([r.nmScope, r.nmStat], ['key', 'medianIqr'])
                let meta = readMeta(c)
                assert.deepStrictEqual([meta.nmScope, meta.nmStat], ['key', 'medianIqr'])
                let raw = await rawOf(c)
                let b = brute(Object.values(raw).flat())
                let nm = meta.nm[nkX]
                assert.deepStrictEqual(Object.keys(nm), ['avg', 'std'])
                assertNearRel(nm.avg, b.median, 1e-9, 'avg為中位數')
                assertNearRel(nm.std, (b.q75 - b.q25) / 1.349, 1e-9, 'std為四分位距÷1.349')
                let out = brute(PERIODS_ALL.flatMap((p) => readSer(c, p)))
                assert.ok(Math.abs(out.median) < 1e-9, '輸出中位數')
                assert.ok(Math.abs((out.q75 - out.q25) - 1.349) < 1e-9, '輸出四分位距')
            })

            it('period + medianIqr: 各收入期別之輸出中位數約0、四分位距約1.349; 四分位距為0者(p6)退回該期之平均與標準差(輸出平均約0、標準差約1); 1筆(p4)、常數(p5)與49筆(p7)不收', async function() {
                let c = await mkRoot('nm-p-mi')
                await bp(c, { nmScope: 'period', nmStat: 'medianIqr' })
                let meta = readMeta(c)
                assert.deepStrictEqual([meta.nmScope, meta.nmStat], ['period', 'medianIqr'])
                let raw = await rawOf(c)
                let nm = meta.nm[nkX]
                assert.deepStrictEqual(Object.keys(nm.byPeriod), PERIODS_IN)
                for (let p of ['p1', 'p2', 'p3', 'p8']) {
                    let b = brute(raw[p])
                    assertNearRel(nm.byPeriod[p].avg, b.median, 1e-9, `${p} avg`)
                    assertNearRel(nm.byPeriod[p].std, (b.q75 - b.q25) / 1.349, 1e-9, `${p} std`)
                    let o = brute(readSer(c, p))
                    assert.ok(Math.abs(o.median) < 1e-9, `${p} 輸出中位數`)
                    assert.ok(Math.abs((o.q75 - o.q25) - 1.349) < 1e-9, `${p} 輸出四分位距`)
                }
                let b6 = brute(raw.p6)
                assertNearRel(nm.byPeriod.p6.avg, b6.avg, 1e-9, 'p6 avg(退回平均)')
                assertNearRel(nm.byPeriod.p6.std, b6.std, 1e-9, 'p6 std(退回標準差)')
                let o6 = brute(readSer(c, 'p6'))
                assert.ok(Math.abs(o6.avg) < 1e-9 && Math.abs(o6.std - 1) < 1e-9, 'p6 輸出')
                //頂層(鍵層)為攤平序列之中位數與四分位距
                let bf = brute(Object.values(raw).flat())
                assertNearRel(nm.avg, bf.median, 1e-9, '頂層avg')
                assertNearRel(nm.std, (bf.q75 - bf.q25) / 1.349, 1e-9, '頂層std')
            })

            it('退化: 某期別資料不足(n < 50)或尺度為0 ⇒ 不列入byPeriod、沿用鍵層(meanStd與medianIqr皆然); 鍵層之尺度不可用時依現行之取法(avg有限則保留、std改1; 皆無值則{avg:0,std:1}), 警告log寫實際採用之avg與std', async function() {
                let mkDef = (id, method) => ({ id, cointpe: 'price', keyKind: 'ohlc', fields: ['Close'], keysIn: [], methods: [{ method, deals: [{ keyOut: 'X' }] }] })
                //全部期別皆常數5 ⇒ 鍵層std為0 ⇒ 現行取法: avg 5(有限)、std 1; byPeriod為空物件
                let calcConst = async (arr) => [{ period: 'a', len: 1, vs: arr.map((v) => ({ time: v.time, X: 5 })) }, { period: 'b', len: 2, vs: arr.map((v) => ({ time: v.time, X: 5 })) }]
                //全部期別皆無有效值(NaN) ⇒ 鍵層avg與std皆無 ⇒ {avg:0,std:1}; byPeriod為空物件
                let calcNan = async (arr) => [{ period: 'a', len: 1, vs: arr.map((v) => ({ time: v.time, X: NaN })) }, { period: 'b', len: 2, vs: [] }]
                //withLogs, 執行fn並回傳其間之console.log各行(useShowLog為true時buildParams經console.log輸出)
                let withLogs = async (fn) => {
                    let lines = []
                    let logReal = console.log
                    console.log = (...a) => {
                        lines.push(a.join(' '))
                    }
                    try {
                        await fn()
                    }
                    finally {
                        console.log = logReal
                    }
                    return lines
                }
                for (let stat of ['meanStd', 'medianIqr']) {
                    let c1 = await mkRoot(`nm-degen-c-${stat}`)
                    let l1 = await withLogs(() => buildParams(c1, { defs: [mkDef('price_ohlc_cst', 'cst')], calcs: { cst: calcConst }, nmScope: 'period', nmStat: stat, useShowLog: true }))
                    assert.deepStrictEqual(readMeta(c1).nm[nmKeyOf({ id: 'price_ohlc_cst' }, 'cst', 'none', 'X')], { avg: 5, std: 1, byPeriod: {} }, `常數 ${stat}`)
                    assert.strictEqual(l1.some((s) => s.includes('之中位數與四分位距不可用')), stat === 'medianIqr', `常數 ${stat} 之medianIqr退回log`)
                    //avg有限(5)時保留之、只有std改1: 警告須如實寫{avg:5,std:1}(原文字寫死{avg:0,std:1}而avg有限時實未改0, 且此情形原不log)
                    assert.strictEqual(l1.filter((s) => /之std非有限正數\(.+\), nm改採\{avg:5,std:1\}/.test(s)).length, 1, `常數 ${stat} 須log一行如實之警告`)
                    assert.ok(!l1.some((s) => s.includes('{avg:0,std:1}')), `常數 ${stat} 之警告不得寫avg為0`)
                    let c2 = await mkRoot(`nm-degen-n-${stat}`)
                    let l2 = await withLogs(() => buildParams(c2, { defs: [mkDef('price_ohlc_nan', 'nan')], calcs: { nan: calcNan }, nmScope: 'period', nmStat: stat, useShowLog: true }))
                    assert.deepStrictEqual(readMeta(c2).nm[nmKeyOf({ id: 'price_ohlc_nan' }, 'nan', 'none', 'X')], { avg: 0, std: 1, byPeriod: {} }, `無有效值 ${stat}`)
                    assert.strictEqual(l2.filter((s) => s.includes('之std非有限正數(null), nm改採{avg:0,std:1}')).length, 1, `無有效值 ${stat} 須log一行鍵層std不可用並寫實際採用之{avg:0,std:1}`)
                    //尺度可用時不log警告
                    let c3 = await mkRoot(`nm-degen-ok-${stat}`)
                    let l3 = await withLogs(() => bp(c3, { nmScope: 'period', nmStat: stat, useShowLog: true }))
                    assert.ok(!l3.some((s) => s.includes('警告')), `尺度可用 ${stat} 不得log警告`)
                }
                //與預設(key)之同一資料: 鍵層之值相同(取法之退回行為不因scope而異)
                let c3 = await mkRoot('nm-degen-key')
                let l4 = await withLogs(() => buildParams(c3, { defs: [mkDef('price_ohlc_cst', 'cst')], calcs: { cst: calcConst }, useShowLog: true }))
                assert.deepStrictEqual(readMeta(c3).nm[nmKeyOf({ id: 'price_ohlc_cst' }, 'cst', 'none', 'X')], { avg: 5, std: 1 })
                assert.strictEqual(l4.filter((s) => /之std非有限正數\(.+\), nm改採\{avg:5,std:1\}/.test(s)).length, 1, '預設(key)路徑之警告亦如實(僅log文字改變, 寫出之nm不變)')
            })

            it('真實calc(內建目錄之rsi)之筆數下限: nm期間內有效值恰50筆之期別收、49筆者不收(以dataConvert回傳之各期n為準); 不收者沿用鍵層之值', async function() {
                this.timeout(120000)
                //captureProbe, 攔截buildParams內計算nm之探測呼叫(denyOutput為true)之回傳列(各期統計periods含n); 替身於finally還原
                let captureProbe = async (c, opt) => {
                    let real = wdt.dataConvert
                    let rows = []
                    wdt.dataConvert = async (...args) => {
                        let rs = await real(...args)
                        if (args[9] && args[9].denyOutput === true) {
                            rows.push(...rs)
                        }
                        return rs
                    }
                    try {
                        await buildParams(c, opt)
                    }
                    finally {
                        wdt.dataConvert = real
                    }
                    assert.strictEqual(wdt.dataConvert, real, '替身須已還原')
                    return rows
                }
                //先以夠長之nm期間(全部600根)得各期別之根數, 取第3小者為樞紐(使窗大小可使其n恰為50或49)
                let cL = await mkRoot('nm-minn-long', 600)
                await buildParams(cL, { only: ['price_ohlc_rsi'], nmScope: 'period', nmStat: 'meanStd' })
                let metaL = readMeta(cL)
                let barsOf = (lb) => periodInfo(lb, { intervalSec: 14400 }).bars
                let bl = Object.keys(Object.values(metaL.nm)[0].byPeriod).map((lb) => ({ lb, bars: barsOf(lb) })).sort((a, b) => a.bars - b.bars)
                assert.ok(bl.length >= 5)
                let pivot = bl[2]
                let ohlc = JSON.parse(fs.readFileSync(path.resolve(cL.fds.ohlc, `${cL.keyOhlc}.json`), 'utf8'))
                //窗取三個相鄰大小(樞紐期別之n隨窗每根增1; rsi之n與根數之差由實測之n得知, 不假設): 其n須跨過下限(含49與50)
                let sawBoundary = { [MIN_N]: 0, [MIN_N - 1]: 0 }
                let pivotNs = []
                for (let w of [pivot.bars + MIN_N - 2, pivot.bars + MIN_N - 1, pivot.bars + MIN_N]) {
                    let c = await mkRoot(`nm-minn-${w}`, 600)
                    let rows = await captureProbe(c, { only: ['price_ohlc_rsi'], nmScope: 'period', nmStat: 'meanStd', nmPeriod: { timeStart: ohlc[0].time, timeEnd: ohlc[w - 1].time } })
                    let meta = readMeta(c)
                    assert.ok(rows.length >= 2, `w=${w} 之回傳列數`)
                    for (let r of rows) {
                        let nk = nmKeyOf({ id: 'price_ohlc_rsi' }, r.method, r.keyIn, r.keyOut)
                        let want = r.periods.filter((p) => p.n >= MIN_N && p.std > 0).map((p) => p.period)
                        assert.deepStrictEqual(Object.keys(meta.nm[nk].byPeriod), want, `w=${w} ${nk}`)
                        for (let p of r.periods) {
                            if (p.n === MIN_N || p.n === MIN_N - 1) {
                                sawBoundary[p.n]++
                            }
                        }
                        //前提: 此窗下確有被下限排除之期別(n小於下限者不為空)
                        assert.ok(r.periods.some((p) => p.n < MIN_N), `w=${w} ${nk} 須有n小於下限之期別`)
                    }
                    //樞紐期別: n至少50收、否則不收
                    let rP = rows[0]
                    let nkP = nmKeyOf({ id: 'price_ohlc_rsi' }, rP.method, rP.keyIn, rP.keyOut)
                    let nP = rP.periods.find((p) => p.period === pivot.lb).n
                    pivotNs.push(nP)
                    assert.strictEqual(Object.keys(meta.nm[nkP].byPeriod).includes(pivot.lb), nP >= MIN_N, `w=${w} 樞紐期別${pivot.lb}(n=${nP})之收或不收`)
                }
                assert.ok(sawBoundary[MIN_N] > 0 && sawBoundary[MIN_N - 1] > 0, '前提: 三個窗下各有n恰為50與49之期別')
                assert.ok(pivotNs.some((n) => n === MIN_N - 1) && pivotNs.some((n) => n === MIN_N), `前提: 樞紐期別之n須跨過下限(實得${pivotNs.join(',')})`)
            })

            it('回傳之nmComputed與各鍵數不因取法而異(僅取法不同)', async function() {
                let cA = await mkRoot('nm-cnt-a')
                let cB = await mkRoot('nm-cnt-b')
                let rA = await bp(cA)
                let rB = await bp(cB, { nmScope: 'period', nmStat: 'medianIqr' })
                assert.strictEqual(rA.nmComputed, 2)
                assert.strictEqual(rB.nmComputed, 2)
                assert.deepStrictEqual(rA.keys, rB.keys)
            })

            it('真實calc(內建目錄之rsi): period + medianIqr 之各收入期別輸出中位數約0、四分位距約1.349; period + meanStd 之平均約0、標準差約1', async function() {
                this.timeout(120000)
                for (let stat of ['medianIqr', 'meanStd']) {
                    let { cfg } = cfgOf(fdTmp, 600, { root: path.resolve(fdTmp, `nm-real-${stat}`) })
                    let c = normalizeCfg(cfg)
                    await buildOhlc(c)
                    await buildParams(c, { only: ['price_ohlc_rsi'], nmScope: 'period', nmStat: stat })
                    let meta = readMeta(c)
                    let def = CATALOG.find((d) => d.id === 'price_ohlc_rsi')
                    let nks = Object.keys(meta.nm)
                    assert.ok(nks.length >= 5, stat)
                    let nChecked = 0
                    for (let nk of nks) {
                        let [id, method, keyIn, keyOut] = nk.split('|')
                        let periods = Object.keys(meta.nm[nk].byPeriod)
                        assert.ok(periods.length >= 5, `${stat} ${keyOut} 之收入期別數`)
                        for (let p of periods) {
                            let ser = JSON.parse(fs.readFileSync(path.resolve(c.fds.param, `${def.cointpe}_${def.keyKind}_${keyIn}_${keyOut}_${method}_${p}.json`), 'utf8')).map((v) => v.param)
                            let b = brute(ser)
                            if (stat === 'medianIqr') {
                                assert.ok(Math.abs(b.median) < 1e-9 && Math.abs((b.q75 - b.q25) - 1.349) < 1e-9, `${keyOut} ${p}`)
                            }
                            else {
                                assert.ok(Math.abs(b.avg) < 1e-9 && Math.abs(b.std - 1) < 1e-9, `${keyOut} ${p}`)
                            }
                            nChecked++
                        }
                        assert.strictEqual(id, 'price_ohlc_rsi')
                    }
                    assert.ok(nChecked >= 25, `${stat} 檢查之序列數`)
                }
            })

        })

        describe('凍結與沿用', function() {

            it('已凍結(period + meanStd)後以不同取法重跑 ⇒ 輸出與meta逐位元組不變、回傳為凍結之取法、log一行; 給相同值不log; recalibrate才改', async function() {
                let c = await mkRoot('nm-frz')
                await bp(c, { nmScope: 'period', nmStat: 'meanStd' })
                let meta0 = readMetaRaw(c)
                let shas0 = paramShas(c)
                let logs = []
                let logReal = console.log
                console.log = (...a) => {
                    logs.push(a.join(' '))
                }
                let r2
                let r3
                try {
                    r2 = await bp(c, { nmScope: 'key', nmStat: 'medianIqr', useShowLog: true })
                    let n2 = logs.filter((s) => s.includes('沿用meta凍結之nmScope[period]與nmStat[meanStd]')).length
                    assert.strictEqual(n2, 1, '本次所給不同時log一行')
                    logs.length = 0
                    r3 = await bp(c, { nmScope: 'period', nmStat: 'meanStd', useShowLog: true })
                    assert.strictEqual(logs.filter((s) => s.includes('沿用meta凍結之nmScope')).length, 0, '本次所給相同不log')
                    logs.length = 0
                    await bp(c, { useShowLog: true })
                    assert.strictEqual(logs.filter((s) => s.includes('沿用meta凍結之nmScope')).length, 0, '本次未給不log')
                    logs.length = 0
                    await bp(c, { nmStat: 'medianIqr', useShowLog: true })
                    assert.strictEqual(logs.filter((s) => s.includes('沿用meta凍結之nmScope[period]與nmStat[meanStd]')).length, 1, '只給其一不同亦log')
                }
                finally {
                    console.log = logReal
                }
                assert.deepStrictEqual([r2.nmScope, r2.nmStat, r2.nmComputed], ['period', 'meanStd', 0])
                assert.deepStrictEqual([r3.nmScope, r3.nmStat, r3.nmComputed], ['period', 'meanStd', 0])
                assert.strictEqual(readMetaRaw(c), meta0)
                assert.deepStrictEqual(paramShas(c), shas0)
                //recalibrate: 改為所給之取法
                let r4 = await bp(c, { nmScope: 'key', nmStat: 'medianIqr', recalibrate: true })
                assert.deepStrictEqual([r4.nmScope, r4.nmStat], ['key', 'medianIqr'])
                assert.ok(r4.nmComputed > 0)
                let meta4 = readMeta(c)
                assert.deepStrictEqual([meta4.nmScope, meta4.nmStat], ['key', 'medianIqr'])
                assert.ok(!('byPeriod' in meta4.nm[nkX]))
                assert.notDeepStrictEqual(paramShas(c), shas0)
                //recalibrate並回預設: 不寫入nmScope與nmStat, 與全新之預設工作根之meta逐位元組相同
                let r5 = await bp(c, { recalibrate: true })
                assert.deepStrictEqual([r5.nmScope, r5.nmStat], ['key', 'meanStd'])
                let cD = await mkRoot('nm-frz-def')
                await bp(cD)
                assert.strictEqual(readMetaRaw(c), readMetaRaw(cD))
                assert.deepStrictEqual(paramShas(c), paramShas(cD))
            })

            it('既有之meta(無nmScope與nmStat)視為預設: 以period或medianIqr重跑(不recalibrate)仍為預設且不變, log一行; recalibrate後才改', async function() {
                let c = await mkRoot('nm-legacy')
                await bp(c)
                let meta0 = readMeta(c)
                assert.ok(!('nmScope' in meta0) && !('nmStat' in meta0))
                let raw0 = readMetaRaw(c)
                let shas0 = paramShas(c)
                let logs = []
                let logReal = console.log
                console.log = (...a) => {
                    logs.push(a.join(' '))
                }
                let r
                try {
                    r = await bp(c, { nmScope: 'period', nmStat: 'medianIqr', useShowLog: true })
                }
                finally {
                    console.log = logReal
                }
                assert.deepStrictEqual([r.nmScope, r.nmStat, r.nmComputed], ['key', 'meanStd', 0])
                assert.strictEqual(logs.filter((s) => s.includes('沿用meta凍結之nmScope[key]與nmStat[meanStd]')).length, 1)
                assert.strictEqual(readMetaRaw(c), raw0)
                assert.deepStrictEqual(paramShas(c), shas0)
                //meta內之nmScope與nmStat無效 ⇒ throw(固定訊息)
                let metaFile = path.resolve(c.fds.meta, 'params.json')
                for (let [k, v, msg] of [['nmScope', 'x', MSG_META_SCOPE], ['nmStat', 5, MSG_META_STAT], ['nmScope', null, MSG_META_SCOPE]]) {
                    fs.writeFileSync(metaFile, JSON.stringify({ ...meta0, [k]: v }))
                    await assert.rejects(bp(c), { message: msg })
                }
                //訊息所示之處置屬實: opt.recalibrate捨棄meta重算, 不再被壞值擋下
                fs.writeFileSync(metaFile, JSON.stringify({ ...meta0, nmScope: 'x' }))
                let rFix = await bp(c, { recalibrate: true })
                assert.deepStrictEqual([rFix.nmScope, rFix.nmStat], ['key', 'meanStd'])
                assert.ok(!('nmScope' in readMeta(c)) && !('nmStat' in readMeta(c)))
                fs.writeFileSync(metaFile, JSON.stringify(meta0))
                //recalibrate
                let r2 = await bp(c, { nmScope: 'period', nmStat: 'medianIqr', recalibrate: true })
                assert.deepStrictEqual([r2.nmScope, r2.nmStat], ['period', 'medianIqr'])
                assert.ok(readMeta(c).nm[nkX].byPeriod)
            })

            it('已凍結為period之工作根加入新定義(不recalibrate): 新鍵以凍結之取法自算(含byPeriod)、既有鍵之nm與序列逐位元組不變', async function() {
                let c = await mkRoot('nm-add')
                await bp(c, { nmScope: 'period', nmStat: 'medianIqr' })
                let meta0 = readMeta(c)
                let shas0 = paramShas(c)
                let r = await bp(c, { defs: [defMyx(), { ...defMyx('price_ohlc_myx2'), keyKind: 'alt' }] }) //新定義之keyKind不同, 輸出檔名不與既有者重疊
                assert.deepStrictEqual([r.nmScope, r.nmStat, r.nmComputed], ['period', 'medianIqr', 2])
                let meta1 = readMeta(c)
                for (let [k, v] of Object.entries(meta0.nm)) {
                    assert.deepStrictEqual(meta1.nm[k], v, `既有nm不變: ${k}`)
                }
                let nk2 = nmKeyOf({ id: 'price_ohlc_myx2' }, 'myx', 'none', 'X')
                assert.deepStrictEqual(meta1.nm[nk2], meta0.nm[nkX], '同一資料同一取法之新鍵 = 既有鍵之值')
                assert.deepStrictEqual(Object.keys(meta1.nm[nk2].byPeriod), PERIODS_IN)
                for (let [fn, h] of Object.entries(shas0)) {
                    assert.strictEqual(paramShas(c)[fn], h, `既有序列不變: ${fn}`)
                }
                assert.deepStrictEqual([meta1.nmScope, meta1.nmStat], ['period', 'medianIqr'])
            })

        })

        describe('選項檢核與定義自帶nm', function() {

            //BAD_COMMON, 兩個選項皆無效之值(含大小寫不同、空字串、各型別); 另各加對方之合法值(nmScope收'key'與'period'、nmStat收'meanStd'與'medianIqr')
            let BAD_COMMON = ['x', 'Key', 'PERIOD', 'Period', 'MeanStd', 'medianiqr', 'sk-secret-7q9x', '', ' key', 'key ', 1, 0, true, false, [], ['key'], {}, NaN, () => 'key', Symbol('k'), 1n]
            let BAD_SCOPE = [...BAD_COMMON, 'meanStd', 'medianIqr']
            let BAD_STAT = [...BAD_COMMON, 'key', 'period']

            it('opt.nmScope給了而無效 ⇒ throw固定訊息(不含輸入值)、先於任何寫檔(param夾與meta/params.json皆不產生); null與undefined視為未給', async function() {
                let c = await mkRoot('nm-bad1')
                for (let [i, v] of BAD_SCOPE.entries()) {
                    await assert.rejects(bp(c, { nmScope: v }), (e) => e.message === MSG_SCOPE, `nmScope 案${i}`)
                    assert.ok(!fs.existsSync(c.fds.param), `nmScope 案${i} 不得建夾`)
                    assert.ok(!fs.existsSync(path.resolve(c.fds.meta, 'params.json')), `nmScope 案${i} 不得寫meta`)
                }
                let r = await bp(c, { nmScope: null, nmStat: undefined })
                assert.deepStrictEqual([r.nmScope, r.nmStat], ['key', 'meanStd'])
            })

            it('opt.nmStat給了而無效 ⇒ throw固定訊息(不含輸入值)、先於任何寫檔; 兩者皆無效時先報nmScope', async function() {
                let c = await mkRoot('nm-bad2')
                for (let [i, v] of BAD_STAT.entries()) {
                    await assert.rejects(bp(c, { nmStat: v }), (e) => e.message === MSG_STAT, `nmStat 案${i}`)
                    assert.ok(!fs.existsSync(c.fds.param), `nmStat 案${i} 不得建夾`)
                    assert.ok(!fs.existsSync(path.resolve(c.fds.meta, 'params.json')), `nmStat 案${i} 不得寫meta`)
                }
                await assert.rejects(bp(c, { nmScope: 'x', nmStat: 'y' }), (e) => e.message === MSG_SCOPE)
                await assert.rejects(bp(c, { nmScope: 'period', nmStat: 'y' }), (e) => e.message === MSG_STAT)
            })

            it('無效之opt.nmScope與opt.nmStat先於口徑標記之寫入(非4hr之工作根): 拋錯後meta/basis.json未寫、param夾未建; 其後合法之呼叫才寫標記', async function() {
                let { cfg } = cfgOf(fdTmp, 400, { root: path.resolve(fdTmp, 'nm-bad-basis'), interval: '1day', intervalSec: 86400, stepMs: 86400 * 1000 })
                let c = normalizeCfg(cfg)
                await buildOhlc(c)
                let fpBasis = path.resolve(c.fds.meta, 'basis.json')
                assert.ok(!fs.existsSync(fpBasis), '前提: buildOhlc只檢查不寫標記')
                await assert.rejects(bp(c, { nmScope: 'x' }), (e) => e.message === MSG_SCOPE)
                await assert.rejects(bp(c, { nmStat: 'x' }), (e) => e.message === MSG_STAT)
                assert.ok(!fs.existsSync(fpBasis), '無效選項不得寫口徑標記')
                assert.ok(!fs.existsSync(c.fds.param), '無效選項不得建param夾')
                await bp(c, { nmScope: 'period' })
                assert.ok(fs.existsSync(fpBasis), '前提: 合法之呼叫於非4hr寫標記(使上列之未寫有鑑別力)')
            })

            it('經管線(createPipeline)之兩個呼叫點: pl.buildParams(opt) 與 pl.prepare({ paramsOpt })皆把nmScope與nmStat傳至buildParams(無效即拋、合法者生效並凍結)', async function() {
                this.timeout(120000)
                let { cfg } = cfgOf(fdTmp, 300, { root: path.resolve(fdTmp, 'nm-pl') })
                let pl = createPipeline(cfg)
                await pl.buildOhlc()
                //呼叫點1: pl.buildParams
                await assert.rejects(pl.buildParams({ only: ['price_ohlc_rsi'], nmScope: 'x' }), (e) => e.message === MSG_SCOPE)
                assert.ok(!fs.existsSync(path.resolve(pl.cfg.fds.meta, 'params.json')), 'pl.buildParams 無效選項不得寫meta')
                let r1 = await pl.buildParams({ only: ['price_ohlc_rsi'], nmScope: 'period', nmStat: 'medianIqr' })
                assert.deepStrictEqual([r1.nmScope, r1.nmStat], ['period', 'medianIqr'])
                assert.deepStrictEqual([readMeta(pl.cfg).nmScope, readMeta(pl.cfg).nmStat], ['period', 'medianIqr'])
                //呼叫點2: pl.prepare({ paramsOpt })(另一個全新之工作根)
                let { cfg: cfg2 } = cfgOf(fdTmp, 300, { root: path.resolve(fdTmp, 'nm-pl2') })
                let pl2 = createPipeline(cfg2)
                await assert.rejects(pl2.prepare({ cache: false, paramsOpt: { only: ['price_ohlc_rsi'], nmStat: 'x' } }), (e) => e.message === MSG_STAT)
                let r2 = await pl2.prepare({ cache: false, paramsOpt: { only: ['price_ohlc_rsi'], nmScope: 'period' } })
                assert.deepStrictEqual([r2.params.nmScope, r2.params.nmStat], ['period', 'meanStd'])
                assert.deepStrictEqual([readMeta(pl2.cfg).nmScope, readMeta(pl2.cfg).nmStat], ['period', 'meanStd'])
            })

            it('resolveNmOpt: 未給回null、合法值原樣回傳、無效throw固定訊息; opt非物件亦視為未給', function() {
                assert.deepStrictEqual(resolveNmOpt({}), { nmScope: null, nmStat: null })
                assert.deepStrictEqual(resolveNmOpt(undefined), { nmScope: null, nmStat: null })
                assert.deepStrictEqual(resolveNmOpt(null), { nmScope: null, nmStat: null })
                for (let s of ['key', 'period']) {
                    for (let t of ['meanStd', 'medianIqr']) {
                        assert.deepStrictEqual(resolveNmOpt({ nmScope: s, nmStat: t }), { nmScope: s, nmStat: t })
                    }
                }
                assert.deepStrictEqual(resolveNmOpt({ nmScope: 'period' }), { nmScope: 'period', nmStat: null })
                assert.throws(() => resolveNmOpt({ nmScope: 'x' }), { message: MSG_SCOPE })
                assert.throws(() => resolveNmOpt({ nmStat: 'x' }), { message: MSG_STAT })
            })

            it('nmOfStat: meanStd取平均與標準差(標準差須有限且大於0); medianIqr取中位數與(q75 − q25) ÷ 1.349, 尺度不可用者退回平均與標準差, 仍不行為null', function() {
                let st = { avg: 10, std: 2, median: 8, q25: 7, q75: 9.349 }
                assert.deepStrictEqual(nmOfStat(st, 'meanStd'), { avg: 10, std: 2 })
                assert.deepStrictEqual(nmOfStat(st, 'medianIqr'), { avg: 8, std: (9.349 - 7) / 1.349 })
                //meanStd之無效
                for (let bad of [0, -1, NaN, Infinity, null, undefined, '2']) {
                    assert.strictEqual(nmOfStat({ ...st, std: bad }, 'meanStd'), null, 'std')
                }
                for (let bad of [NaN, Infinity, -Infinity, null, undefined]) {
                    assert.strictEqual(nmOfStat({ ...st, avg: bad }, 'meanStd'), null, 'avg')
                }
                //medianIqr之尺度不可用 ⇒ 退回平均與標準差
                for (let patch of [{ q75: 7 }, { q75: 6 }, { q75: NaN }, { q25: Infinity }, { q75: undefined }, { median: NaN }, { median: null }, { median: Infinity }]) {
                    assert.deepStrictEqual(nmOfStat({ ...st, ...patch }, 'medianIqr'), { avg: 10, std: 2 }, JSON.stringify(Object.keys(patch)))
                }
                //兩者皆不可用
                assert.strictEqual(nmOfStat({ ...st, q75: 7, std: 0 }, 'medianIqr'), null)
                assert.strictEqual(nmOfStat({ avg: null, std: null, median: null, q25: null, q75: null }, 'medianIqr'), null)
            })

            it('nmByPeriodOf: 只收n至少50(MIN_N)且尺度大於0之期別, 依輸入次序; meanStd與medianIqr各依其取法(medianIqr之尺度不可用者退回該期之平均與標準差)', function() {
                let periods = [
                    { period: 'a', n: 50, avg: 1, std: 2, median: 0, q25: -1, q75: 1 },
                    { period: 'b', n: 1, avg: 3, std: null, median: 3, q25: 3, q75: 3 },
                    { period: 'c', n: 70, avg: 5, std: 0, median: 5, q25: 5, q75: 5 }, //筆數足而尺度為0者不收
                    { period: 'd', n: 0, avg: null, std: null, median: null, q25: null, q75: null },
                    { period: 'e', n: 60, avg: 7, std: 3, median: 7, q25: 7, q75: 7 }, //四分位距為0 ⇒ medianIqr退回平均與標準差
                    { period: 'f', n: MIN_N, avg: 4, std: 1, median: 4, q25: 3.5, q75: 4.5 }, //恰為下限者收
                    { period: 'g', n: undefined, avg: 4, std: 1, median: 4, q25: 3.5, q75: 4.5 },
                    { period: 'h', n: MIN_N - 1, avg: 4, std: 1, median: 4, q25: 3.5, q75: 4.5 }, //差1筆者即使統計值有效亦不收
                    { period: 'i', n: 2, avg: 4, std: 1, median: 4, q25: 3.5, q75: 4.5 }, //原下限(2筆)者不收
                    { period: 'j', n: MIN_N + 1, avg: 6, std: 5, median: 6, q25: 2, q75: 10 },
                    { period: 'k', n: '50', avg: 6, std: 5, median: 6, q25: 2, q75: 10 }, //n非數值(字串)者不收
                ]
                assert.deepStrictEqual(nmByPeriodOf(periods, 'meanStd'), { a: { avg: 1, std: 2 }, e: { avg: 7, std: 3 }, f: { avg: 4, std: 1 }, j: { avg: 6, std: 5 } })
                assert.deepStrictEqual(Object.keys(nmByPeriodOf(periods, 'medianIqr')), ['a', 'e', 'f', 'j'])
                assert.deepStrictEqual(nmByPeriodOf(periods, 'medianIqr'), { a: { avg: 0, std: 2 / 1.349 }, e: { avg: 7, std: 3 }, f: { avg: 4, std: 1 / 1.349 }, j: { avg: 6, std: 8 / 1.349 } })
                assert.deepStrictEqual(nmByPeriodOf([], 'meanStd'), {})
            })

            it('定義自帶nm含byPeriod: 原樣凍結於meta、輸出依之(有鍵之期別用自己之avg與std, 其餘用nm); 自帶nm不含byPeriod時與現行相同; opt.nmScope不影響自帶nm', async function() {
                let nm = { avg: 3, std: 5, byPeriod: { p1: { avg: 1, std: 2 } } }
                let defs = [defMyx('price_ohlc_myx', nm)]
                for (let [tag, extra] of [['預設', {}], ['period', { nmScope: 'period', nmStat: 'medianIqr' }]]) {
                    let c = await mkRoot(`nm-self-${tag}`)
                    await buildParams(c, { defs, calcs: { myx: calcMyx }, ...extra })
                    let meta = readMeta(c)
                    assert.deepStrictEqual(meta.nm[nkX], nm, tag)
                    let raw = await rawOf(c)
                    assert.deepStrictEqual(readSer(c, 'p1'), viaJson(raw.p1.map((x) => (x - 1) / 2)), `${tag} p1`)
                    assert.deepStrictEqual(readSer(c, 'p2'), viaJson(raw.p2.map((x) => (x - 3) / 5)), `${tag} p2`)
                    //另一輸出欄(Z)未自帶nm: 依取法自算
                    assert.ok(nkZ in meta.nm)
                    assert.strictEqual('byPeriod' in meta.nm[nkZ], extra.nmScope === 'period', tag)
                }
                //自帶nm不含byPeriod(含null)時與現行相同: 只有avg與std
                for (let bp0 of [undefined, null]) {
                    let c = await mkRoot(`nm-self-nobp-${String(bp0)}`)
                    await buildParams(c, { defs: [defMyx('price_ohlc_myx', { avg: 3, std: 5, byPeriod: bp0 })], calcs: { myx: calcMyx } })
                    assert.deepStrictEqual(readMeta(c).nm[nkX], { avg: 3, std: 5 })
                }
            })

            it('定義自帶nm之byPeriod無效 ⇒ 由dataConvert檢核而reject(固定訊息)、不寫meta/params.json', async function() {
                for (let [i, bad] of [{ p1: { avg: 1, std: 0 } }, { p1: { avg: '1', std: 2 } }, 'x', [], { p1: null }].entries()) {
                    let c = await mkRoot(`nm-self-bad${i}`)
                    await assert.rejects(buildParams(c, { defs: [defMyx('price_ohlc_myx', { avg: 3, std: 5, byPeriod: bad })], calcs: { myx: calcMyx } }), { message: MSG_BY_PERIOD }, `案${i}`)
                    assert.ok(!fs.existsSync(path.resolve(c.fds.meta, 'params.json')), `案${i}`)
                }
            })

        })

        describe('所裝之w-data-trade較舊(dataConvert回傳之列無periods、median、q25、q75)', function() {

            it('以替身去除新欄位模擬: nmScope為period或nmStat為medianIqr ⇒ throw固定訊息(不寫meta); 預設仍可運作且輸出與正常相同; 替身已還原', async function() {
                let real = wdt.dataConvert
                let stripped = async (...args) => (await real(...args)).map((r) => {
                    let o = { ...r }
                    for (let k of NEW_COLS) {
                        delete o[k]
                    }
                    return o
                })
                let cN = await mkRoot('nm-oldN')
                await bp(cN)
                let cS = await mkRoot('nm-oldS')
                let cA = await mkRoot('nm-oldA')
                let cB = await mkRoot('nm-oldB')
                wdt.dataConvert = stripped
                try {
                    await assert.rejects(bp(cA, { nmScope: 'period' }), { message: MSG_OLD })
                    await assert.rejects(bp(cB, { nmStat: 'medianIqr' }), { message: MSG_OLD })
                    await bp(cS)
                }
                finally {
                    wdt.dataConvert = real
                }
                assert.strictEqual(wdt.dataConvert, real, '替身須已還原')
                assert.ok(!fs.existsSync(path.resolve(cA.fds.meta, 'params.json')))
                assert.ok(!fs.existsSync(path.resolve(cB.fds.meta, 'params.json')))
                assert.strictEqual(readMetaRaw(cS), readMetaRaw(cN))
                assert.deepStrictEqual(paramShas(cS), paramShas(cN))
            })

            it('已凍結為period之meta於舊版w-data-trade下重跑且無須自算之鍵(nm皆已凍結)時不throw(不需新欄位); 有新鍵須自算時throw', async function() {
                let c = await mkRoot('nm-oldF')
                await bp(c, { nmScope: 'period', nmStat: 'meanStd' })
                let real = wdt.dataConvert
                wdt.dataConvert = async (...args) => (await real(...args)).map((r) => {
                    let o = { ...r }
                    for (let k of NEW_COLS) {
                        delete o[k]
                    }
                    return o
                })
                try {
                    let r = await bp(c)
                    assert.strictEqual(r.nmComputed, 0)
                    await assert.rejects(bp(c, { defs: [defMyx(), { ...defMyx('price_ohlc_myx2'), keyKind: 'alt' }] }), { message: MSG_OLD })
                }
                finally {
                    wdt.dataConvert = real
                }
            })

        })

    })

})
