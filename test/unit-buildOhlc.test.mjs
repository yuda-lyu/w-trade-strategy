import assert from 'assert'
import fs from 'fs'
import path from 'path'
import normalizeCfg from '../src/cfg.mjs'
import buildOhlc, { isBarComplete, checkBarGrid, gapsOf, edgesOf } from '../src/data/buildOhlc.mjs'
import { makeOtt } from '../src/util/ott.mjs'
import { buildFdTmp, cfgOf, genArrPrice, genArrIndex, genTimes } from './tools/synthKit.mjs'


//規格來源: src/data/buildOhlc.mjs
//  外部數據: cfg.source.price/index為陣列或async函數, 須含time(秒時間字串)與Open/High/Low/Close
//  僅保留time>=timeBegin; 預設剔除尚未收棒之最末根; index截齊至price最末時間
//  寫出`${keyOhlc}.json`(與useIndex時之`${keyIndex}.json`), meta/ohlc.json記錄timeFirst/timeLast/nPrice/nIndex, changed為與前次相比是否有變


let fdTmp = buildFdTmp('buildOhlc')


describe('buildOhlc', function() {

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('外部陣列 → 寫出price與index序列json與meta, 第二次呼叫changed為false', async function() {
        let { cfg, arrP, arrI } = cfgOf(fdTmp, 50)
        let c = normalizeCfg(cfg)
        let r = await buildOhlc(c)
        assert.strictEqual(r.nPrice, 50)
        assert.strictEqual(r.nIndex, 50)
        assert.strictEqual(r.timeFirst, arrP[0].time)
        assert.strictEqual(r.timeLast, arrP[49].time)
        assert.strictEqual(r.changed, true)
        let p = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, 'TST_price_4hr.json'), 'utf8'))
        let i = JSON.parse(fs.readFileSync(path.resolve(c.fds.ohlc, 'TST_index_4hr.json'), 'utf8'))
        assert.strictEqual(p.length, 50)
        assert.strictEqual(i.length, 50)
        assert.strictEqual(p[0].Close, arrP[0].Close)
        assert.strictEqual(i[0].Close, arrI[0].Close)
        let meta = JSON.parse(fs.readFileSync(path.resolve(c.fds.meta, 'ohlc.json'), 'utf8'))
        assert.strictEqual(meta.keyIndex, 'TST_index_4hr')
        let r2 = await buildOhlc(c)
        assert.strictEqual(r2.changed, false)
    })

    it('timeBegin過濾; index截齊至price最末; async函數來源', async function() {
        let arrP = genArrPrice(40)
        let arrI = genArrIndex(60) //index較長, 須截齊
        let cfg = {
            root: path.resolve(fdTmp, 'root2'),
            name: 'TST',
            symbol: 'TSTUSDT',
            interval: '4hr',
            timeZone: 'UTC',
            timeBegin: arrP[10].time,
            source: { price: async () => arrP, index: arrI },
        }
        let c = normalizeCfg(cfg)
        let r = await buildOhlc(c)
        assert.strictEqual(r.nPrice, 30)
        assert.strictEqual(r.timeFirst, arrP[10].time)
        assert.strictEqual(r.timeLast, arrP[39].time)
        assert.strictEqual(r.nIndex, 30)
    })

    it('尚未收棒之最末根預設剔除, dropIncompleteLastBar為false時保留', async function() {
        //以當下時間往前推之K線, 最末根開盤於現在之前4小時內 → 未收
        let now = Date.now()
        let base = Math.floor(now / (4 * 3600 * 1000)) * (4 * 3600 * 1000) - 9 * 4 * 3600 * 1000
        let arrP = genArrPrice(10, { base })
        let cfg = {
            root: path.resolve(fdTmp, 'root3'),
            name: 'TST',
            symbol: 'TSTUSDT',
            interval: '4hr',
            timeZone: 'UTC',
            timeBegin: arrP[0].time,
            source: { price: arrP },
        }
        let c = normalizeCfg(cfg)
        let ott = makeOtt('UTC')
        assert.strictEqual(isBarComplete(ott, arrP[9].time, c.intervalSec), false)
        assert.strictEqual(isBarComplete(ott, arrP[8].time, c.intervalSec), true)
        let r = await buildOhlc(c)
        assert.strictEqual(r.nPrice, 9)
        assert.strictEqual(r.keyIndex, null)
        let r2 = await buildOhlc(normalizeCfg({ ...cfg, root: path.resolve(fdTmp, 'root4') }), { dropIncompleteLastBar: false })
        assert.strictEqual(r2.nPrice, 10)
    })

    it('外部數據欄位檢核: 缺Close或time格式錯誤即throw; 幣安來源無下載資料夾即throw', async function() {
        let ts = genTimes(3)
        let bad1 = [{ time: ts[0], Open: 1, High: 1, Low: 1 }]
        await assert.rejects(buildOhlc(normalizeCfg({ root: path.resolve(fdTmp, 'root5'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: 'UTC', source: { price: bad1 } })), /Close/)
        let bad2 = [{ time: '2023-01-01', Open: 1, High: 1, Low: 1, Close: 1 }]
        await assert.rejects(buildOhlc(normalizeCfg({ root: path.resolve(fdTmp, 'root6'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr', timeZone: 'UTC', source: { price: bad2 } })), /time/)
        await assert.rejects(buildOhlc(normalizeCfg({ root: path.resolve(fdTmp, 'root7'), name: 'TST', symbol: 'TSTUSDT', interval: '4hr' })), /fetchData/)
    })

    it('1week: 每根開於週界線, 預設之timeBegin(dayStart之00:00, 預設2020-01-01為週三)不在格線上即拒(README〈數據〉: 須明給落在週界線上之timeBegin); 明給週一者照常', async function() {
        let weeks = Array.from({ length: 12 }, (v, i) => ({ time: new Date(Date.UTC(2020, 0, 6) + i * 7 * 86400 * 1000).toISOString().slice(0, 19), Open: 100 + i, High: 105 + i, Low: 95 + i, Close: 101 + i }))
        let base = { name: 'W', symbol: 'W', interval: '1week', timeZone: 'UTC', source: { price: weeks } }
        let c1 = normalizeCfg({ ...base, root: path.resolve(fdTmp, 'wk1') })
        assert.strictEqual(c1.intervalSec, 604800)
        assert.strictEqual(c1.timeBegin, '2020-01-01T00:00:00') //預設 = dayStart之00:00(週三)
        await assert.rejects(buildOhlc(c1), (e) => e.message === 'invalid cfg.timeBegin: must be on the bar grid of the price series (cfg.intervalSec)')
        assert.ok(!fs.existsSync(c1.fds.ohlc) || fs.readdirSync(c1.fds.ohlc).length === 0)
        let c2 = normalizeCfg({ ...base, root: path.resolve(fdTmp, 'wk2'), timeBegin: '2020-01-06T00:00:00' })
        let r = await buildOhlc(c2)
        assert.strictEqual(r.nPrice, 12)
    })

    it('非4hr之時刻格線核對: 日線之相鄰時差須為每根秒數之整數倍、timeBegin與訓練期各界線須落在價格序列之格線上、溢價指數須與價格同一格線; 不合即throw且不寫任何檔', async function() {
        let DAY = 86400 * 1000
        let mk = (name, ov = {}) => {
            let { cfg, arrP, arrI } = cfgOf(fdTmp, 30, { root: path.resolve(fdTmp, name), interval: '1day', stepMs: DAY, ...ov })
            return { cfg, arrP, arrI }
        }
        //合規: 可有缺根(間距為2日)
        let ok = mk('g-ok')
        let pGap = ok.arrP.filter((v, i) => i !== 5)
        let iGap = ok.arrI.filter((v, i) => i !== 7)
        let warns = []
        let warn0 = console.warn
        console.warn = (...a) => {
            warns.push(a.join(' '))
        }
        let rOk = null
        let rStrict = null
        try {
            rOk = await buildOhlc(normalizeCfg({ ...ok.cfg, source: { price: pGap, index: iGap }, train: { timeStart: ok.arrP[0].time, timeEnd: ok.arrP[29].time, timeEndByMode: { long: ok.arrP[20].time } } }))
            //外部數據不受opt.allowGaps影響(洞為常態): 明給false亦不拋、不提示, 同樣只記數量
            rStrict = await buildOhlc(normalizeCfg({ ...ok.cfg, root: path.resolve(fdTmp, 'g-ok-strict'), source: { price: pGap, index: iGap } }), { allowGaps: false })
        }
        finally {
            console.warn = warn0
        }
        assert.deepStrictEqual(warns, [])
        assert.strictEqual(rOk.nPrice, 29)
        //外部數據(有交易日曆者)之期間內之洞: 不拋, 只記洞數與缺根數(不列各洞); 根集合差亦只記數量
        let gapsWant = { price: { nGaps: 1, nBars: 1 }, index: { nGaps: 1, nBars: 1 }, mismatch: { nOnlyPrice: 1, nOnlyIndex: 1 }, edges: { headBars: 0, tailBars: 0 } }
        assert.deepStrictEqual(rOk.gaps, gapsWant)
        assert.deepStrictEqual(rStrict.gaps, gapsWant)
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.resolve(normalizeCfg(ok.cfg).fds.meta, 'ohlc.json'), 'utf8')).gaps, gapsWant)
        let rNo = await buildOhlc(normalizeCfg({ ...ok.cfg, root: path.resolve(fdTmp, 'g-ok2'), source: { price: ok.arrP } }))
        assert.deepStrictEqual(rNo.gaps, { price: { nGaps: 0, nBars: 0 }, index: null, mismatch: null, edges: null })
        //rejects, 每案皆拒且不寫任何K線檔
        let rejects = async (name, cfgIn, msg) => {
            let c = normalizeCfg({ ...cfgIn, root: path.resolve(fdTmp, name) })
            await assert.rejects(buildOhlc(c), (e) => e.message === msg, name)
            assert.ok(!fs.existsSync(c.fds.ohlc) || fs.readdirSync(c.fds.ohlc).length === 0, name)
        }
        let b = mk('g-base')
        //timeBegin不在格線上(差8小時; 例: 依UTC日界之日線配台北00:00之界線)
        await rejects('g-tb', { ...b.cfg, timeBegin: '2022-12-31T08:00:00' }, 'invalid cfg.timeBegin: must be on the bar grid of the price series (cfg.intervalSec)')
        //訓練期終點與做多終點不在格線上
        await rejects('g-te', { ...b.cfg, train: { timeStart: b.arrP[0].time, timeEnd: '2023-01-20T08:00:00' } }, 'invalid cfg.train.timeEnd: must be on the bar grid of the price series (cfg.intervalSec)')
        await rejects('g-tl', { ...b.cfg, train: { timeStart: b.arrP[0].time, timeEnd: b.arrP[29].time, timeEndByMode: { long: '2023-01-15T12:00:00' } } }, 'invalid cfg.train.timeEndByMode.long: must be on the bar grid of the price series (cfg.intervalSec)')
        //間距非整數倍(混入半日之K線)
        let pBad = [...b.arrP.slice(0, 10), { ...b.arrP[10], time: '2023-01-10T12:00:00' }, ...b.arrP.slice(11)]
        await rejects('g-sp', { ...b.cfg, source: { price: pBad, index: b.arrI } }, 'invalid price series: must have bar times spaced by positive multiples of cfg.intervalSec')
        //溢價指數與價格錯開8小時(格線不同)
        let iShift = b.arrI.map((v) => ({ ...v, time: new Date(Date.parse(`${v.time}Z`) + 8 * 3600 * 1000).toISOString().slice(0, 19) }))
        await rejects('g-ix', { ...b.cfg, source: { price: b.arrP, index: iShift } }, 'invalid index series: must have bar times on the bar grid of the price series (cfg.intervalSec)')
        //重複之時刻(時差0)
        let pDup = [...b.arrP.slice(0, 3), b.arrP[2], ...b.arrP.slice(3)]
        await rejects('g-dup', { ...b.cfg, source: { price: pDup, index: b.arrI } }, 'invalid price series: must have bar times spaced by positive multiples of cfg.intervalSec')
    })

    it('4hr不核對時刻格線(維持既有行為): timeBegin不在格線上、間距不齊者照常寫出', async function() {
        let { cfg, arrP } = cfgOf(fdTmp, 30, { root: path.resolve(fdTmp, 'g-h4') })
        let pBad = [...arrP.slice(0, 10), { ...arrP[10], time: '2023-01-02T17:00:00' }, ...arrP.slice(11)]
        let r = await buildOhlc(normalizeCfg({ ...cfg, timeBegin: '2022-12-31T01:00:00', source: { price: pBad } }))
        assert.strictEqual(r.nPrice, 30)
        //4hr不判定期間內之洞、不加欄(缺根亦照常)
        let r2 = await buildOhlc(normalizeCfg({ ...cfg, root: path.resolve(fdTmp, 'g-h4b'), source: { price: arrP.filter((v, i) => i !== 9) } }))
        assert.strictEqual(r2.nPrice, 29)
        assert.ok(!('gaps' in r2))
        assert.ok(!('gaps' in JSON.parse(fs.readFileSync(path.resolve(normalizeCfg({ ...cfg, root: path.resolve(fdTmp, 'g-h4b') }).fds.meta, 'ohlc.json'), 'utf8'))))
    })

    it('非4hr之溢價指數晚開始或較早結束: gaps.edges記首、尾根數差(共同區間外不屬洞之判定, 不拋); 尾端差逾1根時印一則提示, 1根以內不印; 4hr不加欄', async function() {
        let DAY = 86400 * 1000
        let { cfg, arrP, arrI } = cfgOf(fdTmp, 30, { root: path.resolve(fdTmp, 'e-1'), interval: '1day', stepMs: DAY })
        let warns = []
        let warn0 = console.warn
        console.warn = (...a) => {
            warns.push(a.join(' '))
        }
        try {
            //溢價指數晚3根開始、早5根結束
            let r1 = await buildOhlc(normalizeCfg({ ...cfg, source: { price: arrP, index: arrI.slice(3, 25) } }))
            assert.deepStrictEqual(r1.gaps.edges, { headBars: 3, tailBars: 5 })
            assert.deepStrictEqual(r1.gaps.mismatch, { nOnlyPrice: 0, nOnlyIndex: 0 }) //共同區間內一致
            assert.strictEqual(warns.length, 1)
            assert.ok(warns[0].includes('the index series ends 5 bars before the price series'), warns[0])
            assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.resolve(normalizeCfg(cfg).fds.meta, 'ohlc.json'), 'utf8')).gaps.edges, { headBars: 3, tailBars: 5 })
            //尾端差1根: 不印
            let r2 = await buildOhlc(normalizeCfg({ ...cfg, root: path.resolve(fdTmp, 'e-2'), source: { price: arrP, index: arrI.slice(0, 29) } }))
            assert.deepStrictEqual(r2.gaps.edges, { headBars: 0, tailBars: 1 })
            assert.strictEqual(warns.length, 1)
            //溢價指數早開始(價格晚2根): headBars為負
            let r3 = await buildOhlc(normalizeCfg({ ...cfg, root: path.resolve(fdTmp, 'e-3'), source: { price: arrP.slice(2), index: arrI } }))
            assert.deepStrictEqual(r3.gaps.edges, { headBars: -2, tailBars: 0 })
            //4hr: 不加欄、不印
            let h = cfgOf(fdTmp, 30, { root: path.resolve(fdTmp, 'e-h4') })
            let r4 = await buildOhlc(normalizeCfg({ ...h.cfg, source: { price: h.arrP, index: h.arrI.slice(0, 20) } }))
            assert.ok(!('gaps' in r4))
            assert.strictEqual(warns.length, 1)
        }
        finally {
            console.warn = warn0
        }
        let ott = makeOtt('UTC')
        assert.deepStrictEqual(edgesOf(ott, [{ time: '2023-01-01T00:00:00' }, { time: '2023-01-10T00:00:00' }], [{ time: '2023-01-03T00:00:00' }, { time: '2023-01-06T00:00:00' }], 86400), { headBars: 2, tailBars: 4 })
    })

    it('gapsOf(單元): 相鄰時差大於每根秒數者為洞, 記洞內第1根缺漏之開盤時刻與缺根數; 尾端不列', function() {
        let ott = makeOtt('Asia/Taipei')
        let arr = ['2023-01-01T00:00:00', '2023-01-02T00:00:00', '2023-01-05T00:00:00', '2023-01-06T00:00:00', '2023-01-08T00:00:00'].map((time) => ({ time }))
        assert.deepStrictEqual(gapsOf(ott, arr, 86400), [{ time: '2023-01-03T00:00:00', bars: 2 }, { time: '2023-01-07T00:00:00', bars: 1 }])
        assert.deepStrictEqual(gapsOf(ott, arr.slice(0, 2), 86400), [])
        assert.deepStrictEqual(gapsOf(ott, [], 86400), [])
        assert.deepStrictEqual(gapsOf(ott, [{ time: '2023-01-01T00:00:00' }, { time: '2023-01-01T03:00:00' }], 3600), [{ time: '2023-01-01T01:00:00', bars: 2 }])
    })

    it('checkBarGrid(單元): 回傳格線起點; 給t0時另核各根落在該格線上', function() {
        let ott = makeOtt('UTC')
        let cfg = { intervalSec: 86400, timeBegin: '2023-01-01T00:00:00', train: null }
        let arr = [{ time: '2023-01-01T00:00:00' }, { time: '2023-01-02T00:00:00' }, { time: '2023-01-04T00:00:00' }]
        assert.strictEqual(checkBarGrid(ott, arr, cfg, 'price'), Date.UTC(2023, 0, 1))
        assert.strictEqual(checkBarGrid(ott, arr, cfg, 'index', Date.UTC(2022, 0, 1)), Date.UTC(2022, 0, 1))
        assert.throws(() => checkBarGrid(ott, [{ time: '2023-01-01T08:00:00' }], cfg, 'index', Date.UTC(2023, 0, 1)), /index series: must have bar times on the bar grid/)
        assert.strictEqual(checkBarGrid(ott, [], { ...cfg }, 'price'), null)
    })

})
