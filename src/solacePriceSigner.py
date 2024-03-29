# TODO: transcribe to javascript so it doesn't need to run in a separate lambda

from datetime import timezone
from src.utils import *

initialized = False
signerKeyID = ""
signerAddress = ""
providers = {}
solaceSignerAbi = []

if not initialized:
    config = json.loads(s3_get('config.json', cache=False))
    signerKeyID = config["signerKeyID"]
    signerAddress = config["signerAddress"]
    providers = config["providers"]
    solaceSignerAbi = json.loads(s3_get('abi/solace/utils/SolaceSigner.json', cache=True))
    initialized = True

# signs the price
# writes to s3
def sign(price, price_normalized):
    bundle = { "price": price, "price_normalized": price_normalized, "signer": signerAddress, "signatures": {} }
    dt = datetime.now(timezone.utc)
    time = dt.replace(tzinfo=timezone.utc)
    deadline = int(time.timestamp()) + 3600
  
    # loop over chains
    verifyingContracts = json.loads(s3_get('solacePrice/verifyingContracts.json', cache=False))
    for chainID in verifyingContracts:
        chainNum = int(chainID)
        bundle["signatures"][chainID] = {}
        w3 = Web3(Web3.HTTPProvider(providers[chainID]['url']))
        # loop over contracts
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
            # sign and verify it works
            isValid = False
            contract = w3.eth.contract(address=addr, abi=solaceSignerAbi)
            while not isValid:
                try:
                    signature = price_sign(primitive, signerKeyID)
                    # verify signature
                    isValid = contract.functions.verifyPrice(params["token"], int(price_normalized), deadline, signature).call()
                    bundle1["signature"] = signature
                    print("Is valid: ", isValid)
                except Exception as e:
                    print(f"Error: ", e)
                    continue
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

if __name__ == '__main__':
    handle()
