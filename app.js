// const redis = require('redis');
const WebSocket = require('ws');
const axios = require("axios");
const dotenv = require('dotenv');
const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    defaultMeta: { service: 'user-service' },
    transports: [
      //
      // - Write all logs with importance level of `error` or less to `error.log`
      // - Write all logs with importance level of `info` or less to `combined.log`
      //
      new winston.transports.File({ filename: 'error.log', level: 'error' }),
      new winston.transports.File({ filename: 'combined.log' }),
    ],
  });

// .env 파일에서 환경변수 값들을 가져오는 것
dotenv.config({ path: '.env' });

const access_key = process.env.UPBIT_OPEN_API_ACCESS_KEY
const secret_key = process.env.UPBIT_OPEN_API_SECRET_KEY
const server_url = process.env.UPBIT_OPEN_API_SERVER_URL

let orderBook = {}; 
    // Symbol 코인명 (ex: KRW-BTC)
    //  ├ Unix Time, 기록시간 (ex: 1642384141)
    //  ├ Strategy, 사용전략 ("Volatility Breakout")
    //  ├ Amount, 매매금 (51,650,000￦)
    //  ├ Quantity, 거래수량 (0.2 BTC)
    //  └ Total Amount, 총 매매금 (10,330,000￦)



// 현재시간을 Unixtime 형태로 가져오는 함수
const getCurrentUnixTime = (format="second") => {

    let currentTime = new Date().getTime()
    
    if(format == "second")
        currentTime = parseInt(currentTime / 1000);
    
    return currentTime;
};


// Upbit 에 상장된 코인명을 요청하는 함수.
const getSymbol = async() => {

    return (await axios({ 
        method : "get",
        headers: { Accept: 'application/json' },
        url : `https://${server_url}/v1/market/all`,
        params:{ isDetails : true }
    })).data.filter(item => 
        (item.market_warning !== 'CAUTION') && 
        (item.market.substr(0,3) === "KRW"))
}


// Upbit API 에 캔들정보를 요청하는 함수.
// _symbol : 코인명 (예:KRW-BTC)
// _count  : 몇 개를 조회할지 (예:2 일때 오늘+어제 데이터를 받아옴)
const getCandle = async (_symbol, _count) => {

    return (await axios({
        method : "GET",
        headers: { 
            Accept: 'application/json' 
        },
        url : "https://api.upbit.com/v1/candles/days?",    
        params : {
            market : _symbol, // "KRW-BTC"
            count : _count
        }
    })).data;   
}


// item 변수 내에 모든 오브젝트가 true 일 때 true 를 반환하는 함수
const checkCondition = function (item) {
    
    for (const [key, value] of Object.entries(item)) 
        if (value == false) return false
    
    return true;
}

// Larry Williams 변동성 돌파 전략 함수
const strategy = {
    "Volatility Breakout" : {
        desc : "Larry Williams Volatility Breakout",
        BUY : function (data) {
            const { symbol, currentPrice, open, oldHigh, oldLow } = data;
            const conditions = {
                "isBreakOut" : currentPrice > open + 0.5 * (oldHigh - oldLow),
                "isNotBuyed" : !orderBook.hasOwnProperty(symbol)
            }
            if (checkCondition(conditions)){ 
                // buy
                orderBook[symbol] = "buy"
                return true;
            } else{
                // not buy
                return false;
            }
        },
        SELL : function(data) {
            if ( (getCurrentUnixTime() - data.time - 86400) > 0 ) {
                return true;
            } else {
                return false;
            }
        }
    },
    "Others" : {},
}


// 메인 프로세스가 실행된 곳
const main = async() => {
    
    let socket = new WebSocket(`wss://api.upbit.com/websocket/v1`);
    
    let candle = {};

    const symbols = await getSymbol();
    let symbolCount = 0;
    
    //console.log("TICKERS : ", symbols.map(item => item.market))

    for (const item of symbols){
        console.log(`${item.market} (${symbolCount*250}) milliseconds`);
        
        // 0.1초 간격으로 캔들정보를 요청함
        setTimeout(async() => { 
            candle[item.market] = (await getCandle(item.market, 2))[1];
            //console.log(candle[item.market]);
            logger.log({
                level:"info",
                message : `${item.market} candle info added...`
            })
        }, symbolCount * 100)
        symbolCount++;
    }
    
    // 60000 초 마다 프로세스가 살아있는지 확인하는 부분
    setInterval(() => {console.log(`!!! Health Check !!! - ${getCurrentUnixTime()}`)}, 60000) 

    // 웹 소켓 사용 방법 
    // 1. socket.addEventListener('open', (event) => {})
    // 2. socket.onopen(event => {})

    // 웹 소켓 연결이 생성됨
    socket.onopen = (event) => {
        socket.send(JSON.stringify([
            {"ticket" : `UUID-MIGHTY-OTTER`},
            {"type" : "ticker", "codes" : symbols.map(item => item.market)}, // 최대 15개만 가능
            // {"isOnlySnapshot" : false},
            // {"isOnlyRealtime" : false},
        ]));
    }; 


    // 웹 소켓을 통해 서버에서 보내주는 메시지(event 변수)를 받아옴
    socket.onmessage = async (event) => {
        try {
            let { code, trade_price, open_price } = JSON.parse(event.data.toString()); // current price
            let { high_price, low_price } = candle[code] // old price
        
            let params = {
                symbol : code,
                currentPrice : trade_price,
                open : open_price,
                oldHigh : high_price,
                oldLow : low_price
            }
            
            console.log(`실시간 데이터 [${code}] - ${trade_price}`);
            
            let flag = strategy["Volatility Breakout"].BUY(params);
            if (flag) {
                logger.log({
                    level: 'info',
                    message: `[BUY] ${getCurrentUnixTime()} ${code} V.B ${trade_price} x x`
                });
                console.log(`[BUY] ${getCurrentUnixTime()} ${code} V.B ${trade_price} x x`)
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

// Logger, https://github.com/winstonjs/winston
// Array.prototype.slice(), https://developer.mozilla.org/ko/docs/Web/JavaScript/Reference/Global_Objects/Array/slice
// Volatility Breakout 1, https://stock79.tistory.com/entry/실전-투자-전략-52-Noise-ratio를-이용한-변동성-돌파-전략-개선
// Volatility Breakout 2, https://www.whselfinvest.com/en-lu/trading-platform/free-trading-strategies/tradingsystem/56-volatility-break-out-larry-williams-free
// Volatility Breakout 3, https://coinpick.com/quant_program/39857
// Unixtimestamp, https://www.unixtimestamp.com/
// Upbit API, https://docs.upbit.com/docs
// WebSocket, https://developer.mozilla.org/en-US/docs/Web/API/WebSocket