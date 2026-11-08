import assert from 'assert'
import fs from 'fs'
import path from 'path'
import normalizeCfg from '../src/cfg.mjs'
import buildOhlc, { isBarComplete } from '../src/data/buildOhlc.mjs'
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

})
