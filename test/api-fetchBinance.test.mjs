import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { getIntervalPlan } from 'w-dwdata-binance/src/intervals.mjs'
import normalizeCfg, { rawKeyOf } from '../src/cfg.mjs'
import fetchBinance from '../src/data/fetchBinance.mjs'
import buildOhlc from '../src/data/buildOhlc.mjs'
import { makeOtt } from '../src/util/ott.mjs'
import { buildFdTmp } from './tools/synthKit.mjs'
import { STEPS, fmt8, barOf, createFakeExchange } from './tools/fakeExchange.mjs'


//規格來源: 規則帳本TS-24與README之〈3. 數據〉 —— 依指定時區之界線合成之日線由w-dwdata-binance提供, 本套件不自行聚合; 只傳interval與timeZone, 有給時轉傳aggregateFrom; 核對回來之序列之格線
//  fetchBinance: cfg.aggregateFrom有給時原樣轉傳; 未給時一律不傳, 由下載套件之預設('auto')決定(任何週期鍵同一規則: 台北與UTC之4hr直接下載、東京與加爾各答之4hr合併、紐約之4hr於normalizeCfg即拋; 明給'none'者於任何時區直接下載); 須合併時價格與溢價指數以同一設定呼叫、同一合併輸出夾(rawKeyOf), 取得方式與未輸出之目標根記於meta/aggregate.json; 直接下載(台北之4hr等)時資料夾為interval、不寫該檔
//  buildOhlc: 讀rawKeyOf(cfg)之資料夾(須合併者為'<週期鍵>_tz<±HHMM>_d<YYYYMMDD>_from<基底>')
//  假交易所(本機HTTP, 作業系統配發之埠): 只回30m、1h、4h之根(STEPS), 各欄逐根相異(價格欄為8位小數字串), 只回開盤不晚於現在者


let fdTmp = buildFdTmp('fetch')
let H4 = 4 * 3600 * 1000

//期間內有洞: 預設放行(記錄並console.warn提示一則, 內容只含序列名與洞數); 明給opt.allowGaps: false(嚴格模式)時於寫檔前throw(V19: invalid <名稱>: must …)
let MSG_GAP_PRICE = 'invalid price series: must not have missing bars within the period when opt.allowGaps is false'
let MSG_GAP_INDEX = 'invalid index series: must not have missing bars within the period when opt.allowGaps is false'
let msgWarnOf = (s) => `[w-trade-strategy] buildOhlc: skipped missing bars within the period (${s}); recorded in meta/ohlc.json (gaps)`

//capWarn: 擷取fn執行期間之console.warn(結束後還原), 回傳訊息陣列
let capWarn = async (fn) => {
    let warns = []
    let warn0 = console.warn
    console.warn = (...a) => {
        warns.push(a.join(' '))
    }
    try {
        await fn()
    }
    finally {
        console.warn = warn0
    }
    return warns
}

let ex = null //假交易所之狀態物件{nowCap,skip,reqs}
let fx = null
let epOf = null


describe('api-fetchBinance(與w-dwdata-binance之對接)', function() {

    before(async function() {
        fx = await createFakeExchange()
        ex = fx.ex
        epOf = fx.epOf
    })

    after(async function() {
        await fx.close()
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('1day＋aggregateFrom 4hr(台北): 下載4h合併為台北00:00起訖之日線, 價格與溢價指數同一合併輸出夾 = rawKeyOf; meta/aggregate.json記取得方式與未輸出之目標根; buildOhlc讀合併夾, 各欄等於6根4h之合併', async function() {
        this.timeout(120000)
        let tz = 'Asia/Taipei'
        let ott = makeOtt(tz)
        let dayStart = ott().add(-20, 'day').format('YYYY-MM-DD')
        let c = normalizeCfg({ root: path.resolve(fdTmp, 'd1'), name: 'TST', symbol: 'TSTUSDT', interval: '1day', aggregateFrom: '4hr', timeZone: tz, dayStart })
        let key = `1day_tz+0800_d${dayStart.split('-').join('')}_from4hr`
        assert.strictEqual(rawKeyOf(c), key)
        ex.reqs = []
        let r = await fetchBinance(c, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
        assert.ok(ex.reqs.length > 0 && ex.reqs.every((v) => v.interval === '4h'), JSON.stringify(ex.reqs.slice(0, 3)))
        assert.strictEqual(r.price.aggregate.key, key)
        assert.strictEqual(r.index.aggregate.key, key)
        assert.strictEqual(r.price.aggregate.base, '4hr')
        assert.strictEqual(r.price.aggregate.count, 6)
        assert.ok(fs.existsSync(path.resolve(c.fds.raw, 'TST', 'price', key)))
        assert.ok(!fs.existsSync(path.resolve(c.fds.raw, 'TST', 'price', '1day'))) //不寫入直接下載之資料夾
        let ma = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'aggregate.json'), 'utf8'))
        assert.strictEqual(ma.key, key)
        assert.strictEqual(ma.base, '4hr')
        assert.strictEqual(ma.utcOffset, 480)
        assert.ok(ma.price.nMissing >= 1 && ma.price.missing.some((v) => v.reason === 'open'), JSON.stringify(ma.price.missing)) //當日未收
        assert.strictEqual(ma.index.nMissing, ma.index.missing.length)
        let ro = await buildOhlc(c)
        let p = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, 'TST_price_1day.json'), 'utf8'))
        let ix = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, 'TST_index_1day.json'), 'utf8'))
        assert.ok(p.length >= 18 && p.length === ro.nPrice, `${p.length}`)
        assert.strictEqual(ix.length, p.length)
        for (let [arr, type] of [[p, 'price'], [ix, 'index']]) {
            for (let d of arr) {
                assert.ok(d.time.endsWith('T00:00:00'), d.time)
                let k0 = ott(d.time).valueOf() / H4
                let bs = [0, 1, 2, 3, 4, 5].map((j) => barOf(type, k0 + j))
                let sum = (f) => bs.reduce((t, b) => t + b[f], 0n)
                let mx = (f) => bs.reduce((t, b) => (b[f] > t ? b[f] : t), bs[0][f])
                let mn = (f) => bs.reduce((t, b) => (b[f] < t ? b[f] : t), bs[0][f])
                assert.strictEqual(d.Open, Number(fmt8(bs[0].o)), `${type} ${d.time} Open`)
                assert.strictEqual(d.High, Number(fmt8(mx('h'))), `${type} ${d.time} High`)
                assert.strictEqual(d.Low, Number(fmt8(mn('l'))), `${type} ${d.time} Low`)
                assert.strictEqual(d.Close, Number(fmt8(bs[5].c)), `${type} ${d.time} Close`)
                if (type === 'price') {
                    assert.strictEqual(d.Volumn, Number(fmt8(sum('v'))), `${d.time} Volumn`)
                    assert.strictEqual(d.QuoteAssetVolume, Number(fmt8(sum('q'))), `${d.time} Quote`)
                    assert.strictEqual(d.NumberOfTrades, bs.reduce((t, b) => t + b.n, 0), `${d.time} Trades`)
                    assert.strictEqual(d.TakerBuyBaseAssetVolume, Number(fmt8(sum('tb'))), `${d.time} TB`)
                }
            }
        }
    })

    //期間內之洞之案共用: 1day(由假交易所之4h合併, 台北); 回傳{build, fmt, dP, dP2, dIs, onlyNames}
    let gapEnv = () => {
        let tz = 'Asia/Taipei'
        let ott = makeOtt(tz)
        let dayStart = ott().add(-20, 'day').format('YYYY-MM-DD')
        //兩序列各自之洞數與缺根數、只見於一方者之個數皆取不同之數(價格: 1個洞缺2根; 溢價指數: 3個洞共缺4根; 只見於價格者4、只見於溢價指數者2), 以分辨洞數與缺根數、價格與溢價指數
        let dP = ott(`${dayStart}T00:00:00`).add(5, 'day') //價格缺此日與次日之各6根4h(合併時該二日不輸出): 1個洞、缺2根
        let dP2 = dP.add(1, 'day')
        let dIs = [9, 10, 13, 16].map((n) => ott(`${dayStart}T00:00:00`).add(n, 'day')) //溢價指數缺此4日(各1根4h): 第9、10日相鄰為1個洞缺2根, 第13、16日各1個洞缺1根 = 3個洞共缺4根
        let fmt = (d) => d.format('YYYY-MM-DDTHH:mm:ss')
        let gapsI = [{ time: fmt(dIs[0]), bars: 2 }, { time: fmt(dIs[2]), bars: 1 }, { time: fmt(dIs[3]), bars: 1 }] //溢價指數之洞清單(洞內第1根缺漏之開盤時刻與缺根數)
        let inDay = (o, d) => o >= d.valueOf() && o < d.valueOf() + 6 * H4
        let skipI = (type, o) => type === 'index' && dIs.some((d) => o === d.valueOf() + 2 * H4)
        let skipP = (type, o) => type === 'price' && (inDay(o, dP) || inDay(o, dP2))
        let skips = {
            both: (type, o) => skipP(type, o) || skipI(type, o),
            index: skipI,
            price: skipP,
        }
        //build: 依缺根情境(skips之鍵或null)抓取一個新工作根, 回傳cfg與其K線檔、meta之路徑
        let build = async (name, skip) => {
            ex.skip = skip === null ? null : skips[skip]
            let c = normalizeCfg({ root: path.resolve(fdTmp, name), name: 'TST', symbol: 'TSTUSDT', interval: '1day', aggregateFrom: '4hr', timeZone: tz, dayStart })
            let r = await fetchBinance(c, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
            let fp = { p: path.resolve(c.fds.ohlc, 'TST_price_1day.json'), i: path.resolve(c.fds.ohlc, 'TST_index_1day.json'), m: path.resolve(c.fds.meta, 'ohlc.json') }
            return { c, r, fp }
        }
        //提示之內容只含序列名與洞數(不含時刻或其他輸入值)
        let onlyNames = (msg) => {
            assert.ok(!/\d{4}/.test(msg), msg) //無年份或時刻
            for (let s of [dayStart, fmt(dP), ...dIs.map(fmt), 'TSTUSDT', fdTmp, 'T00:00']) {
                assert.ok(!msg.includes(s), `${msg} 含[${s}]`)
            }
        }
        return { build, fmt, dP, dP2, dIs, gapsI, onlyNames }
    }

    it('交易所來源(非4hr)之期間內之洞(預設放行): opt.allowGaps預設放行, 略過並把各洞與根集合差記入meta/ohlc.json與回傳, console.warn提示一則, 內容只含序列名與洞數(只列有洞之序列); 尾端之未收棒不算洞', async function() {
        this.timeout(120000)
        let { build, fmt, dP, dP2, dIs, gapsI, onlyNames } = gapEnv()
        try {
            //價格與溢價指數各1個洞(且根集合不一致): 未給opt即放行
            let { c, r, fp } = await build('gap', 'both')
            assert.ok(r.price.aggregate.missing.some((v) => v.reason === 'gap'), JSON.stringify(r.price.aggregate.missing))
            let ro = null
            let w1 = await capWarn(async () => {
                ro = await buildOhlc(c)
            })
            assert.deepStrictEqual(ro.gaps.price, { nGaps: 1, nBars: 2, list: [{ time: fmt(dP), bars: 2 }] })
            assert.deepStrictEqual(ro.gaps.index, { nGaps: 3, nBars: 4, list: gapsI })
            assert.deepStrictEqual(ro.gaps.mismatch, { nOnlyPrice: 4, nOnlyIndex: 2, onlyPrice: dIs.map(fmt), onlyIndex: [fmt(dP), fmt(dP2)] })
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(fp.m, 'utf8')).gaps, ro.gaps)
            assert.ok(fs.existsSync(fp.p) && fs.existsSync(fp.i)) //略過洞而照常寫出K線
            assert.deepStrictEqual(w1, [msgWarnOf('price gaps: 1, index gaps: 3')]) //洞數(價格1個洞缺2根; 溢價指數3個洞共缺4根), 非缺根數
            onlyNames(w1[0])
            //只有溢價指數缺根: 提示只列溢價指數
            let b2 = await build('gap2', 'index')
            let ro2 = null
            let w2 = await capWarn(async () => {
                ro2 = await buildOhlc(b2.c)
            })
            assert.deepStrictEqual(ro2.gaps.price, { nGaps: 0, nBars: 0, list: [] })
            assert.deepStrictEqual(ro2.gaps.index, { nGaps: 3, nBars: 4, list: gapsI })
            assert.deepStrictEqual(w2, [msgWarnOf('index gaps: 3')])
            onlyNames(w2[0])
            //只有價格缺根(溢價指數完整): 提示只列價格
            let b3 = await build('gap3', 'price')
            let w3 = await capWarn(async () => {
                await buildOhlc(b3.c)
            })
            assert.deepStrictEqual(w3, [msgWarnOf('price gaps: 1')])
            onlyNames(w3[0])
        }
        finally {
            ex.skip = null
        }
    })

    it('交易所來源(非4hr)之期間內之洞(嚴格模式): 明給opt.allowGaps: false時遇洞於寫檔前throw(價格先於溢價指數; 兩序列根集合不一致者亦屬之), K線檔與meta/ohlc.json皆未寫, 不提示', async function() {
        this.timeout(120000)
        let { build } = gapEnv()
        try {
            let { c, fp } = await build('gap-s', 'both')
            let w1 = await capWarn(async () => {
                await assert.rejects(buildOhlc(c, { allowGaps: false }), (e) => e.message === MSG_GAP_PRICE)
            })
            assert.deepStrictEqual(w1, [])
            assert.ok(!fs.existsSync(fp.p) && !fs.existsSync(fp.i) && !fs.existsSync(fp.m)) //寫檔前即拋
            //只有溢價指數缺根: 溢價指數之訊息
            let b2 = await build('gap-s2', 'index')
            await assert.rejects(buildOhlc(b2.c, { allowGaps: false }), (e) => e.message === MSG_GAP_INDEX)
            assert.ok(!fs.existsSync(b2.fp.p) && !fs.existsSync(b2.fp.i) && !fs.existsSync(b2.fp.m))
            //只有價格缺根: 價格之訊息
            let b3 = await build('gap-s3', 'price')
            await assert.rejects(buildOhlc(b3.c, { allowGaps: false }), (e) => e.message === MSG_GAP_PRICE)
            assert.ok(!fs.existsSync(b3.fp.p) && !fs.existsSync(b3.fp.i) && !fs.existsSync(b3.fp.m))
        }
        finally {
            ex.skip = null
        }
    })

    it('opt.allowGaps只有明給false為嚴格(K3): 未給、undefined、null、true、字串、數字、物件、opt本身為null皆視為預設放行(記錄並提示一則)', async function() {
        this.timeout(120000)
        let { build } = gapEnv()
        try {
            let { c } = await build('gap-k3', 'both')
            let want = [msgWarnOf('price gaps: 1, index gaps: 3')]
            let ref = null
            for (let v of [undefined, null, true, 'false', 0, '', 1, {}, []]) {
                let ro = null
                let ws = await capWarn(async () => {
                    ro = await buildOhlc(c, { allowGaps: v })
                })
                ref = ref || ro.gaps
                assert.deepStrictEqual(ro.gaps, ref, `allowGaps=${JSON.stringify(v)}`)
                assert.deepStrictEqual(ws, want, `allowGaps=${JSON.stringify(v)}`)
            }
            let wn = await capWarn(async () => {
                await buildOhlc(c, null)
            })
            assert.deepStrictEqual(wn, want)
        }
        finally {
            ex.skip = null
        }
    })

    it('交易所來源(非4hr)無洞: 預設、明給true、明給false皆照常(gaps記0, 尾端之未收棒不算), 不提示', async function() {
        this.timeout(120000)
        let { build } = gapEnv()
        try {
            let { c, r } = await build('gap-0', null)
            assert.ok(r.price.aggregate.missing.some((v) => v.reason === 'open')) //尾端之未收棒(不屬期間內)
            let gaps0 = { price: { nGaps: 0, nBars: 0, list: [] }, index: { nGaps: 0, nBars: 0, list: [] }, mismatch: { nOnlyPrice: 0, nOnlyIndex: 0, onlyPrice: [], onlyIndex: [] }, edges: { headBars: 0, tailBars: 0 } }
            for (let opt of [undefined, { allowGaps: true }, { allowGaps: false }]) {
                let ro = null
                let ws = await capWarn(async () => {
                    ro = await buildOhlc(c, opt)
                })
                assert.deepStrictEqual(ro.gaps, gaps0, JSON.stringify(opt))
                assert.deepStrictEqual(ws, [], JSON.stringify(opt))
            }
        }
        finally {
            ex.skip = null
        }
    })

    it('4hr(缺根): 不核對、不判洞、不提示、不加gaps欄; 明給allowGaps: false亦不拋(4hr工作根不變)', async function() {
        this.timeout(120000)
        let tz = 'Asia/Taipei'
        let ott = makeOtt(tz)
        let dayStart = ott().add(-10, 'day').format('YYYY-MM-DD')
        let oSkip = (Math.floor(Date.now() / H4) - 12) * H4 //約2日前之一根4h(價格與溢價指數皆缺)
        try {
            ex.skip = (type, o) => o === oSkip
            for (let opt of [undefined, { allowGaps: false }, { allowGaps: true }]) {
                let c = normalizeCfg({ root: path.resolve(fdTmp, `h4gap${JSON.stringify(opt)}`.replace(/[^\w]/g, '_')), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: tz, dayStart })
                await fetchBinance(c, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
                let ro = null
                let ws = await capWarn(async () => {
                    ro = await buildOhlc(c, opt)
                })
                assert.deepStrictEqual(ws, [], JSON.stringify(opt))
                assert.ok(!('gaps' in ro), JSON.stringify(opt))
                assert.ok(!('gaps' in JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'ohlc.json'), 'utf8'))), JSON.stringify(opt))
                for (let type of ['price', 'index']) {
                    let arr = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, `TST_${type}_4hr.json`), 'utf8'))
                    assert.ok(arr.length >= 30, `${type} ${arr.length}`)
                    assert.ok(!arr.some((d) => ott(d.time).valueOf() === oSkip), `${type} 缺根照常(不補不拋)`)
                    assert.ok(arr.some((d) => ott(d.time).valueOf() === oSkip - H4) && arr.some((d) => ott(d.time).valueOf() === oSkip + H4), `${type} 前後根在`)
                }
            }
        }
        finally {
            ex.skip = null
        }
    })

    it('4hr(未給aggregateFrom): 直接下載至既有之4hr資料夾, 不寫meta/aggregate.json; buildOhlc照常', async function() {
        this.timeout(120000)
        let tz = 'Asia/Taipei'
        let dayStart = makeOtt(tz)().add(-10, 'day').format('YYYY-MM-DD')
        let c = normalizeCfg({ root: path.resolve(fdTmp, 'h4'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: tz, dayStart })
        assert.strictEqual(rawKeyOf(c), '4hr')
        let r = await fetchBinance(c, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
        assert.strictEqual(r.price.aggregate, undefined)
        assert.deepStrictEqual(fs.readdirSync(path.resolve(c.fds.raw, 'TST', 'price')), ['4hr'])
        assert.ok(!fs.existsSync(path.resolve(c.fds.meta, 'aggregate.json')))
        let ro = await buildOhlc(c)
        assert.ok(ro.nPrice >= 50, `${ro.nPrice}`)
        assert.ok(!('gaps' in ro)) //4hr不判定期間內之洞、不加欄
    })

    it('須合併而timeZone有日光節約、aggregateFrom無效、或非幣安來源給aggregateFrom: 於normalizeCfg即throw(先於任何連網); 下載套件之錯誤原樣上拋(與其getIntervalPlan同一訊息)', function() {
        let b = { root: path.resolve(fdTmp, 'x'), name: 'TST', symbol: 'TSTUSDT' }
        //msgOf, 下載套件之getIntervalPlan對同一輸入之錯誤訊息(不斷言其全文, 只斷言本套件原樣上拋); 不拋時回null
        let msgOf = (interval, opt) => {
            try {
                getIntervalPlan(interval, opt)
                return null
            }
            catch (err) {
                return err.message
            }
        }
        let same = (cfgIn, interval, opt) => {
            let m = msgOf(interval, opt)
            assert.ok(m !== null, `${interval} ${JSON.stringify(opt)}`)
            assert.throws(() => normalizeCfg(cfgIn), (e) => e.message === m)
        }
        same({ ...b, interval: '1day', timeZone: 'America/New_York' }, '1day', { timeZone: 'America/New_York', dayStart: '2020-01-01' })
        same({ ...b, interval: '1day', aggregateFrom: '5hr' }, '1day', { aggregateFrom: '5hr', timeZone: 'Asia/Taipei', dayStart: '2020-01-01' })
        same({ ...b, interval: '1day', aggregateFrom: '1hr', timeZone: 'Asia/Kolkata' }, '1day', { aggregateFrom: '1hr', timeZone: 'Asia/Kolkata', dayStart: '2020-01-01' }) //UTC+5:30之界線不在1hr之格線上
        same({ ...b, interval: 'c2hr', intervalSec: 7200, aggregateFrom: '1hr' }, 'c2hr', { aggregateFrom: '1hr' }) //非下載套件之週期鍵而給aggregateFrom
        assert.throws(() => normalizeCfg({ ...b, interval: '1day', aggregateFrom: '4hr', source: { price: [] } }), (e) => e.message === `invalid cfg.aggregateFrom: must be used with cfg.source 'binance'`)
        //既有六鍵與新週期鍵同一規則(未給aggregateFrom一律不傳, 由下載套件之預設決定): 有日光節約之時區而須合併者於normalizeCfg即拋(訊息同下載套件); 明給'none'者不論時區皆直接下載(資料夾為interval, 有日光節約亦不拋); 外部數據不經下載套件之檢核
        for (let iv of ['1m', '5m', '15m', '30m', '1hr', '4hr']) {
            for (let tz of ['Asia/Taipei', 'UTC']) {
                assert.strictEqual(rawKeyOf(normalizeCfg({ ...b, interval: iv, timeZone: tz })), iv, `${iv} ${tz}`) //台北與UTC: 原生格線已對齊 ⇒ 直接下載(同1.0.22以前)
            }
        }
        same({ ...b, interval: '4hr', timeZone: 'America/New_York' }, '4hr', { timeZone: 'America/New_York', dayStart: '2020-01-01' }) //須合併而有日光節約
        same({ ...b, interval: '1hr', timeZone: 'Australia/Adelaide' }, '1hr', { timeZone: 'Australia/Adelaide', dayStart: '2020-01-01' }) //UTC+9:30/+10:30之1hr須合併而有日光節約
        for (let iv of ['1m', '5m', '15m', '30m', '1hr', '4hr']) {
            for (let tz of ['America/New_York', 'Asia/Tokyo', 'Asia/Kolkata', 'Australia/Adelaide']) {
                let c = normalizeCfg({ ...b, interval: iv, timeZone: tz, aggregateFrom: 'none' })
                assert.strictEqual(c.aggregateFrom, 'none')
                assert.strictEqual(rawKeyOf(c), iv, `${iv} ${tz} none`)
            }
        }
        //時區無效: 幣安來源於normalizeCfg即由下載套件拋錯(先於任何連網), 外部數據不經其檢核
        same({ ...b, interval: '4hr', timeZone: 'Not/AZone' }, '4hr', { timeZone: 'Not/AZone', dayStart: '2020-01-01' })
        assert.strictEqual(normalizeCfg({ ...b, interval: '4hr', timeZone: 'Not/AZone', source: { price: [] } }).intervalSec, 14400)
        assert.strictEqual(rawKeyOf(normalizeCfg({ ...b, interval: '4hr', timeZone: 'Asia/Tokyo', aggregateFrom: 'auto', dayStart: '2021-03-04' })), '4hr_tz+0900_d20210304_from1hr') //明給auto: 同未給
        assert.strictEqual(rawKeyOf(normalizeCfg({ ...b, interval: '4hr', timeZone: 'Asia/Tokyo', dayStart: '2021-03-04' })), '4hr_tz+0900_d20210304_from1hr') //未給: 東京之4hr不對齊 ⇒ 合併(能整除且對齊之最大原生週期為1hr)
        assert.strictEqual(rawKeyOf(normalizeCfg({ ...b, interval: '4hr', timeZone: 'Asia/Kolkata', dayStart: '2021-03-04' })), '4hr_tz+0530_d20210304_from30m')
        assert.strictEqual(normalizeCfg({ ...b, interval: '1day', timeZone: 'America/New_York', source: { price: [] } }).intervalSec, 86400)
        assert.strictEqual(normalizeCfg({ ...b, interval: 'c2hr', intervalSec: 7200 }).intervalSec, 7200) //非下載套件之週期鍵且未給aggregateFrom: 不經其檢核(同既有)
        assert.ok(!('aggregateFrom' in normalizeCfg({ ...b, interval: '1day' })))
        assert.strictEqual(normalizeCfg({ ...b, interval: '1day', aggregateFrom: '4hr' }).aggregateFrom, '4hr')
        assert.strictEqual(rawKeyOf(normalizeCfg({ ...b, interval: '2hr' })), '2hr') //台北之2hr原生對齊: 直接下載
        assert.strictEqual(rawKeyOf(normalizeCfg({ ...b, interval: '1day', timeZone: 'UTC' })), '1day')
        assert.strictEqual(rawKeyOf(normalizeCfg({ ...b, interval: '1day', dayStart: '2021-03-04' })), '1day_tz+0800_d20210304_from8hr') //預設auto: 最大之能整除且對齊者
    })

    //下載套件於同一輸入之判定(其預設為'auto'; 不斷言訊息全文): 'native' | 'aggregate' | 'throw'
    let planModeOf = (interval, opt) => {
        try {
            return getIntervalPlan(interval, opt).mode
        }
        catch (err) {
            return 'throw'
        }
    }

    it('未給aggregateFrom之4hr(台北、UTC): 原生格線已對齊 ⇒ 直接下載原生4h, 資料夾為4hr, K線為假交易所之原樣4h根(同1.0.22以前); 不寫meta/aggregate.json; 不明傳none(請求與資料夾同下載套件之預設)', async function() {
        this.timeout(180000)
        ex.nowCap = Math.floor(Date.now() / H4) * H4 - 1
        try {
            for (let tz of ['Asia/Taipei', 'UTC']) {
                let ott = makeOtt(tz)
                let dayStart = ott().add(-6, 'day').format('YYYY-MM-DD')
                assert.strictEqual(planModeOf('4hr', { timeZone: tz, dayStart }), 'native', tz) //下載套件之預設
                let c = normalizeCfg({ root: path.resolve(fdTmp, 'native', tz.split('/').join('_')), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: tz, dayStart })
                assert.ok(!('aggregateFrom' in c), tz) //未給即不出現, 亦不傳給下載套件
                assert.strictEqual(rawKeyOf(c), '4hr', tz)
                ex.reqs = []
                let r = await fetchBinance(c, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
                assert.ok(ex.reqs.length > 0 && ex.reqs.every((v) => v.interval === '4h'), `${tz} ${JSON.stringify(ex.reqs.slice(0, 3))}`)
                assert.strictEqual(r.price.aggregate, undefined, tz)
                assert.deepStrictEqual(fs.readdirSync(path.resolve(c.fds.raw, 'TST', 'price')), ['4hr'])
                assert.ok(!fs.existsSync(path.resolve(c.fds.meta, 'aggregate.json')))
                await buildOhlc(c)
                for (let type of ['price', 'index']) {
                    let arr = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, `TST_${type}_4hr.json`), 'utf8'))
                    assert.ok(arr.length >= 30, `${tz} ${type} ${arr.length}`)
                    for (let d of arr) {
                        let o = ott(d.time).valueOf()
                        assert.strictEqual(o % H4, 0, `${tz} ${d.time}`) //UTC之4h格線(原生, 未合併)
                        let b = barOf(type, o / H4)
                        assert.deepStrictEqual([d.Open, d.High, d.Low, d.Close], [b.o, b.h, b.l, b.c].map((v) => Number(fmt8(v))), `${tz} ${type} ${d.time}`)
                    }
                }
            }
        }
        finally {
            ex.nowCap = null
        }
    })

    it('未給aggregateFrom之4hr(東京、加爾各答): 原生4h之格線與當地界線不對齊 ⇒ 依下載套件之預設改走合併(1hr、30m合併為當地界線起訖之4hr), 價格與溢價指數同一合併輸出夾 = rawKeyOf, meta/aggregate.json記取得方式; buildOhlc讀合併夾, 各根等於基底各根之合併; 明給aggregateFrom: none者仍直接下載原生4h(資料夾4hr, UTC之4h格線)', async function() {
        this.timeout(300000)
        ex.nowCap = Math.floor(Date.now() / H4) * H4 - 1
        let cases = [
            { tz: 'Asia/Tokyo', baseKey: '1hr', baseStep: '1h', n: 4, offMin: 540, tag: '+0900' },
            { tz: 'Asia/Kolkata', baseKey: '30m', baseStep: '30m', n: 8, offMin: 330, tag: '+0530' },
        ]
        try {
            for (let k of cases) {
                let ott = makeOtt(k.tz)
                let dayStart = ott().add(-6, 'day').format('YYYY-MM-DD')
                assert.strictEqual(planModeOf('4hr', { timeZone: k.tz, dayStart }), 'aggregate', k.tz) //下載套件之預設
                let c = normalizeCfg({ root: path.resolve(fdTmp, 'merge', k.tz.split('/').join('_')), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: k.tz, dayStart })
                assert.ok(!('aggregateFrom' in c), k.tz) //未給即不出現(不明傳none)
                let key = `4hr_tz${k.tag}_d${dayStart.split('-').join('')}_from${k.baseKey}`
                assert.strictEqual(rawKeyOf(c), key, k.tz)
                ex.reqs = []
                let r = await fetchBinance(c, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
                assert.ok(ex.reqs.length > 0 && ex.reqs.every((v) => v.interval === k.baseStep), `${k.tz} ${JSON.stringify(ex.reqs.slice(0, 3))}`)
                assert.strictEqual(r.price.aggregate.key, key)
                assert.strictEqual(r.index.aggregate.key, key)
                assert.strictEqual(r.price.aggregate.count, k.n)
                assert.ok(fs.existsSync(path.resolve(c.fds.raw, 'TST', 'price', key)))
                assert.ok(!fs.existsSync(path.resolve(c.fds.raw, 'TST', 'price', '4hr'))) //不寫入直接下載之資料夾
                let ma = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'aggregate.json'), 'utf8'))
                assert.strictEqual(ma.key, key)
                assert.strictEqual(ma.base, k.baseKey)
                assert.strictEqual(ma.utcOffset, k.offMin)
                let ro = await buildOhlc(c)
                assert.ok(!('gaps' in ro)) //4hr(含合併者)不判定期間內之洞、不加欄(使用者2026-11-19裁定)
                let step = STEPS[k.baseStep]
                let grid = ((-k.offMin * 60000) % H4 + H4) % H4 //當地界線相對UTC之4h格線之偏移
                for (let type of ['price', 'index']) {
                    let arr = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, `TST_${type}_4hr.json`), 'utf8'))
                    assert.ok(arr.length >= 20, `${k.tz} ${type} ${arr.length}`)
                    for (let d of arr) {
                        let o = ott(d.time).valueOf()
                        assert.strictEqual(o % H4, grid, `${k.tz} ${d.time}`) //當地界線之4h格線(合併, 非UTC之4h格線)
                        let bs = []
                        for (let j = 0; j < k.n; j++) {
                            bs.push(barOf(type, (o + j * step) / step))
                        }
                        let mx = (f) => bs.reduce((t, b) => (b[f] > t ? b[f] : t), bs[0][f])
                        let mn = (f) => bs.reduce((t, b) => (b[f] < t ? b[f] : t), bs[0][f])
                        assert.deepStrictEqual([d.Open, d.High, d.Low, d.Close], [bs[0].o, mx('h'), mn('l'), bs[k.n - 1].c].map((v) => Number(fmt8(v))), `${k.tz} ${type} ${d.time}`)
                    }
                }
                //明給none: 直接下載原生4h(逃生門; 資料夾4hr, UTC之4h格線, 各根為假交易所之原樣4h根)
                let cn = normalizeCfg({ root: path.resolve(fdTmp, 'merge', `${k.tz.split('/').join('_')}_none`), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: k.tz, dayStart, aggregateFrom: 'none' })
                assert.strictEqual(rawKeyOf(cn), '4hr', k.tz)
                ex.reqs = []
                let rn = await fetchBinance(cn, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
                assert.ok(ex.reqs.length > 0 && ex.reqs.every((v) => v.interval === '4h'), `${k.tz} none`)
                assert.strictEqual(rn.price.aggregate, undefined)
                assert.deepStrictEqual(fs.readdirSync(path.resolve(cn.fds.raw, 'TST', 'price')), ['4hr'])
                assert.ok(!fs.existsSync(path.resolve(cn.fds.meta, 'aggregate.json')))
                await buildOhlc(cn)
                let arrN = JSON.parse(fs.readFileSync(path.resolve(cn.fds.ohlc, 'TST_price_4hr.json'), 'utf8'))
                assert.ok(arrN.length >= 20 && arrN.every((d) => ott(d.time).valueOf() % H4 === 0), k.tz)
            }
        }
        finally {
            ex.nowCap = null
        }
    })

    it('未給aggregateFrom之4hr(紐約): 須合併而有日光節約 ⇒ normalizeCfg即throw(訊息同下載套件之getIntervalPlan, 先於任何連網); 明給aggregateFrom: none者直接下載原生4h', async function() {
        this.timeout(120000)
        let tz = 'America/New_York'
        let dayStart = makeOtt(tz)().add(-6, 'day').format('YYYY-MM-DD')
        assert.strictEqual(planModeOf('4hr', { timeZone: tz, dayStart }), 'throw') //下載套件之預設
        let m = null
        try {
            getIntervalPlan('4hr', { timeZone: tz, dayStart })
        }
        catch (err) {
            m = err.message
        }
        ex.reqs = []
        assert.throws(() => normalizeCfg({ root: path.resolve(fdTmp, 'ny'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: tz, dayStart }), (e) => e.message === m)
        assert.strictEqual(ex.reqs.length, 0)
        ex.nowCap = Math.floor(Date.now() / H4) * H4 - 1
        try {
            let c = normalizeCfg({ root: path.resolve(fdTmp, 'ny_none'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: tz, dayStart, aggregateFrom: 'none' })
            assert.strictEqual(rawKeyOf(c), '4hr')
            let r = await fetchBinance(c, { endpointPrice: epOf('price'), endpointIndex: epOf('index') })
            assert.strictEqual(r.price.aggregate, undefined)
            assert.deepStrictEqual(fs.readdirSync(path.resolve(c.fds.raw, 'TST', 'price')), ['4hr'])
        }
        finally {
            ex.nowCap = null
        }
    })
})
