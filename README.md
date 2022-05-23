# solace-price-feed
A feed of token prices.

### development and deployment

Install the AWS SAM CLI  
https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html

To update an existing function, find the handler function in `api/`.

To create a new function or update the infrastructure, add it as infrastructure as code in `template.yaml`

You can locally deploy the API and test against it.
``` bash
sam build --use-container
sam local start-api -p 3001
curl http://localhost:3001/prices1/
```

To deploy to AWS:
``` bash
sam build --use-container
sam deploy
```

### endpoint

``` bash
curl https://price-feed.solace.fi/prices1/
```

``` js
axios.get("https://price-feed.solace.fi/prices1/")
```
