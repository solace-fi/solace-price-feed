def handler(event, context):
    return {
        "statusCode": 301,
        "headers": { "Location": "https://solace.fi/favicon.ico" }
    }
