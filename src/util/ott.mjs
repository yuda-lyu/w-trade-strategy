import ot from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'


ot.extend(utc)
ot.extend(timezone)


/**
 * 建立固定時區之時間函數
 *
 * 回傳之ott(input)於input為undefined或null時回傳當下時間，否則將時間字串解析為該時區之dayjs物件；供w-trade-solve與w-trade-backtest之ott參數使用
 *
 * @function
 * @param {String} [timeZone='Asia/Taipei'] 輸入IANA時區名稱字串，預設'Asia/Taipei'
 * @returns {Function} 回傳時間函數ott
 * @example
 *
 * let ott = makeOtt('UTC')
 * console.log(ott('2023-01-01T00:00:00').add(4, 'hour').format('YYYY-MM-DDTHH:mm:ssZ'))
 * // => 2023-01-01T04:00:00+00:00
 *
 */
let makeOtt = (timeZone = 'Asia/Taipei') => {
    let ott = (input) => {
        if (input === undefined || input === null) {
            return ot().tz(timeZone)
        }
        return ot.tz(input, timeZone)
    }
    return ott
}


export { makeOtt }
export default makeOtt
