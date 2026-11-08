import assert from 'assert'
import fs from 'fs'
import path from 'path'
import normalizeCfg from '../src/cfg.mjs'
import buildOhlc from '../src/data/buildOhlc.mjs'
import buildParams from '../src/params/buildParams.mjs'
import buildCache from '../src/cache/buildCache.mjs'
import sweepSingle from '../src/sweep/sweepSingle.mjs'
import sweepPairs from '../src/sweep/sweepPairs.mjs'
import { sweepCfgOf } from '../src/sweep/common.mjs'
import readStrategies from 'w-trade-solve/src/readStrategies.mjs'
import { buildFdTmp, cfgOf } from './tools/synthKit.mjs'


//規格來源: src/cache/buildCache.mjs、src/sweep/*.mjs
//  buildCache: 區間預設timeBegin~K線最末, 設定相同且檔存在時不重建(changed false)
//  sweepSingle: 每因子long/short各選best一檔(0~2檔), 檔名為w-trade-solve雜湊格式, 內容含tid/sid/conds/settings/summary
//  sweepPairs: 讀P1配對, eqYr>eqYrMin才輸出, dedupOverlap去重
//  訓練窗紀律: exitCut=訓練期終點+1週期


let fdTmp = buildFdTmp('sweep')
let n = 500
let c = null


describe('cache 與 sweep', function() {

    before(async function() {
        this.timeout(120000)
        let { cfg } = cfgOf(fdTmp, n)
        c = normalizeCfg(cfg)
        await buildOhlc(c)
        await buildParams(c, { only: ['price_ohlc_close', 'price_ohlc_rsi', 'price_ohlc_macd', 'index_ohlc_close'] })
    })

    after(function() {
        fs.rmSync(fdTmp, { recursive: true, force: true })
    })

    it('buildCache建置先觸快取, 第二次不重建, force重建', async function() {
        this.timeout(60000)
        let r = await buildCache(c)
        assert.strictEqual(r.changed, true)
        assert.ok(fs.existsSync(r.fpCache))
        assert.strictEqual(r.meta.nBars, n)
        assert.deepStrictEqual(r.want.tps, [4, 5, 6, 7, 8, 9, 10])
        let r2 = await buildCache(c)
        assert.strictEqual(r2.changed, false)
        let r3 = await buildCache(c, { force: true, tps: [5] })
        assert.strictEqual(r3.changed, true)
        assert.deepStrictEqual(r3.want.tps, [5])
        await buildCache(c, { force: true }) //還原預設
    })

    it('sweepCfgOf: 無train或無快取即throw; exitCut為訓練期終點+1週期', function() {
        let sc = sweepCfgOf(c)
        assert.strictEqual(sc.tr.te, '2023-03-25T04:00:00') //train.te=第500根(索引499)=2023-01-01T00:00:00+499×4hr
        assert.strictEqual(sc.exitCut, '2023-03-25T08:00:00') //+1週期(4hr)
        assert.strictEqual(sc.barsPerDay, 6)
        assert.strictEqual(sc.assm.rollWindowBars, 540)
        assert.throws(() => sweepCfgOf({ ...c, train: null }), /cfg.train/)
        assert.throws(() => sweepCfgOf(c, { fpCache: path.resolve(fdTmp, 'nope.json') }), /buildCache/)
    })

    it('sweepSingle輸出單因子raw策略(每因子每方向至多1檔), 檔案與欄位格式相容於w-trade-solve', async function() {
        this.timeout(120000)
        let prog = []
        let r = await sweepSingle(c, { numTradeFinMin: 3, limit: 12, takeLimit: 2, onProgress: (p) => prog.push(p) })
        assert.strictEqual(r.nFactors, 12)
        assert.ok(r.nOut > 0 && r.nOut <= 24, `nOut ${r.nOut}`)
        assert.ok(prog.length > 0 && prog[prog.length - 1].i === 12)
        let ss = readStrategies(r.fdTar, { readContent: true })
        assert.strictEqual(ss.length, r.nOut)
        let s = ss[0].data
        assert.strictEqual(s.name, 'TST')
        assert.strictEqual(s.interval, '4hr')
        assert.strictEqual(s.keyOhlc, 'TST_price_4hr')
        assert.ok(['long', 'short'].includes(s.mode))
        assert.strictEqual(s.conds.length, 1)
        assert.ok(['>', '<'].includes(s.conds[0].sym))
        assert.strictEqual(s.settings.uIni, 1000)
        assert.strictEqual(s.settings.uTrade, 1)
        assert.strictEqual(s.settings.rTakeProfit, s.settings.rStopLoss)
        assert.ok(typeof s.summary.rEquivalentCumuProfitOrLossFinalNormYear === 'string')
        assert.ok(s.summary.numTradeFin > 3)
        assert.match(ss[0].name, /^(long|short)_\d+_[0-9a-f]{16}\.json$/)
        //同方向同因子只一檔
        let seen = new Set()
        for (let x of ss) {
            let k = `${x.data.mode}|${x.data.conds[0].key}`
            assert.ok(!seen.has(k), `重複 ${k}`)
            seen.add(k)
        }
    })

    it('sweepSingle之filterKeys與cleanFdOut', async function() {
        this.timeout(120000)
        let fdTar = path.resolve(fdTmp, 'p1b')
        let r = await sweepSingle(c, { fdTar, numTradeFinMin: 3, takeLimit: 2, filterKeys: (keys) => keys.filter((k) => k.startsWith('price_ohlc_none_RSI_')) })
        assert.ok(r.nFactors >= 1 && r.nFactors <= 10, `nFactors ${r.nFactors}`) //RSI之週期數(12hr/16hr/20hr/1day/2day/4day/7day)
        let n1 = readStrategies(fdTar).length
        let r2 = await sweepSingle(c, { fdTar, numTradeFinMin: 3, takeLimit: 2, limit: 1, cleanFdOut: false })
        assert.ok(readStrategies(fdTar).length >= n1)
        assert.strictEqual(r2.nFactors, 1)
    })

    it('sweepPairs配對P1策略輸出雙因子raw策略, dedupOverlap去重', async function() {
        this.timeout(120000)
        let r = await sweepPairs(c, { numTradeFinMin: 3, eqYrMin: -1e9, limit: 6, takeLimit: 2 })
        assert.ok(r.nJobs > 0)
        assert.ok(r.nOut > 0, `nOut ${r.nOut}`)
        let ss = readStrategies(r.fdTar, { readContent: true })
        let s = ss[0].data
        assert.strictEqual(s.conds.length, 2)
        assert.ok(['and', 'or'].includes(s.conds[0].opr))
        assert.strictEqual(s.conds[0].opr, s.conds[1].opr)
        assert.ok(ss.every((x) => x.data._entMask === undefined))
        //去重: 門檻極低(0.0)時幾乎全部視同質 → 輸出大幅減少
        let r2 = await sweepPairs(c, { numTradeFinMin: 3, eqYrMin: -1e9, limit: 6, takeLimit: 2, dedupOverlap: 0.0 })
        assert.ok(r2.nDrop > 0, `nDrop ${r2.nDrop}`)
        assert.ok(r2.nOut < r.nOut)
        //eqYrMin極高 → 無輸出
        let r3 = await sweepPairs(c, { numTradeFinMin: 3, eqYrMin: 1e9, limit: 6, takeLimit: 2 })
        assert.strictEqual(r3.nOut, 0)
    })

})
