// record the price of SOLACE
// stores the price of SOLACE over time then uses a outlier detection and a seven day TWAP to calculate the true price

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
    "1": {
        "SOLACE-USDC"  : "0x9C051F8A6648a51eF324D30C235da74D060153aC"
    },
    "1313161554": {
        "SOLACE-WNEAR" : "0xdDAdf88b007B95fEb42DDbd110034C9a8e9746F2",
        "USDC-WNEAR"   : "0x20F8AeFB5697B77E0BB835A8518BE70775cdA1b0"
    }
}

const SOLACE_ADDRESS = "0x501acE9c35E60f03A2af4d484f49F9B1EFde9f40"

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

// fetch the solace price and balance from the ethereum sushiswap pair
async function fetchPairStatsEthereum() {
  var mcProvider = await getMulticallProvider(1)
  var solace = new multicall.Contract(SOLACE_ADDRESS, erc20Abi)
  var pair = new multicall.Contract(PAIR_ADDRESSES["1"]["SOLACE-USDC"], uniV2PairAbi)
  var [balance, reserves] = await multicallChunked(mcProvider, [
    solace.balanceOf(pair.address),
    pair.getReserves()
  ])
  balance = parseFloat(formatUnits(balance, 18))
  var price = calculateUniswapV2PriceOrZero(reserves._reserve0, reserves._reserve1, false, 18, 6)
  return {balance, price}
}

// fetch the solace price and balance from the aurora trisolaris pair
async function fetchPairStatsAurora() {
  var mcProvider = await getMulticallProvider(1313161554)
  var solace = new multicall.Contract(SOLACE_ADDRESS, erc20Abi)
  var pairSN = new multicall.Contract(PAIR_ADDRESSES["1313161554"]["SOLACE-WNEAR"], uniV2PairAbi)
  var pairUN = new multicall.Contract(PAIR_ADDRESSES["1313161554"]["USDC-WNEAR"], uniV2PairAbi)
  var [balance, reservesSN, reservesUN] = await multicallChunked(mcProvider, [
    solace.balanceOf(pairSN.address),
    pairSN.getReserves(),
    pairUN.getReserves()
  ])
  balance = parseFloat(formatUnits(balance, 18))
  var priceSN = calculateUniswapV2PriceOrZero(reservesSN._reserve0, reservesSN._reserve1, false, 18, 24)
  var priceUN = calculateUniswapV2PriceOrZero(reservesUN._reserve0, reservesUN._reserve1, true, 6, 24)
  var price = priceSN * priceUN
  return {balance, price}
}

// given a list of pair reserves, calculates the average price weighted by solace balance
function averagePrices(pairStats) {
  var priceBalAcc = 0.0
  var balAcc = 0.0
  for(var i = 0; i < pairStats.length; ++i) {
    priceBalAcc += pairStats[i]["price"] * pairStats[i]["balance"]
    balAcc += pairStats[i]["balance"]
  }
  return priceBalAcc / balAcc
}

// fetch the latest price by averaging across pairs weighted by solace balance
async function fetchLatestPrice() {
  var [pairStatsEthereum, pairStatsAurora] = await Promise.all([
    fetchPairStatsEthereum(),
    fetchPairStatsAurora(),
  ])
  return averagePrices([pairStatsEthereum, pairStatsAurora])
}

// fetches previously recorded prices over time
async function fetchStoredPriceHistory() {
  try {
    return JSON.parse(await s3GetObjectPromise({Bucket:'price-feed.solace.fi.data', Key:'output/solacePriceHistory.json'}, cache=false))
  } catch(e) {
    return []
  }
}

// fetches the price history including previous records and current
async function fetchCompletePriceHistory() {
  var [priceHistory, latestPrice] = await Promise.all([
    fetchStoredPriceHistory(),
    fetchLatestPrice()
  ])
  var now = Math.floor((new Date()).valueOf() / 1000)
  priceHistory.push({price: latestPrice, timestamp: now})
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

// tracks the price of solace with outlier detection and seven day twap
// also writes results to s3
async function trackSolacePrice() {
  // fetch data and do math
  await prefetch()
  var priceHistory = await fetchCompletePriceHistory()
  var priceFloat = twap(priceHistory)
  var priceNormalized = normalizePrice(priceFloat)
  // write to s3
  await Promise.all([
    s3PutObjectPromise({Bucket:"price-feed.solace.fi.data", Key:"output/solacePriceHistory.json", Body:JSON.stringify(priceHistory), ContentType: "application/json"}),
    s3PutObjectPromise({Bucket:"price-feed.solace.fi.data", Key:"output/solacePrice.json", Body:JSON.stringify({priceFloat,priceNormalized}), ContentType: "application/json"}),
  ])
  return {priceHistory, priceFloat, priceNormalized}
}
exports.trackSolacePrice = trackSolacePrice
