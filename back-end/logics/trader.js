/**
 * @author mightyotter <skyship36@gmail.com>
 */


/** 환경변수 및 로그관리에 필요한 모듈 */
const dotenv = require('dotenv');
const winston = require('winston');

dotenv.config({ path: '.env' });
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    defaultMeta: { service: 'user-service' },
    transports: [
      //
      // - Write all logs with importance level of `error` or less to `error.log`
      // - Write all logs with importance level of `info` or less to `trade.log`
      //
      new winston.transports.File({ filename: 'error.log', level: 'error' }),
      new winston.transports.File({ filename: 'trade.log' }),
    ],
});


/** DB 모듈 */
const redis = require('redis');   // Redis 사용 이유 : 프로그램의 비정상적 종료를 대비하여 현재 매수정보를 별도로 보관 및 유지하기 위함
const redisClient = redis.createClient({
    socket:{
        host:process.env.REDIS_HOST,
        port:process.env.REDIS_PORT
    }
});
// const mysql = require('mysql');

/** Upbit API 연결을 위한 모듈 */
const axios = require("axios");
const WebSocket = require('ws');

/** Payload 생성에 필요한 모듈 */
const queryEncode = require("querystring").encode
const crypto = require('crypto');
const { v4 : uuidv4 } = require("uuid");
const sign = require("jsonwebtoken").sign;

const access_key = process.env.UPBIT_OPEN_API_ACCESS_KEY
const secret_key = process.env.UPBIT_OPEN_API_SECRET_KEY
const dev_mode = process.env.DEV_MODE


/** 텔레그램 봇 연계를 위한 모듈 */
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.TELEGRAM_BOT_API_TOKEN
const bot = new TelegramBot(token, { polling: true })
/**
 * @TODO 인터넷 끊김시 처리해야 될 예외
 * error: [polling_error] {"code":"EFATAL","message":"EFATAL: Error: read ECONNRESET"}
 * error: [polling_error] {"code":"EFATAL","message":"EFATAL: Error: connect ETIMEDOUT 149.154.167.220:443"}
 * error: [polling_error] {"code":"EFATAL","message":"EFATAL: Error: getaddrinfo ENOTFOUND api.telegram.org"}
*/

/** 현재 매수한 모든 코인 정보 
 * @namespace                               
 * @property    {object}  symbol               - 코인명 (ex: KRW-BTC)
 * @property    {string}  symbol.uuid          - 생성된 거래의 UUID 값
 * @property    {string}  symbol.side          - 주문종류 (매수[bid], 매도[ask])
 * @property    {string}  symbol.ordType       - 주문방식 (지정가[limit], 시장가매수[price], 시장가매도[market])
 * @property    {string}  symbol.volume        - 매도잔량
 * @property    {string}  symbol.timestamp     - 기록시간 (ex: 1642384141)
 * @property    {string}  symbol.usedStrategy  - 사용전략 (ex: "Volatility Breakout")
 * @property    {string}  symbol.amount        - 매매금 (ex: 51650000)
 * @property    {string}  symbol.quantity      - 거래수량 (ex: 0.2)
 * @property    {string}  symbol.totalAmound   - 총 매매금 (ex: 10330000)
 * @property    {string}  symbol.state         - 현재 거래 상태(매수대기[ready], 매도대기[waiting], 매도완료[done])
 */
let orderBook = {};

/** 각 트레이딩 알고리즘이 담겨있는 오브젝트 변수
* @namespace
* @property     {object}  strategyTitle             - 트레이딩 알고리즘명 (ex: "Volatility Breakout")
* @property     {string}  strategyTitle.desc        - 알고리즘 설명
* @property     {object}  strategyTitle.BUY         - 매수 조건 검사
* @property     {object}  strategyTitle.SELL        - 매도 조건 검사
*/
const strategy = {
    "Volatility Breakout" : {
        desc : "Larry Williams Volatility Breakout", 
        /**
         * 변동성 돌파 알고리즘 매수 조건을 검사함
         * @param {object} data     - 매수 조건 검사에 필요한 데이터 {currentPrice, open, oldHigh, oldLow}
         */
        BUY : function (data) {
            const { currentPrice, open, oldHigh, oldLow } = data;
            
            const breakOutRange = (open + 0.5 * (oldHigh - oldLow))

            const conditions = { 
                "isBreakOut" : currentPrice > breakOutRange,
                "other" : true
            }
            
            if (checkCondition(conditions)){ 
                // buy
                console.log(`${currentPrice} > ${breakOutRange} (${currentPrice-breakOutRange}, ${((currentPrice/breakOutRange)-1)*100}) OPEN:${open}, OH:${oldHigh}, OL:${oldLow}`)
                return true;
            } else {
                // not buy
                return false;
            }
        },
        /**
         * 변동성 돌파 알고리즘 매도 조건을 검사함
         * @param {object} data     - 매도 조건 검사에 필요한 데이터 (unix timestamp)
         **/
        SELL : async function(data) {
            const { code, timestamp } = data

            const currentTime = getCurrentUnixTime()
            const oldTime = timestamp
            
            if ( currentTime - oldTime - 300 > 0 ) {
                console.log(`selled `, getCurrentUnixTime(), "    ", timestamp, '@@@@@')

                setTimeout(async () => {
                    await updateRedis(`${code}-TRADE`, 'state', 'ready');
                    // 나중에 팔 때 얼마만큼 체결됐는지 확인하기
                }, 7200000) // 2시간 뒤 재개
                return true;
            } else {
                return false;
            }
        }
    },

    // 볼린저밴드, https://github.com/Jeongseup/DACON-BitcoinTrader2
    "Others" : {},
}

/** 
 * 업비트 API 에서 발행한 키를 통해 JWT 를 생성함
 * @param   {string}    accKey      - 업비트 API 에서 발행한 ACCESS KEY
 * @param   {string}    secKey      - 업비트 API 에서 발행한 SECRET KEY
 * @param   {?object}   queryParam  - ('POST'|'DELETE') 방식의 API 호출 시 body 에 넣을 파라미터
 * @returns {string}                - JWT를 반환
 */
const _createJWT = (accKey, secKey, params) => {

    const payload = {
        access_key: accKey,
        nonce: uuidv4(),
    }

    if (params) {
        const query = queryEncode(params)
        const hash = crypto.createHash('sha512')
        const queryHash = hash.update(query, 'utf-8').digest('hex')

        payload.query_hash = queryHash
        payload.query_hash_alg = 'SHA512'
    }

    const token = sign(payload, secKey)

    return `Bearer ${token}`;
}

/** 
 * 내가 보유한 모든 자산 리스트를 반환함
 * @TODO 예외 처리가 되어있지 않음
 * @param   {!string}   authToken   - JWT(JSON Web Token)
 * @returns {object[]}              - 원화 및 코인별 보유량, 묶여있는 수량, 평단가를 반환함
 */
const getAccountInfo = async (authToken) => {
    
    return (await axios({
        method : "GET",
        url : `https://api.upbit.com/v1/accounts`,
        headers : {
            Authorization : authToken 
        },
    })).data
}

/**
 * 주문조회: 주문 UUID를 통해 개별 주문건을 조회함 (uuid, identifier 중 하나는 필수)
 * @param {string} uuid - 주문 UUID 
 * @param {string} identifier - 조회용 사용자 지정 값
 */
const getOrderHistory = async(uuid, identifier) => {

    const _params = {
        'uuid' : uuid,
        'identifier' : identifier,
    }

    return (await axios({
        method : "GET",
        url : `https://api.upbit.com/v1/order`,
        params : _params,
        headers : { 'Authorization' : `${_createJWT(access_key, secret_key, _params)}` }
    })).data
}

const getFillterdOrderHistory = async (uuid, identifier) => {
    //const response = await getOrderHistory(uuid, identifier)
    const response = {
        "uuid": "64aa0bc9-eae8-4b4d-a5c9-bb3cf1d93f2a",
        "side": "bid",
        "ord_type": "price",
        "price": "7000.0",
        "state": "cancel",
        "market": "KRW-SAND",
        "created_at": "2022-02-01T00:02:55+09:00",
        "volume": null,
        "remaining_volume": null,
        "reserved_fee": "3.5",
        "remaining_fee": "0.000000011725",
        "paid_fee": "3.499999988275",
        "locked": "0.000023461725",
        "executed_volume": "1.43295803",
        "trades_count": 1,
        "trades": [
            {
                "market": "KRW-SAND",
                "uuid": "4273d320-c58f-4a2b-b7ae-370eef234220",
                "price": "4885.0",
                "volume": "1.43295803",
                "funds": "6999.99997655",
                "created_at": "2022-02-01T00:02:55+09:00",
                "side": "bid"
            }
        ]
    }

    const trade = {
        avgPrice : response.trades_count == 1 ? 
            (Number(response.price) / Number(response.executed_volume)).toFixed(1) : 
            (response.trades.reduce((prev, next) => { return Number(prev.price) + Number(next.price) }) / response.trades.length).toFixed(1),
        totalVolume : response.executed_volume
    }
    
    return trade
}
/**
 * @TODO 예외처리, 함수 파라미터, 코드 정리가 필요해보임
 * @param   {!string}   ticker              - '마켓-코인명' 으로 되어있는 값 (예:KRW-BTC)
 * @param   {!string}   side                - 주문종류 : bid (매수), ask (매도)
 * @param   {string}    volume              - 주문량 (지정가, 시장가 매도 시 필수)
 * @param   {string}    price               - 주문 가격 (지정가, 시장가 매수 시 필수)
 * @param   {!string}   [ord_type="limit"]  - 주문 타입 (필수) : limit (지정가), price (시장가 매수), market(시장가 매도)
 * @returns {object}
 */
const sendOrder = async (ticker, side, volume, price, ord_type='limit') => {

    const _params = {
        market: ticker,
        side: side,
        volume: volume,
        price: price,
        ord_type: ord_type,
    }   
    
    return (await axios({
        method : "POST",
        url : `https://api.upbit.com/v1/orders`,
        headers : {
            'Authorization' : `${_createJWT(access_key, secret_key, _params)}`,
            'Content-type' : 'application/json'
        },
        data : JSON.stringify(body)
    })).data
}

/** 
 * 현재시간을 Unixtime 형태로 가져오는 함수
 * @param   {string}    [format='second']   - 입력 시 초단위 결과값 출력(Default millisecond, 12자리)
 * @returns {string}
 */
const getCurrentUnixTime = (format="second") => {

    let currentTime = new Date().getTime()
    
    if(format == "second")
        currentTime = parseInt(currentTime / 1000);

    return currentTime;
};

/** 
 * Upbit 에 상장된 코인 정보를 요청하는 함수
 * @param   {string}    [market="KRW"]          - ('ALL'|'KRW'|'BTC') 입력 시 (전체|원화|비트코인) 매매가 가능한 코인 목록을 반환함
 * @param   {bool}      [includeWarn=false]     - 'true' 입력 시 유의 종목을 포함한 목록을 반환함
 * @returns {object[]} 
 */
const getSymbol = async(market="KRW", includeWarn=false) => {
    
    let result = (await axios({ 
        method : "get",
        headers: { Accept: 'application/json' },
        url : `https://api.upbit.com/v1/market/all`,
        params : { isDetails : true }
    })).data
    
    if (!includeWarn) result = result.filter(item => (item.market_warning !== "CAUTION"))

    if (['ALL','KRW','BTC'].includes(market)){
        
        if (market === 'KRW' || market ==='BTC')
            result = result.filter(item => (item.market.substr(0,3) === market))
        
        return result;
    } else {
        return [];
    }
}

/** 
 * Upbit API 에 캔들정보를 요청하는 함수.
 * @TODO 예외 처리가 되어있지 않음
 * @param   {!string}   symbol     - '시장-코인명' 으로 된 Ticker (예:KRW-BTC)
 * @param   {number}    [count=1]   - 현재 시점으로 부터 조회할 캔들의 갯수 (예:2 일때 오늘+어제 데이터를 받음)
 * @returns {array}
 */
const getCandle = async (symbol, count=1) => {

    const _params = {
        market : symbol,
        count : count
    }

    return (await axios({
        method : "GET",
        headers: { Accept: 'application/json' },
        url : "https://api.upbit.com/v1/candles/days",    
        params : _params
    })).data;   
}

/**
 * Object 내 모든 value 가 true 일 때 true 를 반환
 * @param       {object}    item     - 값이 boolean 인 Object 를 담고있는 Object
 * @returns     {boolean}
 */
const checkCondition = function (item) {
    
    for (const [key, value] of Object.entries(item)) 
        if (value == false) return false
    
    return true;
}

/**
 * 자동매매 실행 전 과거 차트데이터를 미리 받아오는 함수
 * @todo symbols 도 redis 로 변경
 */
let symbols = [];

const init = async () => {
    redisClient.on('error', (err) => {
        console.log('Redis Client Error', err)
    })
    
    await redisClient.connect();
}

const prepareTrade = async () => {
    symbols = await getSymbol();
    let symbolCount = 0;

    try {
        for (const item of symbols){
            let code = item.market

            // 0.1초 간격으로 캔들정보를 요청함, 매일 갱신해야함 필요가 있음
            setTimeout(async() => { 
                //candle[code] = (await getCandle(code, 2))[1];
                await setRedis(`${code}-CANDLE`, (await getCandle(code, 2))[1])
                //orderBook[code] = { state : 'ready' }
                await setRedis(`${code}-TRADE`, { state : 'ready' })
            }, symbolCount * 150)
            symbolCount++;
        }
    } catch (err) {
        console.log('candle error-', err);
    }
    //24시간 = 86400000
    // 1시간 =  3600000
    setTimeout(prepareTrade, 3600000)   // 다음날 다시 함수가 실행되도록 설정
}

/**
 * 
 * @param {string} method - get:조회, set:생성, update:수정
 * @param {*} key 
 * @param {*} value 
 */
const redisController = async (method, key, value) => {
    switch (method) {
        case 'get':
            break
        case 'set':
            break
        case 'update':
            break
    }
}
const isJsonString = function (value) {
    try {
        var json = JSON.parse(str);
        return (typeof json === 'object');
    } catch (e) {
        return false;
    }
}
const updateRedis = async (key, objKey, objValue) => { 
    try {
        const result = JSON.parse(await redisClient.get(`${key}`))
        result[objKey] = objValue
        await redisClient.set(`${key}`, JSON.stringify(result))
        return result;
    } catch {
        return false;
    }
}
const setRedis = async (key, value) => {
    try {
        const result = isJsonString(value) ? value : JSON.stringify(value)
        await redisClient.set(`${key}`, result)    
        return result;
    } catch (err) {
        return false;
    }
}
const getRedis = async (key) => {
    try { 
        return JSON.parse(await redisClient.get(`${key}`))
    } catch (err) {
        return false;
    }
}

/** 메인 프로세스 실행 
 * @todo 70 번 : orderBook 변수를 redis 로 관리하도록 변경
 * @todo 271 번 : candle 전역 변수 관리 어떻게할지?
 * @todo 272 번 : symbol 전역 변수 관리, 상동
 * @todo 프로그램 시작 시 연결됐던 웹소켓 종료
 * @todo 인터넷 연결 끊켰을 시 예외처리(잠시멈춤 등)
 */
const main = async () => {
    
    const workState = {}
    let socket = new WebSocket(`wss://api.upbit.com/websocket/v1`);

    init();
    prepareTrade();
    
    /** 웹 소켓 연결이 생성됨 */
    socket.addEventListener('open', (event) => {
        // 현재 시세 요청 부분
        socket.send(JSON.stringify([
            {"ticket" : `UUID-MIGHTY-OTTER`},
            {"type" : "ticker", "codes" : symbols.map(item => item.market)}, // 최대 15개만 가능
            // {"isOnlySnapshot" : false},
            // {"isOnlyRealtime" : false},
        ]));
    }); 

    /** 웹 소켓을 통해 서버에서 보내주는 메시지(event 변수)를 받아옴 */ 
    socket.addEventListener('message', async (event) => {
        
        try {
            let { code, trade_price, opening_price } = JSON.parse(event.data.toString()); // 현재 코인값

            let tradeData = await getRedis(`${code}-TRADE`)
            let candleData = await getRedis(`${code}-CANDLE`)

            if (candleData === null) {
                throw 'not initialized values'; // 아직 초기화되지 않은 값이면 패스
            }
            //let { high_price, low_price } = candleData
            //let { high_price, low_price } = candle[code] // 과거 코인값

            let params = {
                symbol : code,
                currentPrice : trade_price,
                open : opening_price,
                oldHigh : candleData.high_price,
                oldLow : candleData.low_price
            }
            
            // orderBook 에 매수대기(ready)인 항목만 매수
            if ( tradeData.state === 'ready' ) {
            //if (orderBook[code].state === 'ready') {
                let flag = strategy["Volatility Breakout"].BUY(params);
                let response = {uuid:null,side:null,ord_type:null,volume:null};

                if (flag) {
                    // 시장가 매수
                    if (!dev_mode) {
                        response = await sendOrder(code, 'bid', '', '10000', 'price'); 
                    }
                    
                    const redisValue = {
                        uuid : response.uuid,
                        side : response.side,
                        ordType : response.ord_type,
                        volume : response.volume,
                        timestamp : getCurrentUnixTime(),
                        strategy : "Volatility Breakout",
                        amount : trade_price,
                        quantity : (100000 / trade_price).toFixed(4),
                        totalAmount : 10000,
                        state : 'waiting',
                    } 

                    //orderBook[code] = redisValue
                    await setRedis(`${code}-TRADE`, redisValue)

                    const msg = 
                    `>> BUY : ${code}\n` +
                    `====================================\n` +
                    `# Strategy : Volatility Breakout\n` +
                    `# ${Date(getCurrentUnixTime()).toLocaleString()}\n` +
                    `====================================\n` +
                    `* 매수 단가\n` +
                    `   └> ${trade_price}원\n` +
                    `* 총 체결 금액 \n` +
                    //`   └> ${orderBook[code].quantity}개 ≈ ${100000}원\n`
                    `   └> ${tradeData.quantity}개 ≈ ${100000}원\n`

                    //bot.sendMessage(1690886101, msg);

                    logger.log({
                        level: 'info',
                        message: `[BUY - Volatility Breakout] (${Date(getCurrentUnixTime()).toLocaleString()}) ${code} - ${trade_price}`
                    });

                    console.log(msg)
                }

            // orderBook 에 매도대기(waiting)인 항목만 매도
            //} else if(orderBook[code].state === 'waiting'){
            } else if ( tradeData.state === 'waiting' ) {
                
                let flag = await strategy["Volatility Breakout"].SELL({code:code, timestamp:tradeData.timestamp});
                
                if (flag) {
                    // 시장가 매도
                    if (!dev_mode) {
                        const { executed_volume } = await getOrderHistory(tradeData.uuid)
                        const response = await sendOrder(code, 'ask', executed_volume, '', 'market'); 
                    }
                    
                    updateRedis(`${code}-TRADE`, 'state', 'done');
                    // const result = JSON.parse(await redisClient.get(`${code}-TRADE`))
                    // result.state = 'done'
                    // await redisClient.set(`${code}-TRADE`, JSON.stringify(result))

                    const percent = (((trade_price / tradeData.amount) - 1) * 100).toFixed(4)
                    const msg = 
                        `# SELL : ${code}  ( ${percent}%, ${trade_price - tradeData.amount} )\n` +
                        `====================================\n` +
                        `# Strategy : Volatility Breakout\n` +
                        `# ${Date(getCurrentUnixTime()).toLocaleString()}\n` +
                        `====================================\n` +
                        `* 매도 단가\n` +
                        `   └>  ${trade_price}원 ( ${percent}%, ${trade_price - tradeData.amount} )\n` +
                        `* 총 체결 금액 :\n` +
                        `   └>  ${tradeData.quantity}개 ≈ ${(tradeData.quantity * trade_price).toFixed(4)}원\n` +
                        `* 손익 총계 :\n` +
                        `   └>  ${(trade_price - tradeData.amount).toFixed(4)}원\n`

                    bot.sendMessage(1690886101, msg);

                    logger.log({
                        level: 'info',
                        message: `[SELL - Volatility Breakout][${Date(getCurrentUnixTime()).toLocaleString()}] ${code} - ${trade_price}`
                    });
                    
                    console.log(msg)
                }
            }
            
        } catch (error){
            console.log(`on msg error : ${(JSON.parse(event.data.toString()).code)} ${error}`)
            if (error !== 'not initialized values'){
                logger.log({level: 'error',  message: `error`})
                console.log(`on msg error : ${(JSON.parse(event.data.toString()).code)} ${error}`)
            }
        }
    });
    /* 커스텀 이벤트 수신, 체결정보*/
    socket.addEventListener('error', (event) => { console.log("err") });
    socket.addEventListener('close', (event) => {});
}

main();


// 일 평균 거래대금, 시가총액과 변동성 간의 상관관계 확인

// require 와 import 차이1, https://www.delftstack.com/ko/howto/javascript/javascript-import-vs-require/
// require 와 import 차이2, https://hsp0418.tistory.com/147
// require 형태에서 모듈명 alias 지정하는 방법,  https://stackoverflow.com/questions/48952736/can-i-use-alias-with-nodejs-require-function/48952855
// JWT, https://jwt.io/
// Logger, https://github.com/winstonjs/winston
// Array.prototype.slice(), https://developer.mozilla.org/ko/docs/Web/JavaScript/Reference/Global_Objects/Array/slice
// Volatility Breakout 1, https://stock79.tistory.com/entry/실전-투자-전략-52-Noise-ratio를-이용한-변동성-돌파-전략-개선
// Volatility Breakout 2, https://www.whselfinvest.com/en-lu/trading-platform/free-trading-strategies/tradingsystem/56-volatility-break-out-larry-williams-free
// Volatility Breakout 3, https://coinpick.com/quant_program/39857
// Unixtimestamp, https://www.unixtimestamp.com/
// Upbit API, https://docs.upbit.com/docs
// WebSocket, https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
// Telegram API, https://core.telegram.org/bots/api
// Telegram Module, https://velog.io/@filoscoder/Node로-간단한-telegram-bot-생성하기
// Telegram with AWS Lambda, https://tesilio.github.io/TelegramBot
// Telegram ChatBot, https://berkbach.com/node-js로-telegram-챗봇-개발하기-c7087c63557d
// Telegram deploy, https://velog.io/@dragontiger/파이썬AWS-LambdaAWS-API-Gateway-텔레그램-봇-개발-배포까지