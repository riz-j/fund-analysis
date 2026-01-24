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
