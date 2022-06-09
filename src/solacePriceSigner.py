# TODO: transcribe to javascript so it doesn't need to run in a separate lambda

from src.utils import *

initialized = False
signerKeyID = ""
signerAddress = ""
verifyingContracts = {}

if not initialized:
    config = json.loads(s3_get('config.json', cache=True))
    verifyingContracts = json.loads(s3_get('solacePrice/verifyingContracts.json', cache=True))
    signerKeyID = config["signerKeyID"]
    signerAddress = config["signerAddress"]
    initialized = True

# signs the price
# writes to s3
def sign(price, price_normalized):
    bundle = { "price": price, "price_normalized": price_normalized, "signer": signerAddress, "signatures": {} }
    deadline = int(datetime.utcnow().timestamp()) + 3600 # one hour from now
    for chainID in verifyingContracts:
        chainNum = int(chainID)
        bundle["signatures"][chainID] = {}
        for addr in verifyingContracts[chainID]:
            params = verifyingContracts[chainID][addr]
            bundle1 = {
                "chainID": int(chainID),
                "token": params["token"],
                "price": price_normalized,
                "deadline": str(deadline)
            }
            # sign the message so the user can submit it
            primitive = {
                "types": {
                    "EIP712Domain": [
                        { "name": "name", "type": "string" },
                        { "name": "version", "type": "string" },
                        { "name": "chainId", "type": "uint256" },
                        { "name": "verifyingContract", "type": "address" }
                    ],
                    params["typeName"]: [
                        { "name": "token", "type": "address" },
                        { "name": "price", "type": "uint256" },
                        { "name": "deadline", "type": "uint256" }
                    ]
                },
                "primaryType": params["typeName"],
                "domain": {
                    "name": params["domainName"],
                    "version": params["version"],
                    "chainId": int(chainID),
                    "verifyingContract": addr
                },
                "message": {
                    "token": params["token"],
                    "price": int(price_normalized),
                    "deadline": deadline
                }
            }
            bundle1["signature"] = price_sign(primitive, signerKeyID)
            bundle["signatures"][chainID][addr] = bundle1
    return bundle

def handle():
    prices = json.loads(s3_get("output/solacePrice.json"))
    signatureBundle = sign(prices['priceFloat'], prices['priceNormalized'])
    s3_put2("solacePrice.json", json.dumps(signatureBundle), bucket='price-feed.solace.fi', contentType='application/json')

# lambda handler
def handler(event, context):
    try:
        handle()
        return {
            "statusCode": 200,
            "headers": headers
        }
    except InputException as e:
        return handle_error(event, e, 400)
    except Exception as e:
        return handle_error(event, e, 500)
