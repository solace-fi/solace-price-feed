# globally used stuff goes here

import json
from typing import List
import boto3
import os
import sys
from datetime import datetime
from calendar import monthcalendar
import requests
import time

import web3
Web3 = web3.Web3
from web3.auto import w3 as w3auto
from eth_account.messages import encode_structured_data
from eth_account import Account
import asn1tools

DATA_BUCKET = os.environ.get("DATA_BUCKET", "price-feed.solace.fi.data")
DEAD_LETTER_TOPIC = os.environ.get("DEAD_LETTER_TOPIC", "arn:aws:sns:us-west-2:151427405638:PriceFeedDeadLetterQueue")

s3_client = boto3.client("s3", region_name="us-west-2")
s3_resource = boto3.resource("s3", region_name="us-west-2")
sns_client = boto3.client("sns", region_name="us-west-2")
s3_cache = {}

# retrieves an object from S3, optionally reading from cache
def s3_get(key, cache=False):
    if cache and key in s3_cache:
        return s3_cache[key]
    else:
        res = s3_client.get_object(Bucket=DATA_BUCKET, Key=key)["Body"].read().decode("utf-8").strip()
        s3_cache[key] = res
        return res

def s3_put(key, body):
    # TODO: figure out why we're getting this notification
    # An error occurred (SlowDown) when calling the PutObject operation (reached max retries: 4): Please reduce your request rate.
    # adding retries is just a patch on what is likely an optimization issue
    err = ""
    for i in range(5):
        try:
            s3_client.put_object(Bucket=DATA_BUCKET, Body=body, Key=key)
            return
        except Exception as e:
            err = e
            time.sleep(1)
    if err != "":
        raise err

def s3_put2(key, body, bucket=DATA_BUCKET, contentType=''):
    # TODO: figure out why we're getting this notification
    # An error occurred (SlowDown) when calling the PutObject operation (reached max retries: 4): Please reduce your request rate.
    # adding retries is just a patch on what is likely an optimization issue
    err = ""
    for i in range(5):
        try:
            s3_client.put_object(Bucket=bucket, Body=body, Key=key, ContentType=contentType)
            return
        except Exception as e:
            err = e
            time.sleep(1)
    if err != "":
        raise err

def s3_move(key: str, new_key: str):
    copy_source = {'Bucket': DATA_BUCKET, 'Key': key}
    s3_client.copy_object(Bucket=DATA_BUCKET, CopySource=copy_source, Key=new_key)
    s3_client.delete_object(Bucket=DATA_BUCKET, Key=key)


def s3_get_files(folder):
    files = []
    res = s3_client.list_objects_v2(Bucket=DATA_BUCKET, Prefix=folder)
    contents = res.get("Contents")
    if contents:
        for content in contents:
            files.append(content['Key'])
    return files

def sns_publish(message):
    sns_client.publish(
        TopicArn=DEAD_LETTER_TOPIC,
        Message=message
    )

def read_json_file(filename):
    with open(filename) as f:
        return json.loads(f.read())

def get_file_name(file):
    return os.path.splitext(os.path.basename(file))[0]

def to_32byte_hex(val):
    return Web3.toHex(Web3.toBytes(val).rjust(32, b'\0'))

def stringify_error(e):
    traceback = e.__traceback__
    s = str(e)
    while traceback:
        s = "{}\n{}: {}".format(s, traceback.tb_frame.f_code.co_filename, traceback.tb_lineno)
        traceback = traceback.tb_next
    return s

def get_week_of_month(year, month, day):
    return next(
        (
            week_number
            for week_number, days_of_week in enumerate(monthcalendar(year, month), start=1)
            if day in days_of_week
        ),
        None,
    )

def get_date_string():
  return datetime.now().strftime("%Y-%m-%d")

def get_timestamp():
    return datetime.now().strftime("%Y/%m/%d, %H:%M:%S")

def handle_error(event, e, statusCode):
    print(e)
    resource = event["resource"] if "resource" in event else ".unknown()"
    queryStringParameters = event["queryStringParameters"] if "queryStringParameters" in event else ""
    sns_message = "The following {} error occurred in solace-price-feed{}:\n{}\n{}".format(statusCode, resource, queryStringParameters, stringify_error(e))
    sns_publish(sns_message)
    http_message = str(e)
    return {
        "statusCode": statusCode,
        "body": http_message,
        "headers": headers
    }

headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE"
}

#alchemy_config = json.loads(s3_get("alchemy_config.json", cache=True))

class InputException(Exception):
    pass

ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
ADDRESS_SIZE = 40 # 20 bytes or 40 hex chars
ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"
SOLACE_ADDRESS = "0x501acE9c35E60f03A2af4d484f49F9B1EFde9f40"
#erc20Json = json.loads(s3_get("abi/other/ERC20.json", cache=True))
ONE_ETHER = 1000000000000000000

# signing code largely borrowed from
# https://aws.amazon.com/blogs/database/part1-use-aws-kms-to-securely-manage-ethereum-accounts/

# max value on curve / https://github.com/ethereum/EIPs/blob/master/EIPS/eip-2.md
SECP256_K1_N = int("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)

class EthKmsParams:
    def __init__(self, kms_key_id: str, eth_network: str):
        self._kms_key_id = kms_key_id
        self._eth_network = eth_network
    def get_ksm_key_id(self) -> str:
        return self._kms_key_id

def get_params() -> EthKmsParams:
    for param in ['KMS_KEY_ID', 'ETH_NETWORK']:
        value = os.getenv(param)
        if not value:
            if param in ['ETH_NETWORK']:
                continue
            else:
                raise ValueError('missing value for parameter: {}'.format(param))
    return EthKmsParams(
        kms_key_id=os.getenv('KMS_KEY_ID'),
        eth_network=os.getenv('ETH_NETWORK')
    )

def get_kms_public_key(key_id: str) -> bytes:
    client = boto3.client('kms')
    response = client.get_public_key(
        KeyId=key_id
    )
    return response['PublicKey']

def sign_kms(key_id: str, msg_hash: bytes) -> dict:
    client = boto3.client('kms')
    response = client.sign(
        KeyId=key_id,
        Message=msg_hash,
        MessageType='DIGEST',
        SigningAlgorithm='ECDSA_SHA_256'
    )
    return response

def calc_eth_address(pub_key) -> str:
    SUBJECT_ASN = '''
    Key DEFINITIONS ::= BEGIN

    SubjectPublicKeyInfo  ::=  SEQUENCE  {
       algorithm         AlgorithmIdentifier,
       subjectPublicKey  BIT STRING
     }

    AlgorithmIdentifier  ::=  SEQUENCE  {
        algorithm   OBJECT IDENTIFIER,
        parameters  ANY DEFINED BY algorithm OPTIONAL
      }

    END
    '''
    key = asn1tools.compile_string(SUBJECT_ASN)
    key_decoded = key.decode('SubjectPublicKeyInfo', pub_key)
    pub_key_raw = key_decoded['subjectPublicKey'][0]
    pub_key = pub_key_raw[1:len(pub_key_raw)]
    # https://www.oreilly.com/library/view/mastering-ethereum/9781491971932/ch04.html
    hex_address = w3auto.keccak(bytes(pub_key)).hex()
    eth_address = '0x{}'.format(hex_address[-40:])
    eth_checksum_addr = w3auto.toChecksumAddress(eth_address)
    return eth_checksum_addr

def find_eth_signature(kms_key_id: str, plaintext: bytes) -> dict:
    SIGNATURE_ASN = '''
    Signature DEFINITIONS ::= BEGIN

    Ecdsa-Sig-Value  ::=  SEQUENCE  {
           r     INTEGER,
           s     INTEGER  }

    END
    '''
    signature_schema = asn1tools.compile_string(SIGNATURE_ASN)
    signature = sign_kms(kms_key_id, plaintext)
    # https://tools.ietf.org/html/rfc3279#section-2.2.3
    signature_decoded = signature_schema.decode('Ecdsa-Sig-Value', signature['Signature'])
    s = signature_decoded['s']
    r = signature_decoded['r']
    secp256_k1_n_half = SECP256_K1_N / 2
    if s > secp256_k1_n_half:
        s = SECP256_K1_N - s
    return {'r': r, 's': s}

def get_recovery_id(msg_hash, r, s, eth_checksum_addr) -> dict:
    for v in [27, 28]:
        recovered_addr = Account.recoverHash(message_hash=msg_hash,
                                             vrs=(v, r, s))
        if recovered_addr == eth_checksum_addr:
            return {'recovered_addr': recovered_addr, 'v': v}
    return {}

# dont need
def assemble_tx(tx_params: dict, params: EthKmsParams, eth_checksum_addr: str) -> bytes:
    tx_unsigned = serializable_unsigned_transaction_from_dict(transaction_dict=tx_params)
    tx_hash = tx_unsigned.hash()
    tx_sig = find_eth_signature(params=params,
                                plaintext=tx_hash)
    tx_eth_recovered_pub_addr = get_recovery_id(msg_hash=tx_hash,
                                                r=tx_sig['r'],
                                                s=tx_sig['s'],
                                                eth_checksum_addr=eth_checksum_addr)
    tx_encoded = encode_transaction(unsigned_transaction=tx_unsigned,
                                    vrs=(tx_eth_recovered_pub_addr['v'], tx_sig['r'], tx_sig['s']))
    return w3auto.toHex(tx_encoded)

def price_sign(primitive, kms_key_id):
    # encode the message
    message = encode_structured_data(primitive=primitive)
    # hash the message
    # TODO: this gets the hash of the message by signing it first (with the old paclas signer with the plaintext key)
    # not a security issue, just an inefficiency
    signed_message = w3auto.eth.account.sign_message(message, private_key=s3_get("rinkeby_signer_key.txt", cache=True))
    message_hash = signed_message.messageHash
    # download public key from KMS
    pub_key = get_kms_public_key(kms_key_id)
    # calculate the Ethereum public address from public key
    eth_checksum_addr = calc_eth_address(pub_key)
    # actually sign with KMS
    message_sig = find_eth_signature(kms_key_id=kms_key_id, plaintext=message_hash)
    # calculate v
    message_eth_recovered_pub_addr = get_recovery_id(msg_hash=message_hash,r=message_sig['r'],s=message_sig['s'],eth_checksum_addr=eth_checksum_addr)
    # assemble signature
    signature = '{}{}{}'.format(hex(message_sig['r']), hex(message_sig['s'])[2:], hex(message_eth_recovered_pub_addr['v'])[2:])
    return signature
