// tracks stats over time

const { snsPublishError, s3GetObjectPromise } = require("./utils/utils")
const { trackBondPrices } = require("./bondPrices")
const { trackSolacePrice } = require("./solacePrice")
const { trackNativePrices } = require("./nativePrices")

const AWS = require('aws-sdk')
var lambda = new AWS.Lambda({apiVersion: '2015-03-31'})

// Define headers
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE"
}

// TODO: this calls the signer function which is written in python
// rewrite it in js to avoid multiple functions running
async function sign() {
  return new Promise((resolve,reject) => {
    var params = {
      FunctionName: 'SolacePriceFeedSignerFunction',
      InvocationType: "RequestResponse",
      LogType: "None"
    }
    lambda.invoke(params, function(err, data) {
      if (err) {
        console.log(err, err.stack)
        reject(err)
      } else {
        console.log(data)
        resolve(data)
      }
    })
  })
}

async function track() {
  var res1 = await Promise.all([
    trackBondPrices(),
    trackSolacePrice()
  ])
  var res2 = await Promise.all([
    sign(),
    trackNativePrices(res1)
  ])
  return res1
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
