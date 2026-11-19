import assert from 'assert'
import path from 'path'
import { chkIntervalSec } from 'w-data-trade/src/resolvePeriods.mjs'
import { getIntervals } from 'w-dwdata-binance/src/intervals.mjs'
import normalizeCfg, { INTERVALS, INTERVAL_SEC_DEFAULT, CFG_KEYS, DERIVED_KEYS, intervalSec, serializableCfg, barTimeOf, rawKeyOf } from '../src/cfg.mjs'


//規格來源: src/cfg.mjs normalizeCfg
//  root/name/symbol/interval必填; interval非內建週期須給intervalSec; source預設'binance', 外部須含price
//  intervalSec(每根K線秒數)依w-data-trade(>= 1.0.50)之判準檢核: 60之正整數倍且至多31536000, 數值或數字字串(轉為數值), 給了而無效即throw(跨套件規格 K4、K7、V19、V20)
//  useIndex預設true, 外部數據無index時預設false, 指定true卻無index則throw
//  train可省略(null), 給予時timeStart/timeEnd須為秒時間字串且timeStart早於timeEnd; timeEndByMode可選
//  fds各子夾預設於root下, 可逐一覆寫; keyOhlc=`${name}_price_${interval}`


let base = () => ({ root: './test/_tmp/cfg-root', name: 'ETH', symbol: 'ETHUSDT', interval: '4hr' })


describe('cfg', function() {

    it('必填欄位缺漏時throw', function() {
        assert.throws(() => normalizeCfg({}), /invalid cfg.root/)
        assert.throws(() => normalizeCfg({ root: './x' }), /invalid cfg.name/)
        assert.throws(() => normalizeCfg({ root: './x', name: 'ETH' }), /invalid cfg.symbol/)
        assert.throws(() => normalizeCfg({ root: './x', name: 'ETH', symbol: 'ETHUSDT' }), /invalid cfg.interval/)
    })

    it('interval為內建週期時換算秒數, 非內建須給intervalSec', function() {
        assert.strictEqual(normalizeCfg(base()).intervalSec, INTERVALS['4hr'])
        assert.throws(() => normalizeCfg({ ...base(), interval: 'c2hr' }), /invalid interval\[c2hr\]/)
        assert.strictEqual(normalizeCfg({ ...base(), interval: 'c2hr', intervalSec: 7200 }).intervalSec, 7200)
        assert.strictEqual(intervalSec('1hr'), 3600)
    })

    it('INTERVALS之內建週期(手寫期望值, 鍵名同w-dwdata-binance之週期鍵)之秒數皆通過w-data-trade之chkIntervalSec, 且normalizeCfg回傳該秒數', function() {
        //spec: INTERVALS之鍵與w-dwdata-binance saveData之週期鍵一致, 秒數 = 週期長度; 1day、1week等不給intervalSec即可
        assert.deepStrictEqual(INTERVALS, { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1hr': 3600, '2hr': 7200, '4hr': 14400, '6hr': 21600, '8hr': 28800, '12hr': 43200, '1day': 86400, '1week': 604800 })
        assert.strictEqual(INTERVAL_SEC_DEFAULT, 14400)
        assert.deepStrictEqual(Object.fromEntries(Object.entries(getIntervals()).map(([k, v]) => [k, v.dataSec])), INTERVALS) //與下載套件之週期表(鍵與每根秒數)一致
        for (let [k, v] of Object.entries(INTERVALS)) {
            assert.strictEqual(chkIntervalSec(v), v, k) //w-data-trade之判準(內建週期之值須皆通過)
            assert.strictEqual(intervalSec(k), v, k)
            assert.strictEqual(normalizeCfg({ ...base(), interval: k }).intervalSec, v, k)
            assert.strictEqual(normalizeCfg({ ...base(), interval: k, intervalSec: v }).intervalSec, v, k) //內建週期另給同值
            assert.strictEqual(normalizeCfg({ ...base(), interval: k, intervalSec: String(v) }).intervalSec, v, k) //數字字串同值
            assert.strictEqual(normalizeCfg({ ...base(), interval: `c${k}`, intervalSec: v }).intervalSec, v, k) //非內建名稱時給同值
        }
    })

    it('cfg.intervalSec: 60之正整數倍且至多31536000, 數值或數字字串皆收並轉為數值(K4、K7), 已正規化者可重入', function() {
        //spec: w-data-trade opt.intervalSec 「a positive integer multiple of 60 up to 31536000, a number or numeric string」
        let ok = [[60, 60], [120, 120], [7200, 7200], ['7200', 7200], [86400, 86400], ['86400', 86400], [31536000, 31536000], ['31536000', 31536000]]
        for (let [inp, exp] of ok) {
            let c = normalizeCfg({ ...base(), interval: 'c2hr', intervalSec: inp })
            assert.strictEqual(c.intervalSec, exp, String(inp))
            assert.strictEqual(typeof c.intervalSec, 'number', String(inp)) //檢測之值即使用之值(K4)
        }
        let c1 = normalizeCfg({ ...base(), interval: 'c2hr', intervalSec: '7200' })
        assert.deepStrictEqual(normalizeCfg(c1), c1)
        //null與undefined視為未給: 內建週期取內建秒數, 非內建週期仍須給
        assert.strictEqual(normalizeCfg({ ...base(), intervalSec: null }).intervalSec, 14400)
        assert.strictEqual(normalizeCfg({ ...base(), intervalSec: undefined }).intervalSec, 14400)
        assert.throws(() => normalizeCfg({ ...base(), interval: 'c2hr', intervalSec: null }), /invalid interval\[c2hr\]/)
    })

    it('cfg.intervalSec給了而無效即throw(V19格式、V20不含輸入值), 內建週期與非內建週期皆同', function() {
        //spec: 決定資料口徑之opt給了無效值即拒絕(不退回預設值)
        let msg = 'invalid cfg.intervalSec: must be a positive integer multiple of 60 up to 31536000'
        let probe = 'zz-probe-7q9'
        let bad = [0, -60, 59, 61, 90, 7200.5, 1.5, 31536060, 31536001, '0', '', '  ', 'abc', '7200x', probe, NaN, Infinity, -Infinity, true, false, [], [7200], {}, { v: 7200 }, () => 7200, 7200n]
        for (let v of bad) {
            for (let interval of ['c2hr', '4hr', '1day']) {
                assert.throws(() => normalizeCfg({ ...base(), interval, intervalSec: v }), (e) => e.message === msg, `${interval}:${typeof v}`)
            }
        }
        assert.throws(() => normalizeCfg({ ...base(), interval: 'c2hr', intervalSec: probe }), (e) => !e.message.includes(probe))
    })

    it('週期鍵只認自有鍵: 原型鏈名(constructor、toString等)視為自訂名稱(須給intervalSec, 不交給下載套件之判定)', function() {
        for (let iv of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
            let c = normalizeCfg({ ...base(), interval: iv, intervalSec: 7200 })
            assert.strictEqual(c.intervalSec, 7200, iv)
            assert.strictEqual(rawKeyOf(c), iv, iv)
            assert.throws(() => normalizeCfg({ ...base(), interval: iv }), /非內建週期/, iv)
        }
    })

    it('內建週期另給有效而不同值之intervalSec即throw(訊息固定、不含輸入值); 已正規化之cfg換interval後再傳入亦同', function() {
        //spec(規則帳本TS-11): intervalSec與內建週期之值矛盾即拋錯(檢測先於副作用)
        let msg = 'invalid cfg.intervalSec: must equal the seconds of the built-in cfg.interval'
        assert.throws(() => normalizeCfg({ ...base(), interval: '4hr', intervalSec: 3600 }), (e) => e.message === msg)
        assert.throws(() => normalizeCfg({ ...base(), interval: '1hr', intervalSec: '14400' }), (e) => e.message === msg)
        assert.throws(() => normalizeCfg({ ...base(), interval: '1day', intervalSec: 14400 }), (e) => e.message === msg)
        assert.throws(() => intervalSec('2hr', 3600), (e) => e.message === msg)
        //已正規化之cfg(含intervalSec 14400)換interval為1hr後再傳入: 兩者矛盾即拋(須自原始設定重新正規化)
        let c = normalizeCfg(base())
        assert.throws(() => normalizeCfg({ ...c, interval: '1hr' }), (e) => e.message === msg)
        assert.strictEqual(normalizeCfg({ ...c, interval: '1hr', intervalSec: null }).intervalSec, 3600)
    })

    it('intervalSec(interval, fallback): 非內建週期取fallback(數字字串轉為數值), fallback給了而無效即throw', function() {
        assert.strictEqual(intervalSec('c2hr', 7200), 7200)
        assert.strictEqual(intervalSec('c2hr', '7200'), 7200)
        assert.strictEqual(intervalSec('1day', '86400'), 86400)
        assert.strictEqual(intervalSec('4hr', '14400'), 14400)
        assert.throws(() => intervalSec('c2hr', '7200x'), /^Error: invalid cfg\.intervalSec: must be a positive integer multiple of 60 up to 31536000$/)
        assert.throws(() => intervalSec('1hr', 61), /^Error: invalid cfg\.intervalSec: must be a positive integer multiple of 60 up to 31536000$/)
        assert.throws(() => intervalSec('c2hr'), /invalid interval\[c2hr\]/)
    })

    it('cfg.timeBasis: open/span(依w-trade-backtest之parseBarTime檢核), 有給才出現於回傳; 未給(含null)時回傳之鍵與既有相同; 無效即throw(不含輸入值)', function() {
        //spec(規則帳本TS-20): cfg.timeBasis('open'/'span')與intervalSec一致地轉傳; 未給 ≡ 現行; 不因週期而自動改預設
        let keys0 = ['root', 'name', 'symbol', 'interval', 'intervalSec', 'timeZone', 'source', 'useIndex', 'dayStart', 'timeBegin', 'train', 'fds', 'keyOhlc', 'keyIndex', 'settings']
        for (let tb of [undefined, null]) {
            let c = normalizeCfg({ ...base(), interval: '1day', timeBasis: tb })
            assert.deepStrictEqual(Object.keys(c), keys0)
            assert.strictEqual(barTimeOf(c), null)
        }
        for (let tb of ['open', 'span']) {
            for (let interval of ['4hr', '1day', '8hr']) {
                let c = normalizeCfg({ ...base(), interval, timeBasis: tb })
                assert.strictEqual(c.timeBasis, tb)
                assert.deepStrictEqual(Object.keys(c), ['root', 'name', 'symbol', 'interval', 'intervalSec', 'timeBasis', 'timeZone', 'source', 'useIndex', 'dayStart', 'timeBegin', 'train', 'fds', 'keyOhlc', 'keyIndex', 'settings'])
                assert.deepStrictEqual(barTimeOf(c), { intervalSec: INTERVALS[interval], timeBasis: tb })
                assert.deepStrictEqual(normalizeCfg(c), c) //可重入
                assert.strictEqual(serializableCfg(c).timeBasis, tb)
            }
        }
        assert.ok(CFG_KEYS.includes('timeBasis'))
        let probe = 'zz-probe-7q9'
        for (let v of ['Span', 'close', '', 0, 1, true, {}, ['span'], probe]) {
            assert.throws(() => normalizeCfg({ ...base(), timeBasis: v }), (e) => e.message === `invalid cfg.timeBasis: must be one of 'open', 'span'` && !e.message.includes(probe), String(v))
        }
    })

    it('預設值: source binance、useIndex true、timeZone Asia/Taipei、dayStart 2020-01-01、timeBegin由dayStart推、train null', function() {
        let c = normalizeCfg(base())
        assert.strictEqual(c.source, 'binance')
        assert.strictEqual(c.useIndex, true)
        assert.strictEqual(c.timeZone, 'Asia/Taipei')
        assert.strictEqual(c.dayStart, '2020-01-01')
        assert.strictEqual(c.timeBegin, '2020-01-01T00:00:00')
        assert.strictEqual(c.train, null)
        assert.strictEqual(c.keyOhlc, 'ETH_price_4hr')
        assert.strictEqual(c.keyIndex, 'ETH_index_4hr')
        assert.deepStrictEqual(c.settings, { uIni: 1000, uTrade: 1, rFee: 0.0005 })
    })

    it('fds預設於root下之固定子夾, 可逐一覆寫', function() {
        let c = normalizeCfg({ ...base(), fds: { strategies: './test/_tmp/else/lib' } })
        assert.strictEqual(c.fds.ohlc, path.resolve('./test/_tmp/cfg-root/ohlc'))
        assert.strictEqual(c.fds.param, path.resolve('./test/_tmp/cfg-root/param'))
        assert.strictEqual(c.fds.strategies, path.resolve('./test/_tmp/else/lib'))
    })

    it('外部數據: 無index時useIndex預設false; 指定useIndex true卻無index則throw; 缺price則throw', function() {
        let c = normalizeCfg({ ...base(), source: { price: [] } })
        assert.strictEqual(c.useIndex, false)
        assert.throws(() => normalizeCfg({ ...base(), source: { price: [] }, useIndex: true }), /未提供index/)
        assert.throws(() => normalizeCfg({ ...base(), source: { index: [] } }), /cfg.source.price/)
        assert.throws(() => normalizeCfg({ ...base(), source: 'yahoo' }), /invalid cfg.source/)
        let c2 = normalizeCfg({ ...base(), source: { price: [], index: [] } })
        assert.strictEqual(c2.useIndex, true)
    })

    it('train檢核: 格式、先後、timeEndByMode', function() {
        assert.throws(() => normalizeCfg({ ...base(), train: { timeStart: '2022-07-01', timeEnd: '2025-10-06T00:00:00' } }), /train.timeStart/)
        assert.throws(() => normalizeCfg({ ...base(), train: { timeStart: '2025-10-06T00:00:00', timeEnd: '2022-07-01T00:00:00' } }), /須早於/)
        assert.throws(() => normalizeCfg({ ...base(), train: { timeStart: '2022-07-01T00:00:00', timeEnd: '2025-10-06T00:00:00', timeEndByMode: { long: 'x' } } }), /timeEndByMode.long/)
        let c = normalizeCfg({ ...base(), train: { timeStart: '2022-07-01T00:00:00', timeEnd: '2025-10-06T00:00:00', timeEndByMode: { long: '2025-04-08T00:00:00' } } })
        assert.deepStrictEqual(c.train, { timeStart: '2022-07-01T00:00:00', timeEnd: '2025-10-06T00:00:00', timeEndByMode: { long: '2025-04-08T00:00:00' } })
    })

    it('不認得之鍵即throw(列出可用鍵); 衍生欄barsPerDay已移除(根數為本), 不產出亦不收(無相容路徑)', function() {
        assert.throws(() => normalizeCfg({ ...base(), trainPeriod: {} }), /不認得之鍵\[trainPeriod\]/)
        assert.ok(CFG_KEYS.includes('train') && CFG_KEYS.includes('fds'))
        //衍生欄只有keyOhlc與keyIndex, 週期以intervalSec(秒數)表達
        assert.deepStrictEqual(DERIVED_KEYS, ['keyOhlc', 'keyIndex'])
        for (let c of [normalizeCfg(base()), normalizeCfg({ ...base(), interval: '1hr' }), normalizeCfg({ ...base(), interval: '1day', intervalSec: 86400 })]) {
            assert.ok(!('barsPerDay' in c), Object.keys(c).join(','))
            assert.deepStrictEqual(Object.keys(c), ['root', 'name', 'symbol', 'interval', 'intervalSec', 'timeZone', 'source', 'useIndex', 'dayStart', 'timeBegin', 'train', 'fds', 'keyOhlc', 'keyIndex', 'settings'])
        }
        assert.strictEqual(normalizeCfg({ ...base(), interval: '1day', intervalSec: 86400 }).intervalSec, 86400)
        assert.throws(() => normalizeCfg({ ...base(), barsPerDay: 6 }), /不認得之鍵\[barsPerDay\]/)
    })

    it('既有六鍵與新週期鍵同一規則(主控裁定1): 不留LEGACY_INTERVALS與aggregateFromOf(cfg模組與聚合物件皆無); aggregateFrom未給時不出現於回傳(各週期鍵、各時區), 有給時原樣', async function() {
        let mod = await import('../src/cfg.mjs')
        let { default: agg } = await import('../src/WTradeStrategy.mjs')
        for (let name of ['LEGACY_INTERVALS', 'aggregateFromOf']) {
            assert.ok(!(name in mod), name)
            assert.ok(!(name in agg), name)
        }
        assert.strictEqual(typeof agg.rawKeyOf, 'function')
        for (let interval of Object.keys(INTERVALS)) {
            for (let timeZone of ['Asia/Taipei', 'UTC']) {
                assert.ok(!('aggregateFrom' in normalizeCfg({ ...base(), interval, timeZone })), `${interval} ${timeZone}`)
            }
        }
        assert.strictEqual(normalizeCfg({ ...base(), interval: '4hr', aggregateFrom: 'none', timeZone: 'America/New_York' }).aggregateFrom, 'none')
        assert.strictEqual(normalizeCfg({ ...base(), interval: '4hr', aggregateFrom: null }).aggregateFrom, undefined) //null視為未給
        assert.strictEqual(normalizeCfg({ ...base(), interval: '4hr', aggregateFrom: undefined }).aggregateFrom, undefined)
    })

    it('serializableCfg把外部source函數替換為字串', function() {
        let c = normalizeCfg({ ...base(), source: { price: async () => [] } })
        let s = serializableCfg(c)
        assert.strictEqual(s.source, 'external')
        assert.strictEqual(serializableCfg(normalizeCfg(base())).source, 'binance')
    })

})
