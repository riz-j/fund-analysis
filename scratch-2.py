from sec_api import QueryApi
import json

queryApi = QueryApi(api_key="fb321e42ca49c39216f83c64fe8443ed262d8671bca528fd03bee9eb1a5bfa00")

query = {
    "query": "formType:\"13F\" AND holdings.cik:1318605 AND filedAt:[2014-01-01 TO 2014-03-31]",
    "from": "0",
    "size": "25",
    "sort": [{ "filedAt": { "order": "desc" } }]
}

filings = queryApi.get_filings(query)

with open("13f_filings_q1_2014.json", "w") as f:
    f.write(json.dumps(filings, indent=2))

print(filings)
