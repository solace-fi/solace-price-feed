// record the price of tokens in native
// stores the price of native tokens over time then uses a outlier detection and a seven day TWAP to calculate the true price
// some tokens already have a flux price feed - this is for those that dont

const { getProvider, getMulticallProvider, s3GetObjectPromise, s3PutObjectPromise, snsPublishError, withBackoffRetries, formatTimestamp, fetchBlock, multicallChunked } = require("./utils/utils")
const { fetchReservesOrZero, calculateUniswapV2PriceOrZero } = require("./utils/priceUtils")
const ethers = require('ethers')
const BN = ethers.BigNumber
const formatUnits = ethers.utils.formatUnits
const multicall = require('ethers-multicall')

var initialized = false
var uniswapV2PairAbi
var erc20Abi

const PAIR_ADDRESSES = {
    "PLY-WNEAR"    : {"address": "0x044b6B0CD3Bb13D2b9057781Df4459C66781dCe7", "index": 0},
    "BSTN-WNEAR"   : {"address": "0xBBf3D4281F10E537d5b13CA80bE22362310b2bf9", "index": 1},
    "BBT-WNEAR"    : {"address": "0xadAbA7E2bf88Bd10ACb782302A568294566236dC", "index": 2},
    "VWAVE-WNEAR"  : {"address": "0xFd3fDA44cd7F1EA9e9856B56d21F64FC1A417b8E", "index": 3},
    "USDC-WNEAR"   : {"address": "0x20F8AeFB5697B77E0BB835A8518BE70775cdA1b0", "index": 4},
}
const PAIR_NAMES = ["PLY-WNEAR","BSTN-WNEAR","BBT-WNEAR","VWAVE-WNEAR","USDC-WNEAR"]

async function prefetch() {
  if(initialized) return

  var providersJson
  [providersJson, uniV2PairAbi, erc20Abi] = await Promise.all([
    s3GetObjectPromise({Bucket: 'price-feed.solace.fi.data', Key: 'providers.json'}, cache=true).then(JSON.parse),
    s3GetObjectPromise({Bucket: 'price-feed.solace.fi.data', Key: 'abi/other/UniswapV2Pair.json'}, cache=true).then(JSON.parse),
    s3GetObjectPromise({Bucket: 'price-feed.solace.fi.data', Key: 'abi/other/ERC20.json'}, cache=true).then(JSON.parse),
  ])

  initialized = true
}

// fetch the price of native tokens from their trisolaris pools
async function fetchLatestPrices() {
  // fetch
  var provider = await getProvider(1313161554)
  var mcProvider = await getMulticallProvider(1313161554)
  var now = Math.floor((new Date()).valueOf() / 1000)
  var pairs = PAIR_NAMES.map(name => new multicall.Contract(PAIR_ADDRESSES[name].address, uniV2PairAbi))
  var reservesList = await multicallChunked(mcProvider, pairs.map(pair => pair.getReserves()));
  // process
  for(var i = 0; i < reservesList.length; ++i) {
    if(reservesList[i]._reserve0.eq(0) || reservesList[i]._reserve1.eq(0)) {
      throw("zero reserves")
    }
  }
  // calculate near price
  var reservesUsdcNear = reservesList[PAIR_ADDRESSES["USDC-WNEAR"].index]
  var priceNearUsdc = calculateUniswapV2PriceOrZero(reservesUsdcNear._reserve0, reservesUsdcNear._reserve1, true, 6, 24)
  // calculate ply price
  var reservesPlyNear = reservesList[PAIR_ADDRESSES["PLY-WNEAR"].index]
  var pricePlyNear = calculateUniswapV2PriceOrZero(reservesPlyNear._reserve0, reservesPlyNear._reserve1, false, 18, 24)
  var pricePlyUsdc = pricePlyNear * priceNearUsdc
  // calculate bstn price
  var reservesBstnNear = reservesList[PAIR_ADDRESSES["BSTN-WNEAR"].index]
  var priceBstnNear = calculateUniswapV2PriceOrZero(reservesBstnNear._reserve0, reservesBstnNear._reserve1, false, 18, 24)
  var priceBstnUsdc = priceBstnNear * priceNearUsdc
  // calculate bbt price
  var reservesBbtNear = reservesList[PAIR_ADDRESSES["BBT-WNEAR"].index]
  var priceBbtNear = calculateUniswapV2PriceOrZero(reservesBbtNear._reserve0, reservesBbtNear._reserve1, false, 18, 24)
  var priceBbtUsdc = priceBbtNear * priceNearUsdc
  // calculate vwave price
  var reservesVwaveNear = reservesList[PAIR_ADDRESSES["VWAVE-WNEAR"].index]
  var priceVwaveNear = calculateUniswapV2PriceOrZero(reservesVwaveNear._reserve0, reservesVwaveNear._reserve1, false, 18, 24)
  var priceVwaveUsdc = priceVwaveNear * priceNearUsdc

  return {
    "timestamp": now,
    "prices": {
      "PLY-USD": pricePlyUsdc,
      "BSTN-USD": priceBstnUsdc,
      "BBT-USD": priceBbtUsdc,
      "VWAVE-USD": priceVwaveUsdc,
    }
  }
}

// fetches previously recorded prices over time
async function fetchStoredPriceHistory() {
  try {
    return JSON.parse(await s3GetObjectPromise({Bucket:'price-feed.solace.fi.data', Key:'output/nativePricesHistory.json'}, cache=false))
  } catch(e) {
    return []
  }
}

// fetches the price history including previous records and current
async function fetchCompletePriceHistory() {
  var [priceHistory, latestPrices] = await Promise.all([
    fetchStoredPriceHistory(),
    fetchLatestPrices()
  ])
  priceHistory.push(latestPrices)
  priceHistory.sort((a,b) => a.timestamp-b.timestamp)
  return priceHistory
}

// calculates the mean and standard deviation of an array of floats
function meanStd(array) {
  if(array.length == 0) return {mean:0.0, std:0.0}
  const n = array.length
  const mean = array.reduce((a, b) => a + b) / n
  const std = Math.sqrt(array.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b) / n)
  return {mean, std}
}

// given the price over time
// calculates the time weighted average price
function twap(priceHistory) {
  if(priceHistory.length == 0) throw "no price history"
  if(priceHistory.length == 1) return priceHistory[0].price
  // step 1: determine what is an outlier
  // these are NOT weighted by time
  var latestTimestamp = priceHistory[priceHistory.length-1].timestamp
  var cutoffSecondsAgo = 604800 // one week
  var cutoff = latestTimestamp - cutoffSecondsAgo
  var {mean, std} = meanStd(priceHistory.filter(x => x.timestamp >= cutoff).map(x => x.price))
  var low = Math.max(0, mean - 3 * std)
  var high = mean + 3 * std
  // step 2: loop through samples
  var priceTimeAcc = 0.0
  var timeAcc = 0.0
  var i = 0
  for(var j = 1; j < priceHistory.length; ++j) {
    if(priceHistory[j].price < low || priceHistory[j].price > high) continue
    var startTime = Math.max(cutoff, priceHistory[i].timestamp)
    var elapsedTime = Math.max(priceHistory[j].timestamp - startTime, 0.0)
    timeAcc += elapsedTime
    priceTimeAcc += priceHistory[i].price * elapsedTime
    i = j
  }
  return priceTimeAcc / timeAcc
}

// given the price as a float
// returns the string representation with 18 decimals
function normalizePrice(priceFloat) {
  var s = `${priceFloat}`
  if(s.indexOf(".") == -1) s = `${s}.`
  while(s.length - s.indexOf(".") <= 18) s = `${s}0`
  s = s.replace('.','')
  while(s.length > 0 && s[0] == '0') s = s.substring(1)
  if(s.length == 0) s = '0'
  return s
}

// tracks the price of native tokens with outlier detection and seven day twap
// also writes results to s3
async function trackNativePrices(res1) {
  // fetch data and do math
  await prefetch()
  var priceHistory = await fetchCompletePriceHistory()

  var priceSolaceFloat = res1[1].priceFloat
  var pricePlyFloat = twap(priceHistory.map(record => { return {timestamp: record.timestamp, price: record.prices["PLY-USD"]} }))
  var pricePlyNormalized = normalizePrice(pricePlyFloat)
  var priceBstnFloat = twap(priceHistory.map(record => { return {timestamp: record.timestamp, price: record.prices["BSTN-USD"]} }))
  var priceBstnNormalized = normalizePrice(priceBstnFloat)
  var priceBbtFloat = twap(priceHistory.map(record => { return {timestamp: record.timestamp, price: record.prices["BBT-USD"]} }))
  var priceBbtNormalized = normalizePrice(priceBbtFloat)
  var priceVwaveFloat = twap(priceHistory.map(record => { return {timestamp: record.timestamp, price: record.prices["VWAVE-USD"]} }))
  var priceVwaveNormalized = normalizePrice(priceVwaveFloat)
  // write to s3
  await Promise.all([
    s3PutObjectPromise({Bucket:"price-feed.solace.fi.data", Key:"output/nativePricesHistory.json", Body:JSON.stringify(priceHistory), ContentType: "application/json"}),
    //s3PutObjectPromise({Bucket:"price-feed.solace.fi.data", Key:"output/solacePrice.json", Body:JSON.stringify({priceFloat,priceNormalized}), ContentType: "application/json"}),
    s3PutObjectPromise({Bucket:"price-feed.solace.fi", Key:"solace", Body:`${priceSolaceFloat}`, ContentType: "application/json"}),
    s3PutObjectPromise({Bucket:"price-feed.solace.fi", Key:"ply", Body:`${pricePlyFloat}`, ContentType: "application/json"}),
    s3PutObjectPromise({Bucket:"price-feed.solace.fi", Key:"bstn", Body:`${priceBstnFloat}`, ContentType: "application/json"}),
    s3PutObjectPromise({Bucket:"price-feed.solace.fi", Key:"bbt", Body:`${priceBbtFloat}`, ContentType: "application/json"}),
    s3PutObjectPromise({Bucket:"price-feed.solace.fi", Key:"vwave", Body:`${priceVwaveFloat}`, ContentType: "application/json"}),
  ])
  return {priceHistory}
}
exports.trackNativePrices = trackNativePrices
