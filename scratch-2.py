import json
import os
from pathlib import Path

from sec_api import QueryApi


API_KEY_ENV_VAR = "SEC_API_KEY"
OUTPUT_FILE = Path("13f_filings_q1_2014.json")

HOLDINGS_CIK = "1318605"
START_DATE = "2014-01-01"
END_DATE = "2014-03-31"
RESULT_SIZE = 20


def build_query() -> dict:
    return {
        "query": (
            f'formType:"13F" AND holdings.cik:{HOLDINGS_CIK} '
            f"AND filedAt:[{START_DATE} TO {END_DATE}]"
        ),
        "from": "0",
        "size": str(RESULT_SIZE),
        "sort": [{"filedAt": {"order": "desc"}}],
    }


def main() -> None:
    api_key = os.environ.get(API_KEY_ENV_VAR)
    if not api_key:
        raise RuntimeError(f"Set {API_KEY_ENV_VAR} before running this script.")

    query_api = QueryApi(api_key=api_key)
    filings = query_api.get_filings(build_query())

    with OUTPUT_FILE.open("w", encoding="utf-8") as f:
        json.dump(filings, f, indent=2)

    print(json.dumps(filings, indent=2))


if __name__ == "__main__":
    main()
