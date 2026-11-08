import assert from 'assert'
import path from 'path'
import normalizeCfg, { INTERVALS, CFG_KEYS, intervalSec, serializableCfg } from '../src/cfg.mjs'


//規格來源: src/cfg.mjs normalizeCfg
//  root/name/symbol/interval必填; interval非內建週期須給intervalSec; source預設'binance', 外部須含price
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
        assert.throws(() => normalizeCfg({ ...base(), interval: '2hr' }), /invalid interval\[2hr\]/)
        assert.strictEqual(normalizeCfg({ ...base(), interval: '2hr', intervalSec: 7200 }).intervalSec, 7200)
        assert.strictEqual(intervalSec('1hr'), 3600)
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

    it('不認得之鍵即throw(列出可用鍵); barsPerDay由intervalSec推得', function() {
        assert.throws(() => normalizeCfg({ ...base(), trainPeriod: {} }), /不認得之鍵\[trainPeriod\]/)
        assert.ok(CFG_KEYS.includes('train') && CFG_KEYS.includes('fds'))
        assert.strictEqual(normalizeCfg(base()).barsPerDay, 6)
        assert.strictEqual(normalizeCfg({ ...base(), interval: '1hr' }).barsPerDay, 24)
        assert.strictEqual(normalizeCfg({ ...base(), interval: '1day', intervalSec: 86400 }).barsPerDay, 1)
    })

    it('serializableCfg把外部source函數替換為字串', function() {
        let c = normalizeCfg({ ...base(), source: { price: async () => [] } })
        let s = serializableCfg(c)
        assert.strictEqual(s.source, 'external')
        assert.strictEqual(serializableCfg(normalizeCfg(base())).source, 'binance')
    })

})
