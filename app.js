/**
 * @author mightyotter <skyship36@gmail.com>
 */

/** DB 모듈 */
// const redis = require('redis');
// const mysql = require('mysql');

/** Upbit API 연결을 위한 모듈 */
const axios = require("axios");
const WebSocket = require('ws');

/** Payload 생성에 필요한 모듈 */
const queryEncode = require("querystring").encode
const crypto = require('crypto');
const { v4 : uuidv4 } = require("uuid");
const sign = require("jsonwebtoken").sign;

/** 환경변수 및 로그관리에 필요한 모듈 */
const dotenv = require('dotenv');
const winston = require('winston');

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

dotenv.config({ path: '.env' });

const access_key = process.env.UPBIT_OPEN_API_ACCESS_KEY
const secret_key = process.env.UPBIT_OPEN_API_SECRET_KEY
const server_url = process.env.UPBIT_OPEN_API_SERVER_URL
const dev_mode = process.env.DEV_MODE

/** 텔레그램 봇 연계를 위한 모듈 */
const TelegramBot = require('node-telegram-bot-api');
const token = process.env.TELEGRAM_BOT_API_TOKEN
const bot = new TelegramBot(token, { polling: true })


/** 현재 매수한 모든 코인 정보 
 * @namespace                               
 * @property    {object}  symbol               - 코인명 (ex: KRW-BTC)
 * @property    {string}  symbol.timestamp     - 기록시간 (ex: 1642384141)
 * @property    {string}  symbol.usedStrategy  - 사용전략 (ex: "Volatility Breakout")
 * @property    {string}  symbol.amount        - 매매금 (ex: 51650000)
 * @property    {string}  symbol.quantity      - 거래수량 (ex: 0.2)
 * @property    {string}  symbol.totalAmound   - 총 매매금 (ex: 10330000)
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
            const conditions = { 
                "isBreakOut" : currentPrice > open + 0.5 * (oldHigh - oldLow) 
            }
            var percent = (open + 0.5 * (oldHigh - oldLow)) / currentPrice
            
            if (checkCondition(conditions)){ 
                // buy
                console.log(`${parseInt(percent*100)}/100 `, open, oldHigh, oldLow, currentPrice)
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
        SELL : function(data) {
            if ( (getCurrentUnixTime() - data - 86400) > 0 ) {
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
 * @param   {?object}   bodyParam   - ('POST'|'DELETE') 방식의 API 호출 시 body 에 넣을 파라미터
 * @returns {string}                - JWT를 반환
 */
const createJWT = (accKey, secKey, bodyParam) => {

    const payload = {
        access_key: accKey,
        nonce: uuidv4(),
    }

    if (bodyParam) {
        const query = queryEncode(bodyParam)
        const hash = crypto.createHash('sha512')
        const queryHash = hash.update(query, 'utf-8').digest('hex')

        console.log(query)
        console.log(hash)
        console.log(queryHash)

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
        url : `https://${server_url}/v1/accounts`,
        headers : {
            Authorization : authToken 
        },
    })).data
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
const makeOrder = async (ticker, side, volume, price, ord_type='limit') => {

    const bodyParam = {
        market: ticker,
        side: side,
        volume: volume,
        price: price,
        ord_type: ord_type,
    }   
    
    return (await axios({
        method : "POST",
        url : `https://${server_url}/v1/orders`,
        headers : {
            'Authorization' : `${createJWT(access_key, secret_key, bodyParam)}`,
            'Content-type' : 'application/json'
        },
        data : JSON.stringify(body)
    }).catch(err=>console.log(err.response.data.error)))
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
        url : `https://${server_url}/v1/market/all`,
        params:{ isDetails : true }
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

    return (await axios({
        method : "GET",
        headers: { Accept: 'application/json' },
        url : "https://api.upbit.com/v1/candles/days?",    
        params : {
            market : symbol,
            count : count
        }
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
 */
let candle = {};
let symbols = [];

const prepareTrade = async () => {
    symbols = await getSymbol();
    let symbolCount = 0;

    logger.log({
        level: 'info',
        message: `[DAY_OVER] (${getCurrentUnixTime()}) get new candles...`
    });

    for (const item of symbols){
        console.log(`${item.market} candle info loaded...`);
        
        // 0.1초 간격으로 캔들정보를 요청함, 매일 갱신해야함 필요가 있음
        setTimeout(async() => { 
            candle[item.market] = (await getCandle(item.market, 2))[1];
            //console.log(candle[item.market]);
        }, symbolCount * 100)
        symbolCount++;
    }
}

/** 메인 프로세스 실행 
 * @todo 271 번 : candle 전역 변수 관리 어떻게할지, redis 로 관리해야하나?
 * @todo 272 번 : symbol 전역 변수 관리, 상동
 * @todo 프로그램 시작 시 연결됐던 웹소켓 종료
 * @todo 인터넷 연결 끊켰을 시 예외처리(잠시멈춤 등)
 */
const main = async() => {
      
    let socket = new WebSocket(`wss://api.upbit.com/websocket/v1`);
    
    setInterval(() => { bot.sendMessage(1873399506, "안녕하세요!") }, 5000)

    prepareTrade();
    setInterval(prepareTrade, 86400000)
    
    /** 웹 소켓 이벤트 선언 방법 
     * 1. socket.addEventListener('open', (event) => {})
     * 2. socket.onopen(event => {})
     */

    /** 웹 소켓 연결이 생성됨 */
    socket.onopen = (event) => {
        // 현재 시세 요청 부분
        socket.send(JSON.stringify([
            {"ticket" : `UUID-MIGHTY-OTTER`},
            {"type" : "ticker", "codes" : symbols.map(item => item.market)}, // 최대 15개만 가능
            // {"isOnlySnapshot" : false},
            // {"isOnlyRealtime" : false},
        ]));

        /** 체결 정보 요청 부분 구현필요
        socket.send(JSON.stringify([
            {"ticket" : `UUID-MIGHTY-OTTER2`},
            {"type" : "trade", "codes" : symbols.map(item => item.market)},{"format":"SIMPLE"}
            // {"isOnlySnapshot" : false},
            // {"isOnlyRealtime" : false},
        ]));
        */
    }; 

    /** 웹 소켓을 통해 서버에서 보내주는 메시지(event 변수)를 받아옴 */ 
    socket.onmessage = async (event) => {
        try {
            let { code, trade_price, opening_price } = JSON.parse(event.data.toString()); // 현재 코인값
            let { high_price, low_price } = candle[code] // 과거 코인값
        
            let params = {
                symbol : code,
                currentPrice : trade_price,
                open : opening_price,
                oldHigh : high_price,
                oldLow : low_price
            }
            
            console.log(`[RECV][${getCurrentUnixTime()}] ${code} - ${trade_price}`);
            
            // orderBook 에 등록되지 않은 코인일 경우 매수
            if (!orderBook.hasOwnProperty(code)) {
                let flag = strategy["Volatility Breakout"].BUY(params);

                if (flag) {
                    logger.log({
                        level: 'info',
                        message: `[BUY - Volatility Breakout] (${getCurrentUnixTime()}) ${code} - ${trade_price}`
                    });

                    // 시장가 매수
                    if (!dev_mode){
                        const response = await makeOrder(code, "bid", "", '5000', 'price'); 
                    
                        orderBook[code] = {
                            timestamp : getCurrentUnixTime(),
                            strategy : "Volatility Breakout",
                            amount : trade_price,
                            quantity : trade_price / 5000,
                            totalAmount : 5000
                        }    
                    }
                    

                    console.log(`[BUY - Volatility Breakout][${getCurrentUnixTime()}] ${code} - ${trade_price}`)

                    bot.sendMessage(1873399506, `[BUY - Volatility Breakout][${getCurrentUnixTime()}] ${code} - ${trade_price}`);
                }
            // orderBook 에 등록된 경우 매도조건 확인
            } else {
                let flag = strategy["Volatility Breakout"].SELL(orderBook[code].timestamp);

                if (flag) {
                    logger.log({
                        level: 'info',
                        message: `[SELL - Volatility Breakout][${getCurrentUnixTime()}] ${code} - ${trade_price}`
                    });

                    // 시장가 매도
                    if (!dev_mode) {
                        const response = await makeOrder(code, "bid", 0.1,'', 'price'); 
                        
                    }
                    
                    console.log(`[SELL - Volatility Breakout][${getCurrentUnixTime()}] ${code} - ${trade_price}`)
                    bot.sendMessage(1690886101, `[SELL - Volatility Breakout][${getCurrentUnixTime()}] ${code} - ${trade_price}`);
                }
            }
            
        } catch (error){
            console.log(`on msg error : ${(JSON.parse(event.data.toString()).code)} ${error}`)
        }
    };
    socket.onerror = (event) => { console.log("err") };
    socket.onclose = (event) => {};
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