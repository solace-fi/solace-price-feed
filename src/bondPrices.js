// record the price of bondable tokens
// note that this is a simple reformat and cache of data from the coingecko api
// its good enough for as a view when bonding but should NOT be used for more critical components

const { s3GetObjectPromise, s3PutObjectPromise, snsPublishError, withBackoffRetries, formatTimestamp, delay } = require("./utils/utils")
const axios = require('axios')

const url = "https://api.coingecko.com/api/v3/simple/price?ids=solace%2Cbitcoin%2Cethereum%2Cusd-coin%2Cdai%2Ctether%2Cfrax%2Cnear%2Caurora-near%2Cmatic-network%2Cfantom&vs_currencies=usd"

const nameMap = [
    {"from": "solace", "to": "solace"},
    {"from": "bitcoin", "to": "btc"},
    {"from": "ethereum", "to": "eth"},
    {"from": "usd-coin", "to": "usdc"},
    {"from": "dai", "to": "dai"},
    {"from": "tether", "to": "usdt"},
    {"from": "frax", "to": "frax"},
    {"from": "near", "to": "near"},
    {"from": "aurora-near", "to": "aurora"},
    {"from": "matic-network", "to": "matic"},
    {"from": "fantom", "to": "ftm"},
]

async function trackBondPrices() {
  const res = (await axios.get(url)).data
  const r2 = {}
  nameMap.forEach((mapping) => {
    if(!res.hasOwnProperty(mapping.from)) return
    r2[mapping.to] = res[mapping.from]['usd']
  })
  let r3 = JSON.stringify(r2)
  await s3PutObjectPromise({ Bucket: 'price-feed.solace.fi', Key: 'bondPrices.json', Body: r3, ContentType: "application/json" })
  return r2
}

exports.trackBondPrices = trackBondPrices
