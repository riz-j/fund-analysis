# About this project
This project is about analyzing the perfomance of hedge funds by analyzing their 13f filings.

# Main Programming Language
Python3

# Important
- Do NOT use the `agentic_fetch` tool! Always use tavily for web search.
- When searching for performance per quarter, do the search one by one:
  - "SP500 total return performance quarter 1 2025"
  - "SP500 total return performance quarter 2 2025"
  - etc.

# Data
- The data for the positions held by hedge funds are held in the `funds.db` database.

# Database Schema
```sql
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    quarter TEXT NOT NULL,
    fund_name TEXT NOT NULL,
    stock_ticker TEXT NOT NULL,
    shares_owned INTEGER NOT NULL,
    portfolio_percentage REAL,
    quarter_performance REAL,
    reported_price REAL
);
```

# Files
### `filings.json`
- This file contains a dictionary of links to the 13F filing XML documents.

### `fetch_data.py`
- This file is used to populate the database with the filings in `filings.json`.

### `analyze_fund_annual_performance.py`
- This file calculates the quarter-by-quarter performance of the manager-weighted portfolio.
- It displays a table with analyzed weight percentages and portfolio returns per quarter.
- It also shows the aggregate annual return based on the manager-weighted performance.
- Usage: `python3 analyze_fund_annual_performance.py "Fund Name" YEAR`