import json
import sqlite3
import requests
import xml.etree.ElementTree as ET
import yfinance as yf
from datetime import datetime, timedelta
import time
import sys

# Constants
DB_FILE = 'funds.db'
SCHEMA_FILE = 'schema.sql'
FILINGS_FILE = 'filings.json'
USER_AGENT_SEC = "FundAnalysisTool/1.0 (contact@example.com)"
FMP_API_KEY = "OG4bS3dBtIRH7XiH7n2Pu5QODviIT5rP"

# Caching
cusip_cache = {}

def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    with open(SCHEMA_FILE, 'r') as f:
        cursor.executescript(f.read())
    conn.commit()
    return conn

def get_ticker_from_name(name):
    if not name or name == "Unknown":
        return None
        
    url = f"https://financialmodelingprep.com/stable/search-name?query={name}&apikey={FMP_API_KEY}"
    
    for attempt in range(5):
        try:
            time.sleep(0.25)
            response = requests.get(url)
            
            if response.status_code == 429:
                wait = 2 ** attempt
                print(f"429 Too Many Requests. Retrying in {wait}s...")
                time.sleep(wait)
                continue
                
            if response.status_code == 200:
                data = response.json()
                if not data:
                    return None
                    
                # Filter for US exchanges and USD
                valid_exchanges = {'NYSE', 'NASDAQ', 'AMEX'}
                candidates = []
                
                for item in data:
                    if item.get('currency') == 'USD' and item.get('exchange') in valid_exchanges:
                        candidates.append(item)
                
                if not candidates:
                    return None
                
                # Scoring function
                def score_candidate(item):
                    s_name = name.upper()
                    i_name = item['name'].upper()
                    
                    score = 0
                    if i_name == s_name:
                        score = 100
                    elif i_name.startswith(s_name):
                        score = 50
                    elif s_name in i_name:
                        score = 10
                    
                    # Tie-breaker: Shortest symbol preferred (User specifies "only one is the real one")
                    # We invert length so we can reverse sort
                    # But Python sort is stable. simpler is to return tuple.
                    return (score, -len(item['symbol']))

                # Sort by score (desc) then symbol length (asc -> negative len desc)
                candidates.sort(key=score_candidate, reverse=True)
                
                ticker = candidates[0]['symbol']
                
                # Clean ticker
                ticker = ticker.replace('.', '-')
                return ticker
                
        except Exception as e:
            print(f"Error fetching ticker for name {name}: {e}")
            time.sleep(1)
            
    return None

def get_ticker_from_cusip(cusip, name=None):
    if cusip in cusip_cache:
        return cusip_cache[cusip]
    
    url = f"https://financialmodelingprep.com/stable/search-cusip?cusip={cusip}&apikey={FMP_API_KEY}"
    
    # Rate limit handling (max 300/min -> 1 call every 0.2s)
    # We use 0.25s to be safe
    for attempt in range(5):
        try:
            time.sleep(0.25)
            response = requests.get(url)
            
            if response.status_code == 429:
                wait = 2 ** attempt
                print(f"429 Too Many Requests for {cusip}. Retrying in {wait}s...")
                time.sleep(wait)
                continue
                
            if response.status_code == 200:
                data = response.json()
                if data and len(data) > 0:
                    ticker = data[0]['symbol']
                    # Clean ticker (replace '.' with '-' for yfinance if needed, though yf handles dots often? usually BRK.B -> BRK-B)
                    ticker = ticker.replace('.', '-')
                    cusip_cache[cusip] = ticker
                    return ticker
                    
                # Fallback to name search if CUSIP failed
                if name:
                    print(f"Propagating to name search for {name} (CUSIP {cusip} failed)")
                    ticker = get_ticker_from_name(name)
                    if ticker:
                         cusip_cache[cusip] = ticker # Cache it against the CUSIP too
                         return ticker
                         
                return None
        except Exception as e:
            print(f"Error fetching ticker for CUSIP {cusip}: {e}")
            time.sleep(1)
    
    return None

def get_quarter_dates(year, quarter):
    y = int(year)
    if quarter == 'q1':
        return f"{y}-01-01", f"{y}-03-31"
    elif quarter == 'q2':
        return f"{y}-04-01", f"{y}-06-30"
    elif quarter == 'q3':
        return f"{y}-07-01", f"{y}-09-30"
    elif quarter == 'q4':
        return f"{y}-10-01", f"{y}-12-31"
    return None, None

def get_performance(ticker, start_date, end_date):
    try:
        # Add a few days buffer to start/end to ensure we capture trading days
        # yfinance end date is exclusive, so add 1 day to end_date
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
        query_end = (end_dt + timedelta(days=5)).strftime("%Y-%m-%d") 
        
        # We need data covering the start to end.
        data = yf.download(ticker, start=start_date, end=query_end, progress=False)
        
        if data.empty:
            return None
            
        # Filter to strictly within the quarter
        mask = (data.index >= start_date) & (data.index <= end_date)
        quarter_data = data.loc[mask]
        
        if quarter_data.empty:
            return None
            
        # Get first available Open/Close and last available Close
        start_price = quarter_data.iloc[0]['Open']
        if hasattr(start_price, 'item'): start_price = start_price.item() # Handle Series/scalar
            
        end_price = quarter_data.iloc[-1]['Close']
        if hasattr(end_price, 'item'): end_price = end_price.item()
        
        if start_price == 0: return 0.0
        
        perf = ((end_price - start_price) / start_price) * 100
        return round(perf, 2)
        
    except Exception as e:
        print(f"Error calculating performance for {ticker}: {e}")
        return None

def process_filing(conn, fund_name, year, quarter, url):
    # Check if data already exists
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM positions WHERE fund_name = ? AND year = ? AND quarter = ? LIMIT 1", (fund_name, int(year), quarter))
    if cursor.fetchone():
        print(f"Skipping {fund_name} {year} {quarter} - already exists")
        return

    print(f"\033[32mProcessing {fund_name} {year} {quarter}...\033[0m")
    
    # Fetch XML
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT_SEC})
        if r.status_code != 200:
            print(f"Failed to fetch {url}: {r.status_code}")
            return
        xml_content = r.content
    except Exception as e:
        print(f"Error requesting {url}: {e}")
        return

    # Parse XML
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as e:
        print(f"XML Parse Error: {e}")
        return

    # Parse XML
    try:
        root = ET.fromstring(xml_content)
    except ET.ParseError as e:
        print(f"XML Parse Error: {e}")
        return

    positions = []
    total_value = 0.0

    # Parse rows by iterating root children and checking tag name ignoring namespace
    for info in root:
        # Check if tag is infoTable (ignoring namespace)
        tag_local = info.tag.split('}')[-1] if '}' in info.tag else info.tag
        if 'infoTable' not in tag_local and 'InfoTable' not in tag_local:
            continue

        try:
            name_of_issuer = "Unknown"
            cusip = None
            val = 0.0
            shares = 0
            
            # Iterate children of infoTable
            for child in info:
                child_tag = child.tag.split('}')[-1] if '}' in child.tag else child.tag
                
                if child_tag == 'nameOfIssuer':
                    name_of_issuer = child.text if child.text else "Unknown"
                elif child_tag == 'cusip':
                    cusip = child.text
                elif child_tag == 'value':
                    val = float(child.text) if child.text else 0.0
                elif child_tag == 'shrsOrPrnAmt':
                    # Handle nested shares
                    for sub in child:
                        sub_tag = sub.tag.split('}')[-1] if '}' in sub.tag else sub.tag
                        if sub_tag == 'sshPrnamt':
                            shares = int(sub.text) if sub.text else 0
                elif child_tag == 'sshPrnamt':
                    # Handle flat shares (rare but possible mapping difference)
                    shares = int(child.text) if child.text else 0

            if cusip:
                positions.append({
                    'cusip': cusip,
                    'name': name_of_issuer,
                    'value': val,
                    'shares': shares
                })
                total_value += val
        except Exception as e:
            print(f"Error parsing row: {e}")
            continue
            
    # Process positions
    start_date, end_date = get_quarter_dates(year, quarter)
    
    # Sort by value descending and keep top 30
    positions.sort(key=lambda x: x['value'], reverse=True)

    # Limit to top 30 positions
    positions = positions[:30]
    
    for pos in positions:
        ticker = get_ticker_from_cusip(pos['cusip'], pos['name'])
        if not ticker:
            print(f"Warning: No ticker found for CUSIP {pos['cusip']} ({pos['name']})")
            ticker = "UNKNOWN-" + pos['cusip'] # Fallback
            perf = None
        else:
            perf = get_performance(ticker, start_date, end_date)
            
        pct_portfolio = (pos['value'] / total_value * 100) if total_value > 0 else 0
        
        reported_price = (pos['value'] / pos['shares']) if pos['shares'] > 0 else 0.0
        
        # Insert into DB
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO positions 
            (year, quarter, fund_name, stock_ticker, shares_owned, portfolio_percentage, quarter_performance, reported_price)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (int(year), quarter, fund_name, ticker, pos['shares'], round(pct_portfolio, 4), perf, round(reported_price, 2)))
    
    conn.commit()

def main():
    conn = init_db()
    
    with open(FILINGS_FILE, 'r') as f:
        data = json.load(f)
        
    for fund_slug, years in data.items():
        fund_name = fund_slug.replace('-', ' ').title()
        for year, quarters in years.items():
            for q, url in quarters.items():
                process_filing(conn, fund_name, year, q, url)
                
    conn.close()
    print("Done!")

if __name__ == "__main__":
    main()
