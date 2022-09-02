// Load the AWS SDK for Node.js
const AWS = require('aws-sdk')
// Set region
AWS.config.update({region: 'us-west-2'})
// Create S3 service
const S3 = new AWS.S3({apiVersion: '2006-03-01'})
exports.AWS = AWS
exports.S3 = S3

const ethers = require('ethers')
const BN = ethers.BigNumber
const multicall = require('ethers-multicall')

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

var s3_cache = {}

// retrieves an object from S3 with optional caching
// returns a promise representing the request
async function s3GetObjectPromise(params, cache=false) {
  return new Promise((resolve,reject) => {
    try {
      if(cache &&
        Object.keys(s3_cache).includes(params["Bucket"]) &&
        Object.keys(s3_cache[params["Bucket"]]).includes(params["Key"])
      ) resolve(s3_cache[params["Bucket"]][params["Key"]])
      S3.getObject(params, (err,data) => {
        if(err) {
          err.stack = `Could not S3 get ${JSON.stringify(params)}\n${err.stack}`
          reject(err)
        } else {
          var res = data['Body'].toString()
          if(!Object.keys(s3_cache).includes(params["Bucket"])) s3_cache[params["Bucket"]] = {}
          s3_cache[params["Bucket"]][params["Key"]] = res
          resolve(res)
        }
      })
    } catch(err) {
      err.stack = `Could not S3 get ${JSON.stringify(params)}\n${err.stack}`
      reject(err)
    }
  })
}
exports.s3GetObjectPromise = s3GetObjectPromise

// puts an object into S3
// returns a promise representing the request
async function s3PutObjectPromise(params) {
  return new Promise((resolve,reject) => {
    try {
      S3.putObject(params, (err,data) => {
        if(err) {
          var params2 = { Bucket: params.Bucket, Key: params.Key }
          err.stack = `Could not S3 put ${JSON.stringify(params2)}\n${err.stack}`
          reject(err)
        } else resolve(data)
      })
    } catch(e) {
      var params2 = { Bucket: params.Bucket, Key: params.Key }
      err.stack = `Could not S3 put ${JSON.stringify(params2)}\n${err.stack}`
      reject(err)
    }
  })
}
exports.s3PutObjectPromise = s3PutObjectPromise

// publishes a message to SNS
// returns a promise representing the request
async function snsPublishMessage(msg) {
  var params = {
    Message: msg,
    TopicArn: "arn:aws:sns:us-west-2:151427405638:PriceFeedDeadLetterQueue"
  }
  return new AWS.SNS({apiVersion: '2010-03-31'}).publish(params).promise()
}
exports.snsPublishMessage = snsPublishMessage

// formats an error message then publishes it to SNS
// returns a promise representing the request
async function snsPublishError(event, err) {
  var eventString = " <unknown>"
  try {
    eventString = `\n${event["headers"]["X-Forwarded-Proto"]}://${event["headers"]["Host"]}${event["path"]} params=${JSON.stringify(event["queryStringParameters"])}`
  } catch(e) {}
  var errMsg = err.stack || err.toString()
  var msg = `The following error occurred in the solace-price-feed api${eventString} :\n${errMsg}`
  return snsPublishMessage(msg)
}
exports.snsPublishError = snsPublishError

// gets an ethers provider for a given chainID
async function getProvider(chainID) {
  let providers = JSON.parse(await s3GetObjectPromise({
    Bucket: 'price-feed.solace.fi.data',
    Key: 'providers.json'
  }, cache=true))
  if(!Object(providers).hasOwnProperty(chainID)) {
    throw { name: 'UnknownError', stack: `Could not create an ethers provider for chainID '${chainID}'`}
    return
  }
  let provider = providers[chainID]
  if(provider.type == "Alchemy") {
    return new ethers.providers.AlchemyProvider(chainID, provider.key)
  }
  if(provider.type == "JsonRpc") {
    return new ethers.providers.JsonRpcProvider(provider.url)
  }
  throw { name: 'UnknownError', stack: `Could not create an ethers provider for chainID '${chainID}'`}
}
exports.getProvider = getProvider

// gets a multicall provider for a given chainID
async function getMulticallProvider(chainID) {
  var chainNum = chainID - 0
  const prov = await getProvider(chainNum)
  var mcProvider = new multicall.Provider(prov)
  await mcProvider.init()
  if(chainNum == 1313161554) mcProvider._multicallAddress = "0xdc1522872E440cF9cD48E237EAFEfaa5F157Ca1d"
  if(chainNum == 1313161555) mcProvider._multicallAddress = "0x8f81207F59A4f86d68608fF90b259A0927242967"
  if(chainNum == 4002)       mcProvider._multicallAddress = "0x8f81207F59A4f86d68608fF90b259A0927242967"
  return mcProvider
}
exports.getMulticallProvider = getMulticallProvider

// returns a promise that resolves after a specified wait time
async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
exports.delay = delay

// returns the result of a given function call
// gracefully handles request timeouts and retries
const MIN_RETRY_DELAY = 10000
const RETRY_BACKOFF_FACTOR = 2
const MAX_RETRY_DELAY = 100000
async function withBackoffRetries(f, retryCount = 7, jitter = 10000) {
  return new Promise(async (resolve, reject) => {
    //await delay(Math.floor(Math.random() * jitter))
    let nextWaitTime = MIN_RETRY_DELAY
    let i = 0
    while (true) {
      try {
        var res = await f()
        resolve(res)
        break
      } catch (error) {
        i++
        if(!error.toString().toLowerCase().includes("timeout")) {
          reject(error)
          break
        }
        if (i >= retryCount) {
          console.log('timeout. over max retries')
          reject(error)
          break
        }
        console.log('timeout. retrying')
        await delay(nextWaitTime + Math.floor(Math.random() * jitter))
        nextWaitTime = Math.min(MAX_RETRY_DELAY, RETRY_BACKOFF_FACTOR * nextWaitTime)
      }
    }
  })
}
exports.withBackoffRetries = withBackoffRetries

// formats a unix timestamp (in seconds) to UTC string representation
// mm:dd:yyyy hh:mm:ss
function formatTimestamp(timestamp) {
  let d = new Date(timestamp * 1000)
  return `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${leftZeroPad(d.getUTCHours(),2)}:${leftZeroPad(d.getUTCMinutes(),2)}:${leftZeroPad(d.getUTCSeconds(),2)}`
}
exports.formatTimestamp = formatTimestamp

function leftZeroPad(s, l) {
  let s2 = `${s}`
  while(s2.length < l) s2 = '0' + s2
  return s2
}
exports.leftZeroPad = leftZeroPad

// fetch a block
async function fetchBlock(provider, blockTag) {
  return new Promise((resolve, reject) => {
    withBackoffRetries(() => provider.getBlock(blockTag)).then(resolve)
  })
}
exports.fetchBlock = fetchBlock

// returns an array of integers starting at start, incrementing, and stopping before stop
function range(start, stop) {
  let arr = [];
  for(var i = start; i < stop; ++i) {
    arr.push(i);
  }
  return arr;
}
exports.range = range

// sorts BigNumbers ascending
function sortBNs(a, b) {
  if(a.lt(b)) return -1;
  if(a.gt(b)) return 1;
  return 0;
}
exports.sortBNs = sortBNs


// todo: attach to array prototype
function filterYN(f, arr) {
  var y = []
  var n = []
  for(var ele of arr) {
    if(f(ele)) y.push(ele)
    else n.push(ele)
  }
  return [y, n]
}
exports.filterYN = filterYN

// returns true if code is deployed at the given address and block
// returns false if the address is invalid or no code was deployed yet
async function isDeployed(provider, address, blockTag="latest") {
  try {
    // safety checks
    if(address === undefined || address === null) return false;
    if(address.length !== 42) return false;
    if(address == ZERO_ADDRESS) return false;
    if((await provider.getCode(address, blockTag)).length <= 2) return false;
    return true;
  } catch (e) {
    if(e.toString().includes('account aurora does not exist while viewing')) return false; // handle aurora idiosyncracies
    else throw e;
  }
}
exports.isDeployed = isDeployed

// use a binary search to determine the block in which a contract was deployed to the given address.
// returns -1 if the contract has not been deployed yet
async function findDeployBlock(provider, address) {
  let L = 0;
  let R = await provider.getBlockNumber();
  if(!(await isDeployed(provider, address, R))) return -1;
  while(L < R-1) {
    let M = Math.floor((L+R)/2);
    if(await isDeployed(provider, address, M)) R = M;
    else L = M;
  }
  let b1 = await isDeployed(provider, address, R-1);
  let b2 = await isDeployed(provider, address, R);
  if(b1 || !b2) throw 'Error in findDeployBlock(): did not converge properly';
  return R;
}
exports.findDeployBlock = findDeployBlock

// fetch events that occurred in a contract with the given event name between startBlock and endBlock
async function fetchEvents(contract, eventName, startBlock, endBlock) {
  if(endBlock == 'latest') endBlock = await contract.provider.getBlockNumber()
  return _fetchEvents(contract, eventName, startBlock, endBlock, 0)
}
exports.fetchEvents = fetchEvents;

// helper for fetchEvents()
async function _fetchEvents(contract, eventName, startBlock, endBlock, depth) {
  return new Promise(async (resolve,reject) => {
    try {
      var events = await contract.queryFilter(eventName, startBlock, endBlock)
      resolve(events)
      return
    } catch(e) {
      /*
      var s = e.toString();
      if(!s.includes("10K") && !s.includes("1000 results") && !s.includes("statement timeout") && !s.includes("missing response")) {
        reject(e)
        return
      }
      */
      // log response size exceeded. recurse down
      var midBlock = Math.floor((startBlock+endBlock)/2)
      var [left, right] = [ [], [] ]
      if(depth < 8) {
        [left, right] = await Promise.all([ // parallel
          _fetchEvents(contract, eventName, startBlock, midBlock, depth+1),
          _fetchEvents(contract, eventName, midBlock+1, endBlock, depth+1),
        ])
      } else { // serial
        left = await _fetchEvents(contract, eventName, startBlock, midBlock, depth+1)
        right = await _fetchEvents(contract, eventName, midBlock+1, endBlock, depth+1)
      }
      var res = left.concat(right)
      resolve(res)
    }
  })
}

// formats a BigNumber into a string representation of a float
// like ethers.utils.formatUnits() except keeps trailing zeros
function formatUnitsFull(amount, decimals=18) {
  var s = amount.toString()
  while(s.length <= decimals) s = `0${s}`
  var i = s.length - decimals
  var s2 = `${s.substring(0,i)}.${s.substring(i,s.length)}`
  return s2
}
exports.formatUnitsFull = formatUnitsFull

async function multicallChunked(mcProvider, calls, blockTag="latest", chunkSize=25) {
  if(blockTag == 'latest') blockTag = await mcProvider._provider.getBlockNumber()
  // break into chunks
  var chunks = []
  for(var i = 0; i < calls.length; i += chunkSize) {
    var chunk = []
    for(var j = 0; j < chunkSize && i+j < calls.length; ++j) {
      chunk.push(calls[i+j])
    }
    chunks.push(chunk)
  }
  // parallel call each chunk
  var res1 = await Promise.all(chunks.map(chunk => withBackoffRetries(() => mcProvider.all(chunk, {blockTag:blockTag,gasLimit:30000000}))))
  // reassemble
  var res2 = []
  for(var i = 0; i < res1.length; ++i) {
    for(var j = 0; j < res1[i].length; ++j) {
      res2.push(res1[i][j])
    }
  }
  return res2
}
exports.multicallChunked = multicallChunked
