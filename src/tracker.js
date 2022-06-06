// tracks stats over time

const { snsPublishError, s3GetObjectPromise } = require("./utils/utils")
const { trackBondPrices } = require("./bondPrices")
const { trackSolacePrice } = require("./solacePrice")

// Define headers
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE"
}

async function track() {
  var res = await Promise.all([
    trackBondPrices(),
    trackSolacePrice()
  ])
  return res
}

// Lambda handler
exports.handler = async function(event) {
  try {
    await track()
    return {
      statusCode: 200,
      headers: headers
    }
  } catch (e) {
    await snsPublishError(event, e)
    return {
      statusCode: 500,
      headers: headers
    }
  }
}
